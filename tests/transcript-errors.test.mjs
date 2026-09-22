import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptView, projectEvent, projectEvents } from '../packages/tui/src/render/projection.ts';

test('content filtering settles the turn and gives the same recovery guidance live and on resume', () => {
  for (const code of ['CONTENT_POLICY', 'CONTENT_FILTER']) {
    const events = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1001, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 2, time: 1300, data: { turn: 1, reason: { kind: 'error', error: { code, message: 'Request blocked by content filter', status: 403 } } } },
    ];
    const live = events.reduce(projectEvent, createTranscriptView());
    const replay = projectEvents(events);
    for (const view of [live, replay]) {
      assert.equal(view.busy, false, 'a rejected request is not left running');
      assert.equal(view.streaming, '');
      const errors = view.entries.filter(entry => entry.kind === 'error');
      assert.equal(errors.length, 1);
      assert.match(errors[0].text, /turn stopped by provider content filtering/);
      assert.match(errors[0].text, /review the request and context before continuing/);
      assert(!errors[0].text.includes('API key'));
    }
    assert.deepEqual(live.entries, replay.entries);
  }
});

test('credential recovery is preserved and unrelated failures do not suggest content filtering', () => {
  for (const code of ['MISSING_CREDENTIAL', 'AUTH', 'SERVER']) {
    const view = projectEvents([{ type: 'turn/end', seq: 0, time: 1000, data: { turn: 1, reason: { kind: 'error', error: { code, message: 'failure' } } } }]);
    const text = view.entries.find(entry => entry.kind === 'error').text;
    assert.equal(text.includes('open /model to add an API key'), code === 'MISSING_CREDENTIAL');
    assert(!text.includes('content filtering'));
  }
});
