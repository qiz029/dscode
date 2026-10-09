import { BrowserAccess } from '../../plugins/browser/access.mjs';
const [home, action, origin, pause] = process.argv.slice(2);
const access = new BrowserAccess(home), read = access.read.bind(access);
let first = true;
access.read = async () => {
  const policy = await read();
  if (first) {
    first = false;
    const released = pause ? new Promise(resolve => process.once('message', resolve)) : undefined;
    process.send({ phase: 'read' });
    await released;
  }
  return policy;
};
process.send({ phase: 'started' });
try {
  if (action === 'block-forget') await access.update('block', origin);
  process.send({ phase: 'done', permissions: await access.update(action === 'block-forget' ? 'forget' : action, origin) });
}
catch (error) { process.send({ phase: 'error', message: error.message }); process.exitCode = 1; }
process.disconnect();
