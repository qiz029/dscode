// One shared store; prompt and retrieval are mounted only in DSCODE agents.
export const inject = ['llm', 'sessions', 'sessionPersistence', 'commands', 'agents', 'agentPresets'];
export { applyDesktop as apply } from './index.mjs';
