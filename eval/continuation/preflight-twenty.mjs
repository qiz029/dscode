import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OfflineAdapter } from '../compaction/adapters.mjs';
import { createRuntime } from '../compaction/runtime.mjs';
import { validateContinuationDataset, replayMessages } from './fixture.mjs';
import { createWorkspace, runCheck, TOOL_SCHEMAS } from './workspace.mjs';

const dataset = validateContinuationDataset(JSON.parse(readFileSync(new URL('./fixtures/cases-20.json', import.meta.url))));
const policies = JSON.parse(readFileSync(new URL('../compaction/policies.json', import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'continuation-preflight-'));
try {
  for (const item of dataset.cases) {
    const workspace = createWorkspace(join(root, item.id), item);
    const visible = await runCheck(workspace.root, join(workspace.root, 'visible.mjs'), new AbortController().signal);
    const hidden = await runCheck(workspace.root, new URL(`./fixtures/checks/${item.id}.mjs`, import.meta.url).pathname, new AbortController().signal);
    if (visible.ok || hidden.ok) throw Error(`${item.id}: unfinished source unexpectedly passes a check`);
    const counts = [];
    for (const policy of policies) {
      const runtime = createRuntime({ policy, adapter: new OfflineAdapter(1000000), provider: 'eval-offline', model: 'scripted', contextWindow: 1000000, tools: TOOL_SCHEMAS });
      try {
        runtime.initialize(`${item.system}\nAvailable files: ${workspace.files().join(', ')}. Writable source files: ${item.writable.join(', ')}. Use only the provided tools.`);
        for (const message of replayMessages(item, 1000000)) await runtime.append(message, new AbortController().signal);
        const tokens = runtime.measure().totalTokens;
        if (tokens >= 996000) throw Error(`${item.id}/${policy.id}: no room for output`);
        counts.push(`${policy.id}:${tokens}/${runtime.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length}`);
      } finally { await runtime.close(); }
    }
    console.log(`${item.id} ${counts.join(' ')}`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
