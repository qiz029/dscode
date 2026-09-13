import { emailStore } from './store.mjs';
export const gmailStore = directory => emailStore(directory, 'Gmail');
