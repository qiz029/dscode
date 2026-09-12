import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../fixture.mjs';

// Fully synthetic coding-session transcripts. No local session, source file,
// credential or private user content is read by this generator.
const base = new URL('./coding-v2.json', import.meta.url);
const output = new URL('./coding-broad-v1.json', import.meta.url);
const dataset = JSON.parse(readFileSync(base, 'utf8'));
dataset.id = 'coding-recall-broad-v1';

const reference = (stage, message, quote) => [{ stage, message, quote }];
const exact = (id, category, question, answer, evidence) => ({ id, category, question, accept: [answer], grading: { kind: 'exact' }, evidence });
const semantic = (id, category, question, answer, required, forbidden, evidence) => ({ id, category, question, accept: [answer], grading: { kind: 'semantic', required, forbidden }, evidence });

const incidentFirst = 'Incident INC-4281. Recovery decision: promote the healthy standby before restarting read replicas. The next unfinished action is to compare WAL offsets. Keep the production snapshot until verification is complete. The exact rollback manifest filename appears only in the restore inventory tool output.';
const incidentThird = 'Update: WAL offsets have been compared and that task is complete. The next unfinished action is to run the rollback drill.';
const incidentFifth = 'Update: the rollback drill is complete. The next unfinished action is to write the incident handoff note. The old snapshot rule is replaced: keep the production snapshot until the handoff is signed off; deletion is allowed after signoff, never before.';
const inventoryLine = 'Restore inventory entry: filename rollback-manifest-4827.json.';
const scan = label => Array.from({ length: 100 }, (_, i) => `[${label} ${String(i).padStart(3, '0')}] Archive segment checksum verified; no policy decision or action update in this line.\n`).join('');
const inventory = scan('pre') + inventoryLine + '\n' + scan('post');
const incidentChatter = { role: 'assistant', text: 'Inspected another archival segment; checksum and line count are routine. No recovery decision or verification result changed.\n', repeat: 38 };
const incidentStages = [
  { id: 'checkpoint-1', messages: [{ role: 'user', text: incidentFirst }, incidentChatter, { role: 'tool', name: 'restore_inventory', text: inventory }] },
  { id: 'checkpoint-2', messages: [incidentChatter, { role: 'tool', name: 'status', text: 'Archival scan complete; no new decision.' }] },
  { id: 'checkpoint-3', messages: [{ role: 'user', text: incidentThird }, incidentChatter] },
  { id: 'checkpoint-4', messages: [incidentChatter, { role: 'tool', name: 'status', text: 'Inspection only; no state update.' }] },
  { id: 'checkpoint-5', messages: [{ role: 'user', text: incidentFifth }, incidentChatter] },
];
for (let i = 0; i < incidentStages.length; i++) {
  const index = i + 1, current = index >= 5 ? 5 : index >= 3 ? 3 : 1;
  incidentStages[i].probes = [
    exact('incident', 'recall', 'What is the exact incident ID? Return only the ID.', 'INC-4281', reference('checkpoint-1', 0, 'Incident INC-4281.')),
    exact('manifest', 'artifact', 'What is the exact rollback manifest filename in the restore inventory? Return only the filename.', 'rollback-manifest-4827.json', reference('checkpoint-1', 2, inventoryLine)),
    semantic('decision', 'decision', 'Which recovery order was chosen?', 'promote the healthy standby before restarting read replicas', ['Promote the healthy standby first, then restart read replicas.'], ['Restart read replicas before promoting the standby.'], reference('checkpoint-1', 0, 'Recovery decision: promote the healthy standby before restarting read replicas.')),
    semantic('next', 'continuation', 'What is the latest unfinished action? Give its target.', current === 1 ? 'compare WAL offsets' : current === 3 ? 'run the rollback drill' : 'write the incident handoff note', [current === 1 ? 'Compare WAL offsets is still pending.' : current === 3 ? 'Run the rollback drill is still pending.' : 'Write the incident handoff note is still pending.'], ['Claim it is complete or substitute an earlier task.'], current === 1 ? reference('checkpoint-1', 0, 'The next unfinished action is to compare WAL offsets.') : current === 3 ? reference('checkpoint-3', 0, 'The next unfinished action is to run the rollback drill.') : reference('checkpoint-5', 0, 'The next unfinished action is to write the incident handoff note.')),
    semantic('constraint', 'constraint', index < 5 ? 'When may the production snapshot be discarded?' : 'What is the latest snapshot retention rule, including when deletion becomes allowed?', index < 5 ? 'retain the production snapshot until verification is complete' : 'retain the production snapshot until handoff signoff; deletion is allowed after signoff', index < 5 ? ['Keep the production snapshot until verification is complete.'] : ['Keep the production snapshot until handoff signoff.', 'Deletion is allowed after signoff.'], index < 5 ? ['Delete the snapshot before verification completes.'] : ['Delete before handoff signoff.', 'The old until-verification rule remains the latest restriction.'], index < 5 ? reference('checkpoint-1', 0, 'Keep the production snapshot until verification is complete.') : reference('checkpoint-5', 0, 'The old snapshot rule is replaced: keep the production snapshot until the handoff is signed off; deletion is allowed after signoff, never before.')),
  ];
}
dataset.cases.push({ id: 'incident-tool-pruning', system: 'You are a coding assistant. Follow the latest explicit corrections and distinguish pending work from completed work.', stages: incidentStages });

