import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../fixture.mjs';

// Synthetic pressure cases only. No workspace content or private session is read.
// The native meter prices text at four characters per token; the runner still
// records its measured occupancy and actual provider usage for every live call.
const output = new URL('./coding-million-v1.json', import.meta.url);
const scenarios = [
  ['auth-refresh', 270000, 'AUTH-724', 'src/auth/refresh.ts', 'reuse the existing refresh-token store', 'add the expired-token regression test', 'keep the public response schema unchanged', 'rotate the refresh token atomically', 'run the replay-attack test'],
  ['queue-ack', 285000, 'QUEUE-318', 'src/queue/ack.ts', 'acknowledge only after the durable write', 'add the redelivery test', 'do not drop the original message on timeout', 'record the offset before acknowledging', 'run the duplicate-delivery test'],
  ['search-index', 300000, 'INDEX-506', 'src/search/indexer.ts', 'build the replacement index in the background', 'add the stale-index test', 'keep the old index readable until cutover', 'switch reads only after checksum verification', 'run the cutover rollback test'],
  ['billing-ledger', 430000, 'BILL-209', 'src/billing/ledger.ts', 'write idempotency keys before posting charges', 'add the double-charge test', 'never read production tenant data', 'post the charge before publishing the receipt', 'run the refund reversal test'],
  ['cache-invalidation', 450000, 'CACHE-841', 'src/cache/invalidate.ts', 'invalidate entries after the database commit', 'add the stale-read test', 'preserve the cache key format', 'publish invalidations from the commit log', 'run the subscriber replay test'],
  ['cli-resume', 475000, 'CLI-667', 'src/cli/resume.ts', 'restore the session before drawing the prompt', 'add the missing-session test', 'do not print credential values', 'validate the session revision before restoring', 'run the interrupted-resume test'],
  ['migration-checkpoint', 825000, 'MIG-114', 'src/db/migrate.ts', 'checkpoint each completed batch', 'add the partial-batch test', 'do not delete the rollback table before signoff', 'checkpoint only after row-count verification', 'run the restart-from-checkpoint test'],
  ['upload-integrity', 840000, 'UP-452', 'src/upload/verify.ts', 'verify the digest before marking an upload complete', 'add the corrupt-chunk test', 'retain failed upload metadata for audit', 'verify the digest before committing the object', 'run the interrupted-upload test'],
  ['permission-sync', 855000, 'ACL-903', 'src/access/sync.ts', 'apply revocations before grants', 'add the stale-role test', 'do not widen default permissions', 'verify inherited roles before applying revocations', 'run the cross-team access test'],
  ['incident-recovery', 870000, 'INC-781', 'src/recovery/restore.ts', 'promote the healthy standby before restarting replicas', 'compare the WAL offsets', 'keep the snapshot until verification completes', 'verify replication lag before promoting the standby', 'run the rollback drill'],
];

const evidence = (message, quote) => [{ stage: 'checkpoint', message, quote }];
const exact = (id, category, question, answer, source, quote) => ({ id, category, question, accept: [answer], grading: { kind: 'exact' }, evidence: evidence(source, quote) });
const semantic = (id, category, question, answer, source, quote, forbidden) => ({
  id, category, question, accept: [answer], grading: { kind: 'semantic', required: [`The answer means: ${answer}.`], forbidden: [forbidden] }, evidence: evidence(source, quote),
});

const dataset = { version: 2, id: 'coding-million-pressure-v1', cases: scenarios.map(([id, target, issue, file, oldDecision, oldNext, constraint, decision, next]) => {
  const first = `Issue ${issue}. Modified file: ${file}. Initial decision: ${oldDecision}. Initial unfinished action: ${oldNext}. User constraint: ${constraint}.`;
  const update = `Latest correction: the initial decision (${oldDecision}) is superseded. Current decision: ${decision}. The initial action (${oldNext}) is complete. Latest unfinished action: ${next}. The user constraint remains in force.`;
  const filler = `Routine synthetic ${id} inspection note: generated checksums and formatting passed; no issue identifier, file, decision, action, or constraint changed in this note.\n`;
  const chunk = { role: 'assistant', text: filler, repeat: Math.ceil(40000 / filler.length) };
  const chunkTokens = Math.ceil(chunk.text.length * chunk.repeat / 4) + 8;
  const chunks = Math.ceil((target - Math.ceil((first.length + update.length) / 4)) / chunkTokens);
  const messages = [{ role: 'user', text: first }, ...Array.from({ length: chunks }, () => chunk), { role: 'user', text: update }];
  const last = messages.length - 1;
  return { id, system: 'You are a coding assistant. Follow the latest explicit correction, preserve exact identifiers, and distinguish pending from completed work. The routine inspection notes contain no state changes.', stages: [{ id: 'checkpoint', messages, probes: [
    exact('issue', 'recall', 'Return the exact issue identifier only.', issue, 0, `Issue ${issue}.`),
    exact('file', 'artifact', 'Return the exact modified file path only.', file, 0, `Modified file: ${file}.`),
    semantic('decision', 'decision', 'What is the current decision?', decision, last, `Current decision: ${decision}.`, `The superseded decision was: ${oldDecision}.`),
    semantic('next', 'continuation', 'What action is still unfinished?', next, last, `Latest unfinished action: ${next}.`, `The completed action was: ${oldNext}.`),
    semantic('constraint', 'constraint', 'What user constraint still applies?', constraint, 0, `User constraint: ${constraint}.`, `The opposite of the user constraint is allowed.`),
  ] }] };
}) };

validateDataset(dataset);
writeFileSync(output, JSON.stringify(dataset, null, 2) + '\n');
console.log(fileURLToPath(output));
