// Scripted HTTP endpoints qualify the custom evaluation transport, never model quality.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CustomStore, validateProfile, PROTOCOLS } from '../plugins/custom/config.mjs';
import { parseOptions, runEvaluation } from '../eval/browser/runner.mjs';

const root = resolve(import.meta.dirname, '..');
const secret = 'synthetic-browser-eval-credential';
const keyEnv = 'DSCODE_EVAL_TRANSPORT_FIXTURE_KEY';
const previous = process.env[keyEnv];
const home = await mkdtemp(join(tmpdir(), 'browser-eval-custom-'));
const receipts = [];

function completion(api, index, name, args, text) {
  const id = `fixture-${index}`;
  if (api === 'chat-completions') return [{ choices: [{ delta: name ? { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } : { content: text }, finish_reason: name ? 'tool_calls' : 'stop' }] }, '[DONE]'];
  if (api === 'responses') return [{ type: 'response.completed', response: { status: 'completed', output: [name ? { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } }];
  return [{ type: 'content_block_start', index: 0, content_block: name ? { type: 'tool_use', id, name, input: args } : { type: 'text', text } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }];
}

try {
  process.env[keyEnv] = secret;
  for (const api of PROTOCOLS) {
    let requests = 0, pageId, checkbox, receipt, sawImage = false, failure;
    const uid = (text, label) => {
      const found = text.split('\n').find(row => row.includes(label))?.match(/uid=([^\s]+)/)?.[1];
      assert(found, `Expected visible ${label}`); return found;
    };
    const server = createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, `Bearer ${secret}`);
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const wire = body.input ?? body.messages;
        const parts = wire.flatMap(m => Array.isArray(m.content) ? m.content : []);
        const image = parts.find(p => ['image_url', 'input_image', 'image'].includes(p.type));
        if (image) {
          const data = image.source?.data ?? (image.image_url?.url ?? image.image_url).split(',')[1];
          assert(Buffer.from(data, 'base64').length > 100); sawImage = true;
        }
        const latest = api === 'chat-completions' ? wire.filter(m => m.role === 'tool').at(-1)?.content
          : api === 'responses' ? wire.filter(m => m.type === 'function_call_output').at(-1)?.output
            : parts.filter(p => p.type === 'tool_result').at(-1)?.content;
        let name, args = {}, text;
        requests++;
        switch (requests) {
          case 1: name = 'browser_start'; break;
          case 2: {
            const origin = JSON.stringify(body).match(/Use the browser at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
            assert(origin); name = 'mcp__browser__new_page'; args = { url: origin + '/', background: true }; break;
          }
          case 3:
            pageId = Number(latest.match(/^(\d+):.*\[selected\]/m)?.[1]); assert(Number.isSafeInteger(pageId));
            name = 'mcp__browser__take_snapshot'; args = { pageId }; break;
          case 4:
            checkbox = uid(latest, 'checkbox "Weekly digest"');
            name = 'mcp__browser__take_screenshot'; args = { pageId, format: 'png' }; break;
          case 5:
            assert(sawImage, 'screenshot must reach the configured image-capable API');
            name = 'mcp__browser__click'; args = { pageId, uid: checkbox }; break;
          case 6: name = 'mcp__browser__take_snapshot'; args = { pageId }; break;
          case 7: name = 'mcp__browser__click'; args = { pageId, uid: uid(latest, 'button "Save preference"') }; break;
          case 8: name = 'mcp__browser__handle_dialog'; args = { pageId, action: 'accept' }; break;
          case 9: name = 'mcp__browser__wait_for'; args = { pageId, text: ['Saved. Receipt'], timeout: 5000 }; break;
          case 10: name = 'mcp__browser__take_snapshot'; args = { pageId }; break;
          case 11:
            receipt = latest.match(/DS-[a-f0-9]+/)?.[0]; assert(receipt);
            name = 'browser_tabs'; args = { action: 'keep', pageId }; break;
          case 12: text = `${receipt} ${secret}`; break; // Deliberate credential echo tests report redaction.
          default: throw Error('Unexpected inference request');
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(completion(api, requests, name, args, text).map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''));
      } catch (error) { failure ??= error; res.writeHead(500); res.end('scripted fixture failed'); }
    });
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const store = new CustomStore(join(home, `${api}.yaml`));
      const profile = validateProfile({ id: 'custom-browser-eval-fixture', name: 'Scripted HTTP fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1`, api, auth: 'bearer', models: [{ id: 'scripted-http', contextWindow: 100000, inputModalities: ['text', 'image'] }] });
      await store.update((await store.read()).revision, () => [profile]);
      const out = join(home, api);
      const outcome = await runEvaluation(parseOptions(['--provider', profile.id, '--model', 'scripted-http', '--providers-file', store.path, '--key-env', keyEnv,
        '--cases', 'dialog', '--max-calls', '20', '--max-tools', '30', '--case-timeout-ms', '60000', '--call-timeout-ms', '10000', '--out', out]));
      if (failure) {
        console.error(JSON.stringify({ api, requests, rows: outcome.results.rows }));
        console.error((await readFile(join(out, 'traces.jsonl'), 'utf8')).split('\n').filter(line => line.includes('tool-call') || line.includes('"isError":true')).join('\n'));
        throw failure;
      }
      assert.equal(outcome.code, 0, JSON.stringify(outcome.results));
      assert.equal(outcome.results.backend, 'custom'); assert.equal(outcome.results.rows[0].oracle.submissions, 1);
      assert.equal(outcome.results.rows[0].oracle.receiptRead, true); assert.equal(outcome.results.rows[0].oracle.retained, true);
      assert.equal(outcome.results.rows[0].modelCalls, 12); assert.equal(requests, 12); assert(sawImage);
      assert.equal(outcome.manifest.route.api, api);
      for (const filename of ['manifest.json', 'results.json', 'traces.jsonl', 'report.md']) assert(!(await readFile(join(out, filename), 'utf8')).includes(secret), `${filename} leaked the synthetic credential`);
      assert.match(outcome.results.rows[0].finalText, /\[redacted\]/);
      receipts.push({ api, passed: true, modelCalls: requests, screenshotReachedEndpoint: sawImage, singleSubmission: true, receiptRead: true, resultTabRetained: true, credentialRedacted: true });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  const path = join(root, 'artifacts/local/browser-eval-custom.json');
  await mkdir(join(root, 'artifacts/local'), { recursive: true });
  await writeFile(path, JSON.stringify({ at: new Date().toISOString(), scriptedTransportFixture: true, liveModelInference: false, qualityScore: null, protocols: receipts }, null, 2) + '\n');
  console.log('BROWSER_EVAL_CUSTOM_PASSED: native agent and real Chrome through all three custom HTTP protocols; screenshots, single submission, receipt, tab retention and credential redaction. Scripted transport only; no model quality score.');
} finally {
  if (previous === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = previous;
  await rm(home, { recursive: true, force: true });
}
