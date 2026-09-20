import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import { visibleColumns } from '../../packages/tui/src/render/markdown.ts';

// Mount a vendored-terminal component into an in-memory TTY, so `the source draws
// this frame` is assertable without a real terminal: Ink writes one frame per update
// in debug mode, so the last text-bearing frame is the current picture.
export const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

export async function mount(Component, props, { columns = 80, rows = 30 } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  Object.assign(stdout, { columns, rows, isTTY: true });
  const frames = [];
  const errors = [];
  stdout.on('data', data => frames.push(data.toString()));
  stderr.on('data', data => errors.push(data.toString()));
  const mounted = render(createElement(Component, props), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
  await tick();
  /** Ink writes one frame per update in debug mode; the last frame carrying text is the current picture. */
  const frame = () => {
    for (let index = frames.length - 1; index >= 0; index--) {
      const text = stripVTControlCharacters(frames[index]);
      if (text.trim() !== '') return text;
    }
    return '';
  };
  return {
    frame,
    frames,
    errors,
    columns,
    async write(value) {
      stdin.write(value);
      await tick(45);
    },
    close() {
      mounted.unmount();
      mounted.cleanup();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

/** Every rendered row must fit the terminal width. */
export function assertFits(ui) {
  assert.equal(ui.errors.length, 0, ui.errors.join(''));
  const text = ui.frame();
  assert.notEqual(text.trim(), '', 'the component rendered nothing');
  // Every frame Ink wrote must fit the terminal width, not only the current picture.
  for (const frame of ui.frames ?? []) {
    for (const line of stripVTControlCharacters(frame).split('\n')) {
      assert(visibleColumns(line) <= ui.columns, `overflow at ${ui.columns} columns: ${line}`);
    }
  }
}

