import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computerSkill, loadedComputerSkill } from '../plugins/computer-use/desktop-skill.mjs';
import { bundleDesktopComputerUse } from '../scripts/desktop-computer-use-bundle.mjs';

const loaded = events => loadedComputerSkill({ snapshotEvents: () => events });
const content = [{ type: 'text', text: computerSkill.content }];
const call = { type: 'tool/call', data: { name: 'skill', callId: 'load', arguments: JSON.stringify({ name: computerSkill.name }) } };
const result = { type: 'tool/result', data: { message: { toolCallId: 'load', isError: false, content } } };
test('Desktop Computer Use restores only a successful matching skill load from current native history', () => {
  assert(loaded([call, result])); assert(!loaded([result, call])); assert(!loaded([result]));
  const error = structuredClone(result); error.data.message.isError = true;
  assert(!loaded([call, error]));
  const unrelated = structuredClone(result); unrelated.data.message.toolCallId = 'different';
  assert(!loaded([call, unrelated]));
  const substitute = structuredClone(result); substitute.data.message.content[0].text = 'Unrelated same-name skill';
  assert(!loaded([call, substitute]));
  assert(!loaded([{ ...call, data: { ...call.data, arguments: 'not JSON' } }, result]));
  assert(!loaded([{ type: 'user/message', data: { source: { kind: 'human' }, content } }]));
  assert(loaded([{ type: 'user/message', data: { source: { kind: 'skill-invocation', name: computerSkill.name }, content } }]));
  for (const type of ['tool/ptc-dispatch', 'tool/code-dispatch']) {
    const event = { type, data: { name: 'skill', arguments: { name: computerSkill.name }, isError: false, content } };
    assert(loaded([event])); event.data.isError = true; assert(!loaded([event]));
  }
});

test('Desktop Computer Use packs a verified native helper and hands screenshots to the native image tool', t => {
  const destination = mkdtempSync(join(tmpdir(), 'dscode-cu-package-'));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  mkdirSync(join(destination, 'plugins/computer-use'), { recursive: true });
  const record = bundleDesktopComputerUse(destination);
  assert.equal(record.version, '0.3.3'); assert.equal(record.minimumMacOS, '14.0');
  assert.deepEqual(record.architectures, ['arm64', 'x86_64']);
  const tools = readFileSync(join(destination, 'vendor/computer-use/lib/tools.js'), 'utf8');
  assert.match(tools, /exact artifact path to read_image/); assert(!tools.includes('call the skill tool with {"name":"vision-tools"}'));
  assert.match(readFileSync(join(destination, 'plugins/computer-use/desktop-upstream.mjs'), 'utf8'), /vendor\/computer-use/);
  assert.match(readFileSync(join(destination, 'vendor/computer-use/LICENSE'), 'utf8'), /MIT/);
});

test('Desktop Computer Use rejects unreviewed versions and native helper tampering before packing', t => {
  const source = mkdtempSync(join(tmpdir(), 'dscode-cu-bad-source-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  assert.throws(() => bundleDesktopComputerUse(join(source, 'output'), source), /reviewed upstream version/);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '0.3.3' }));
  mkdirSync(join(source, 'native/macos/bin'), { recursive: true });
  writeFileSync(join(source, 'native/macos/manifest.json'), JSON.stringify({ binary: { path: 'bin/helper', sha256: 'wrong' } }));
  writeFileSync(join(source, 'native/macos/bin/helper'), 'tampered');
  assert.throws(() => bundleDesktopComputerUse(join(source, 'output'), source), /integrity mismatch/);
});
