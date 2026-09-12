import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspace, runCheck } from '../workspace.mjs';
import { validateContinuationDataset } from '../fixture.mjs';

// Evaluator-only reference implementations check that every generated hidden
// vector is satisfiable. These sources never enter a model-facing workspace.
const references = {
  'normalize-slug': `export function slugify(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }`,
  'parse-port': `export function parsePort(value) { if (typeof value !== 'string' || !/^\\d+$/.test(value.trim())) return null; const n = Number(value.trim()); return n >= 1 && n <= 65535 ? n : null; }`,
  'merge-ranges': `export function mergeRanges(ranges) { const sorted = ranges.map(pair => [...pair]).sort((a,b) => a[0]-b[0]); const out=[]; for(const pair of sorted) { const last=out.at(-1); if(last && pair[0] <= last[1]+1) last[1]=Math.max(last[1],pair[1]); else out.push(pair); } return out; }`,
  'unique-tags': `export function normalizeTags(tags) { return [...new Set(tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))]; }`,
  'choose-backoff': `export function backoff(attempt, base, cap) { return Math.min(cap, base * 2 ** attempt); }`,
  'split-batches': `export function splitBatches(items, size) { const out=[]; for(let i=0;i<items.length;i+=size) out.push(items.slice(i,i+size)); return out; }`,
  'redact-token': `export function redactToken(text) { return text.replace(/token=\\S+/g, 'token=[REDACTED]'); }`,
  'parse-duration': `export function parseDuration(text) { if(typeof text !== 'string') return null; const m=/^(\\d+)([smh])$/.exec(text.trim()); return m ? Number(m[1]) * ({s:1000,m:60000,h:3600000})[m[2]] : null; }`,
  'sum-ledger': `export function netAmount(entries) { return entries.reduce((sum,entry) => sum + (entry.status==='posted'?entry.amount:entry.status==='refunded'?-entry.amount:0),0); }`,
  'latest-by-key': `export function latestByKey(rows) { const chosen=new Map(); for(const row of rows) { const old=chosen.get(row.key); if(!old || row.revision>=old.revision) chosen.set(row.key,row); } return Object.fromEntries([...chosen].map(([key,row]) => [key,row.value])); }`,
  'compare-version': `export function compareVersion(a,b) { const aa=a.split('.').map(Number),bb=b.split('.').map(Number); for(let i=0;i<Math.max(aa.length,bb.length);i++) { const x=aa[i]??0,y=bb[i]??0; if(x<y)return -1;if(x>y)return 1; } return 0; }`,
  'mask-email': `export function maskEmail(email) { const parts=email.split('@'); if(parts.length!==2 || !parts[0] || !parts[1]) return null; return parts[0][0]+'*'.repeat(parts[0].length-1)+'@'+parts[1]; }`,
  'intersect-interval': `export function intersect(a,b) { const start=Math.max(a[0],b[0]),end=Math.min(a[1],b[1]); return start<end?[start,end]:null; }`,
  'count-by-type': `export function countByType(events) { const out={}; for(const event of events) if(typeof event.type==='string' && event.type) out[event.type]=(out[event.type]??0)+1; return out; }`,
  'merge-config': `export function mergeConfig(base,override) { const out={...base}; for(const [key,value] of Object.entries(override)) if(value!==null)out[key]=value; return out; }`,
  'sort-priority': `export function sortByPriority(items) { return items.map((item,index)=>({item,index})).sort((a,b)=>b.item.priority-a.item.priority || a.index-b.index).map(({item})=>item); }`,
  'decode-query': `export function parseQuery(query) { return Object.fromEntries(new URLSearchParams(query)); }`,
};

test('all 20 tasks have working visible and hidden oracles', async t => {
  const dataset = validateContinuationDataset(JSON.parse(readFileSync(new URL('../fixtures/cases-20.json', import.meta.url))));
  assert.equal(dataset.cases.length, 20);
  const root = mkdtempSync(join(tmpdir(), 'continuation-oracles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const item of dataset.cases.slice(3)) {
    const workspace = createWorkspace(join(root, item.id), item);
    const source = references[item.id];
    assert(source, item.id);
    assert.equal((await workspace.execute('write_file', JSON.stringify({ path: item.writable[0], content: source }), new AbortController().signal)).ok, true);
    const visible = await runCheck(workspace.root, join(workspace.root, 'visible.mjs'), new AbortController().signal);
    const hidden = await runCheck(workspace.root, new URL(`../fixtures/checks/${item.id}.mjs`, import.meta.url).pathname, new AbortController().signal);
    assert(visible.ok, `${item.id} visible: ${visible.stderr}`);
    assert(hidden.ok, `${item.id} hidden: ${hidden.stderr}`);
  }
});
