// Runs inside the official application's core module graph, after onboarding.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyDesktopBrowser } from './desktop-browser-probe.mjs';

export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'permissionPresets', 'commands', 'attachments', 'connection', 'webServer'];
export function apply(ctx) {
  void ctx.get('loader').await().then(async () => {
    const ready = await verifyDesktopBrowser(ctx, { interactive: true });
    console.log('DESKTOP_ELECTRON_READY ' + JSON.stringify(ready));
  }).catch(error => {
    writeFileSync(join(process.env.DSH_HOME, 'browser-ui-failure.log'), error.stack ?? String(error));
    console.error(error); ctx.get('appExit')(1);
  });
}
