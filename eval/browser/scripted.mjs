import { LlmAdapter } from '@deepseek-ai/dsh-llm';

const text = result => result?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
const pages = result => result?.value?.structuredContent?.pages ?? [];
function uid(result, label) {
  const row = text(result).split('\n').find(line => line.includes(label));
  const value = row?.match(/uid=([^\s]+)/)?.[1];
  if (!value) throw Error(`Scripted fixture could not find ${label}`);
  return value;
}

function* steps(id, origin) {
  yield ['browser_start', {}];
  const created = yield ['mcp__browser__new_page', { url: origin + '/', background: true }];
  const pageId = pages(created).find(p => p.selected)?.id;
  let snapshot = yield ['mcp__browser__take_snapshot', { pageId }];
  if (id === 'reservation') {
    yield ['mcp__browser__click', { pageId, uid: uid(snapshot, 'Atlas notebook — blue') }];
    snapshot = yield ['mcp__browser__take_snapshot', { pageId }];
    yield ['mcp__browser__fill', { pageId, uid: uid(snapshot, 'spinbutton "Quantity"'), value: '2' }];
    snapshot = yield ['mcp__browser__take_snapshot', { pageId }];
    yield ['mcp__browser__fill', { pageId, uid: uid(snapshot, 'textbox "Full name"'), value: 'Morgan Lee' }];
    snapshot = yield ['mcp__browser__take_snapshot', { pageId }];
    yield ['mcp__browser__click', { pageId, uid: uid(snapshot, 'button "Confirm reservation"') }];
  } else if (id === 'reference') {
    const before = yield ['mcp__browser__list_pages', {}];
    yield ['mcp__browser__click', { pageId, uid: uid(snapshot, 'link "Open reference tab"') }];
    const awaited = yield ['browser_tabs', { action: 'wait', urlContains: origin + '/reference', excludePageIds: pages(before).map(p => p.id) }];
    const referenceId = awaited.value?.page?.id;
    if (!Number.isSafeInteger(referenceId)) throw Error('Expected reference tab did not appear.');
    yield ['mcp__browser__wait_for', { pageId: referenceId, text: ['Current code:'], timeout: 5000 }];
    const reference = yield ['mcp__browser__take_snapshot', { pageId: referenceId }];
    const code = text(reference).match(/Current code: (REF-[a-f0-9]+)/)?.[1];
    snapshot = yield ['mcp__browser__take_snapshot', { pageId }];
    yield ['mcp__browser__fill', { pageId, uid: uid(snapshot, 'textbox "Current code"'), value: code }];
    snapshot = yield ['mcp__browser__take_snapshot', { pageId }];
    yield ['mcp__browser__click', { pageId, uid: uid(snapshot, 'button "Submit code"') }];
  } else {
    yield ['mcp__browser__click', { pageId, uid: uid(snapshot, 'checkbox "Weekly digest"') }];
    snapshot = yield ['mcp__browser__take_snapshot', { pageId }];
    yield ['mcp__browser__click', { pageId, uid: uid(snapshot, 'button "Save preference"') }];
    yield ['mcp__browser__handle_dialog', { pageId, action: 'accept' }];
  }
  yield ['mcp__browser__wait_for', { pageId, text: ['Saved. Receipt'], timeout: 5000 }];
  snapshot = yield ['mcp__browser__take_snapshot', { pageId }];
  yield ['browser_tabs', { action: 'keep', pageId }];
  return text(snapshot).match(/DS-[a-f0-9]+/)?.[0] ?? 'Receipt unavailable';
}

/** Exercises the native pipeline; it is deliberately NOT a model quality score. */
export class ScriptedAdapter extends LlmAdapter {
  constructor(id, origin, latest) { super(); this.steps = steps(id, origin); this.latest = latest; this.calls = 0; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 100000 } }; }
  async *stream(options) {
    if (options.purpose) throw Error('Unexpected auxiliary model call in browser fixture');
    const step = this.steps.next(this.latest());
    const block = step.done ? { type: 'text', text: step.value }
      : { type: 'tool-call', id: `fixture-${++this.calls}`, name: step.value[0], arguments: JSON.stringify(step.value[1]) };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: step.done ? 'stop' : 'tool-calls' } };
  }
}