const chineseFirst = '原始错误码是 QTA-017。改动文件是 src/billing/quota.ts。当前决定是将配额缓存 TTL 设为 30 秒，不能设为 5 分钟。下一步尚未完成：补并发扣减测试。用户限制：不得读取生产租户数据。';
const chineseThird = '进度更新：并发扣减测试已经完成。下一步尚未完成：运行余额回滚测试。其他决定和限制仍然有效。';
const chineseFifth = '最新纠正：原先 30 秒 TTL 的决定作废，改为 45 秒；5 分钟仍不采用。余额回滚测试已完成。下一步尚未完成：整理回滚测试报告。生产租户数据限制仍然有效。';
const chineseChatter = { role: 'assistant', text: 'Routine generated-file and test-log review; no change to quota decisions, user constraints, or pending tasks. This line records formatting only.\n', repeat: 70 };
const chineseStages = [
  { id: 'checkpoint-1', messages: [{ role: 'user', text: chineseFirst }, chineseChatter, { role: 'tool', name: 'read_file', text: '无关生成文件检查完成；没有新的业务信息。' }] },
  { id: 'checkpoint-2', messages: [chineseChatter, { role: 'tool', name: 'read_file', text: '日志检查完成；没有新的业务信息。' }] },
  { id: 'checkpoint-3', messages: [{ role: 'user', text: chineseThird }, chineseChatter] },
  { id: 'checkpoint-4', messages: [chineseChatter, { role: 'tool', name: 'read_file', text: '配置文件格式正确；没有修改。' }] },
  { id: 'checkpoint-5', messages: [{ role: 'user', text: chineseFifth }, chineseChatter] },
];
for (let i = 0; i < chineseStages.length; i++) {
  const index = i + 1, current = index >= 5 ? 5 : index >= 3 ? 3 : 1;
  chineseStages[i].probes = [
    exact('error', 'recall', '原始错误码是什么？只返回准确值。', 'QTA-017', reference('checkpoint-1', 0, '原始错误码是 QTA-017。')),
    exact('file', 'artifact', '改动的是哪个文件？只返回准确路径。', 'src/billing/quota.ts', reference('checkpoint-1', 0, '改动文件是 src/billing/quota.ts。')),
    semantic('decision', 'decision', '最新的配额缓存 TTL 决定是多少？', current === 5 ? '45 秒' : '30 秒', [current === 5 ? '当前 TTL 是 45 秒。' : '当前 TTL 是 30 秒。'], [current === 5 ? '仍使用已撤销的 30 秒或 5 分钟。' : '当前 TTL 是 5 分钟。'], current === 5 ? reference('checkpoint-5', 0, '原先 30 秒 TTL 的决定作废，改为 45 秒；5 分钟仍不采用。') : reference('checkpoint-1', 0, '当前决定是将配额缓存 TTL 设为 30 秒，不能设为 5 分钟。')),
    semantic('next', 'continuation', '最新尚未完成的任务是什么？', current === 1 ? '补并发扣减测试' : current === 3 ? '运行余额回滚测试' : '整理回滚测试报告', [current === 1 ? '补并发扣减测试仍待完成。' : current === 3 ? '运行余额回滚测试仍待完成。' : '整理回滚测试报告仍待完成。'], ['把任务说成已经完成，或返回已被替代的旧任务。'], current === 1 ? reference('checkpoint-1', 0, '下一步尚未完成：补并发扣减测试。') : current === 3 ? reference('checkpoint-3', 0, '下一步尚未完成：运行余额回滚测试。') : reference('checkpoint-5', 0, '下一步尚未完成：整理回滚测试报告。')),
    semantic('constraint', 'constraint', '生产租户数据有什么限制？', '不得读取生产租户数据', ['不得读取生产租户数据。'], ['允许读取生产租户数据。'], reference('checkpoint-1', 0, '用户限制：不得读取生产租户数据。')),
  ];
}
dataset.cases.push({ id: 'chinese-quota-corrections', system: '你是编码助手。遵守用户的最新纠正，区分已完成的工作和当前待办。', stages: chineseStages });

validateDataset(dataset);
writeFileSync(output, JSON.stringify(dataset, null, 2) + '\n');
console.log(fileURLToPath(output));
