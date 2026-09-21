import test from 'node:test';
import assert from 'node:assert/strict';
// Relative import on purpose: ink does not export this build file, and the ledger under test
// is the patched one (patchInkFrame, applied by harness provision).
import logUpdate from '../node_modules/ink/build/log-update.js';

/**
 * The composer sits at the bottom of Ink's dynamic frame, so "the composer never rides up"
 * means "the emitted block never loses height". One write advances the cursor by its padding
 * plus its own newlines, which is the number the ledger keeps monotonic.
 */
test('the frame ledger keeps the composer from riding up across a static flush', () => {
  const writes = [];
  const log = logUpdate.create({ write: chunk => { writes.push(chunk); } }, { showCursor: true });
  const advance = () => writes.at(-1).split('\n').length - 1;
  let staticRows = 0;
  let row = 0;
  const step = (output, flush = 0) => {
    if (flush > 0) {
      log.clear();
      staticRows += flush;
      log(output, flush); // ink.js reports the rows the static write consumed
    } else log(output);
    const next = staticRows + advance();
    assert(next >= row, 'the composer rode up: ' + row + ' -> ' + next);
    row = next;
    return advance();
  };
  // Six rows, then a flush that writes one row while the frame shrinks to one: without the
  // reserved rows the block would fall from six to two and the composer would ride up.
  assert.equal(step('l1\nl2\nl3\nl4\nl5\nl6'), 6, 'six rows fill a six-row block');
  // Only the rows a flush did NOT consume stay reserved: the row it wrote is consumed by
  // the flush itself, so the block is one row shorter instead of parking the freed live
  // region as a band of blank rows for the next stream to refill.
  assert.equal(step('s1', 1), 5, 'the flushed row is consumed, not reserved a second time');
  // Streaming again inside the same flush keeps the floor.
  step('t1\nt2');
  // An ordinary shrink without a flush is still padded by the ledger.
  step('u1');
  // A taller frame grows the block, and the next flush keeps that height too.
  step('v1\nv2\nv3\nv4\nv5\nv6\nv7\nv8');
  step('w1', 2);
  // A flush that carries as many rows as the frame gave up leaves no band at all.
  assert.equal(step('y1', 5), 1, 'a covered shrink leaves no blank band above the frame');
});
