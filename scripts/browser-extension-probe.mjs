/* global document */
// Disposable test-browser sidecar for native Desktop qualification. This never
// connects to or installs an extension into a user's existing browser profile.
import { join } from 'node:path';
import { puppeteer } from '../node_modules/chrome-devtools-mcp/build/src/third_party/index.js';
import { extensionId } from '../plugins/browser/extension-relay.mjs';

export async function startExtensionProbe({ executablePath, extensionPath, home, url, pairingUrl }) {
  const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: join(home, 'extension-chrome'),
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    args: [`--load-extension=${extensionPath}`, `--disable-extensions-except=${extensionPath}`],
    ignoreDefaultArgs: ['--disable-extensions'], protocolTimeout: 15000 });
  try {
    const shared = await browser.newPage(); await shared.goto(url);
    const hidden = await browser.newPage(); await hidden.goto(url + '/not-shared');
    const popup = await browser.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.type('#pairing', pairingUrl);
    await shared.bringToFront();
    await popup.evaluate(() => document.querySelector('#pair').click());
    await popup.waitForFunction(() => !document.querySelector('#stop').hidden, { timeout: 10000, polling: 100 });
    return {
      close: () => browser.close(),
      stopSharing: async () => {
        await popup.evaluate(() => document.querySelector('#stop').click());
        await popup.waitForFunction(() => document.querySelector('#stop').hidden, { timeout: 10000, polling: 100 });
      },
    };
  } catch (error) { await browser.close(); throw error; }
}
