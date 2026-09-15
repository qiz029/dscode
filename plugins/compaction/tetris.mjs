// The compaction indicator: a small scripted Tetris bot. It lines each piece up
// over its slot, drops it and clears the full rows, the way compaction clears
// older history. The script tiles the well, so every run ends empty and loops.
// Cells: '.' empty, '@' falling piece, '#' settled, '=' a row being cleared.
export const TETRIS_WIDTH = 8;
export const TETRIS_HEIGHT = 4;
export const TETRIS_TICK_MS = 160;

const EMPTY_ROW = '.'.repeat(TETRIS_WIDTH);
// [row, column] cells inside each piece's box, row 0 on top.
const O = [[0, 0], [0, 1], [1, 0], [1, 1]];
const I = [[0, 0], [0, 1], [0, 2], [0, 3]];
const J = [[0, 0], [1, 0], [1, 1], [1, 2]];
const HOOK = [[0, 0], [0, 1], [0, 2], [1, 2]];
// Two rows cleared at once, then a single row whose leftovers fall and clear next.
const SCRIPT = [
  { cells: O, x: 0 }, { cells: J, x: 2 }, { cells: HOOK, x: 3 }, { cells: O, x: 6 },
  { cells: I, x: 0 }, { cells: O, x: 4 }, { cells: O, x: 6 }, { cells: I, x: 0 },
];

function fits(board, cells, x, y) {
  return cells.every(([row, column]) => y + row < TETRIS_HEIGHT && x + column >= 0 && x + column < TETRIS_WIDTH && board[y + row][x + column] === '.');
}

function paint(board, cells, x, y, mark) {
  const rows = board.map(row => [...row]);
  for (const [row, column] of cells) rows[y + row][x + column] = mark;
  return rows.map(row => row.join(''));
}

/** Every frame of one loop, simulated from the script; throws when the script stops tiling the well. */
export function tetrisFrames() {
  let board = Array.from({ length: TETRIS_HEIGHT }, () => EMPTY_ROW);
  const frames = [];
  for (const { cells, x: target } of SCRIPT) {
    const width = Math.max(...cells.map(([, column]) => column)) + 1;
    let x = Math.floor((TETRIS_WIDTH - width) / 2), y = 0;
    if (!fits(board, cells, x, y)) throw Error('Tetris script spawns into the stack');
    frames.push(paint(board, cells, x, y, '@'));
    while (x !== target) {
      x += Math.sign(target - x);
      if (!fits(board, cells, x, y)) throw Error('Tetris script steers into the stack');
      frames.push(paint(board, cells, x, y, '@'));
    }
    while (fits(board, cells, x, y + 1)) frames.push(paint(board, cells, x, ++y, '@'));
    board = paint(board, cells, x, y, '#');
    const kept = board.filter(row => row.includes('.'));
    if (kept.length < TETRIS_HEIGHT) {
      const flash = board.map(row => row.includes('.') ? row : '='.repeat(TETRIS_WIDTH));
      frames.push(flash, flash);
      board = [...Array.from({ length: TETRIS_HEIGHT - kept.length }, () => EMPTY_ROW), ...kept];
    }
    frames.push(board);
  }
  if (board.some(row => row !== EMPTY_ROW)) throw Error('Tetris script does not clear the well');
  return frames;
}

const FRAMES = tetrisFrames();

/** The board rows for an animation tick; the loop wraps. */
export function tetrisFrame(tick) {
  const index = Math.floor(tick) % FRAMES.length;
  return FRAMES[index < 0 ? index + FRAMES.length : index];
}
