/* global chrome, document */
const element = id => document.getElementById(id);
let operation = 0;
async function run(action, background = false) {
  const current = ++operation;
  let pending = false;
  if (!background) {
    for (const id of ['pair', 'share']) element(id).disabled = true;
    element('stop').disabled = action === 'stop';
  }
  if (action === 'pair') element('stop').hidden = false;
  try {
    const request = { action };
    if (action === 'pair') request.url = element('pairing').value.trim();
    if (action === 'pair' || action === 'share') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (current !== operation) return;
      request.tabId = tab?.id;
    }
    const result = await chrome.runtime.sendMessage(request);
    if (current !== operation) return;
    if (result.error) throw Error(result.error);
    pending = !!result.pending;
    element('status').textContent = result.message;
    element('pair').hidden = result.connected;
    element('pairing').hidden = result.connected;
    element('share').hidden = !result.connected;
    element('stop').hidden = !result.connected && !pending;
    if (result.connected) element('pairing').value = '';
    element('tabs').replaceChildren(...result.shared.map(tab => {
      const item = document.createElement('li'); item.textContent = tab.title || tab.url; return item;
    }));
    if (pending || result.connected) setTimeout(() => { if (current === operation) return run('status', true); }, pending ? 250 : 1000);
  } catch (error) {
    if (current !== operation) return;
    element('status').textContent = error.message;
    if (action === 'pair') element('stop').hidden = true;
  }
  finally {
    if (current === operation) {
      for (const id of ['pair', 'share']) element(id).disabled = pending;
      element('stop').disabled = false;
    }
  }
}
for (const action of ['pair', 'share', 'stop']) element(action).addEventListener('click', () => run(action));
await run('status');
