import { join } from 'node:path';
import { createEmailInbox } from './inbox.mjs';
import { emailStore } from './store.mjs';

export const emailAddress = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value);
const aliasKey = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw Error('Alias must be 1..64 letters, digits, underscores or hyphens.');
  return value.toLowerCase();
};
export function createEmailContacts({ directory = createEmailInbox().directory } = {}) {
  const store = emailStore(join(directory, 'contacts'));
  const list = () => store.read('aliases.json') ?? {};
  return {
    list,
    resolve(value) {
      if (emailAddress(value)) return { to: value };
      const alias = aliasKey(value), entries = list();
      const to = Object.hasOwn(entries, alias) ? entries[alias] : null;
      if (!emailAddress(to)) throw Error('Unknown email alias: ' + alias + '. Add it with dscode email alias set NAME ADDRESS.');
      return { alias, to };
    },
    async set(name, address) {
      const alias = aliasKey(name);
      if (!emailAddress(address)) throw Error('Specify one plain email address.');
      return store.locked(async () => {
        const entries = list();
        Object.defineProperty(entries, alias, { value: address, enumerable: true, configurable: true, writable: true });
        store.write('aliases.json', entries); return { alias, to: address };
      });
    },
    async remove(name) {
      const alias = aliasKey(name);
      return store.locked(async () => { const entries = list(); delete entries[alias]; store.write('aliases.json', entries); return { removed: alias }; });
    },
  };
}
