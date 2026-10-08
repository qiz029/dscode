import { readFileSync } from 'node:fs';

export const computerSkill = Object.freeze({
  name: 'dscode-computer-use', source: 'runtime',
  description: 'Operate local macOS apps through Accessibility and screenshots, with fresh observations and application permissions.',
  content: readFileSync(new URL('./DESKTOP-SKILL.md', import.meta.url), 'utf8'),
});

const carriesSkill = blocks => Array.isArray(blocks) && blocks.some(block => block.type === 'text' && block.text?.includes(computerSkill.content));
const skillArgs = value => {
  try { return (typeof value === 'string' ? JSON.parse(value) : value)?.name === computerSkill.name; } catch { return false; }
};

// Match a successful load of this exact skill body, never a same-name substitute.
export function loadedComputerSkill(session) {
  const calls = new Set();
  for (const event of session.snapshotEvents()) {
    const data = event.data;
    if (event.type === 'user/message' && data.source?.kind === 'skill-invocation' && data.source.name === computerSkill.name && carriesSkill(data.content)) return true;
    if (event.type === 'tool/call' && data.name === 'skill' && skillArgs(data.arguments)) calls.add(data.callId);
    if (event.type === 'tool/result') {
      const message = data.message;
      if (message?.isError === false && calls.has(message.toolCallId) && carriesSkill(message.content)) return true;
    }
    if (['tool/ptc-dispatch', 'tool/code-dispatch'].includes(event.type) && data.name === 'skill' && data.isError === false && skillArgs(data.arguments) && carriesSkill(data.content)) return true;
  }
  return false;
}
