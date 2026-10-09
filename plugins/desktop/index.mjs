import { apply as customSettings } from '../custom/desktop-host.mjs';
import { apply as browserPreview } from '../browser/desktop-host.mjs';
import { apply as providerAccounts } from '../providers/desktop-host.mjs';

export const inject = ['agents', 'commands'];
export function apply(ctx) {
  ctx.provide('dscodeDesktop', true);
  customSettings(ctx);
  browserPreview(ctx);
  providerAccounts(ctx);
}
