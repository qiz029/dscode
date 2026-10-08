// Page URLs and handoff reasons may contain untrusted terminal control text.
const line = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 600);

export function formatStatus(status) {
  const config = status.config ?? status;
  const mode = config.mode ?? status.mode;
  const handoff = status.connected ? status.handoff : null;
  const lines = [`Browser: ${handoff ? 'waiting for you' : status.connected ? 'connected' : 'disconnected'}${mode ? ` · ${line(mode)}` : ''}${status.headless ?? config.headless ? ' · headless' : ''}`];
  if (status.message) lines.push(line(status.message));
  if (status.extensionPath) lines.push(`Load unpacked extension: ${line(status.extensionPath)}`);
  if (status.pairingUrl) lines.push(`Pairing link (keep private): ${line(status.pairingUrl)}`);
  if (mode === 'extension' && status.extensionReady !== undefined) lines.push(status.extensionReady ? 'Extension paired; shared tabs are available.' : 'Extension not paired. Use /browser pair and share a tab.');
  if (status.error) lines.push(`Error: ${line(status.error)}`);
  if (status.profile) lines.push(`Profile: ${line(status.profile)}`);
  else if (config.profile) lines.push(`Profile name: ${line(config.profile)}`);
  if (config.url) lines.push(`Chrome: ${line(config.url)}`);
  if (config.webmcp !== undefined) lines.push(`WebMCP: ${config.webmcp ? 'enabled' : 'disabled'}`);
  if (status.permissions) {
    lines.push(`Developer mode: ${status.permissions.developerMode ? 'on' : 'off'}`);
    lines.push('Sites (HTTP(S) scheme, host and port; unknown sites require permission):');
    for (const [origin, rule] of Object.entries(status.permissions.sites)) lines.push(`  ${line(origin)}: ${rule.access}${rule.developer ? ' · developer allowed' : ''}`);
    for (const origin of status.permissions.sessionSites) lines.push(`  ${line(origin)}: allowed until this browser stops`);
    lines.push('Grant: /browser site once <origin> · Block: /browser site block <origin>');
  }
  if (handoff) {
    lines.push(`Your step on tab ${handoff.pageId}: ${line(handoff.reason)}`);
    if (handoff.invalidated) lines.push('Chrome restarted; the original tab ID is no longer valid.');
    if (handoff.focusError) lines.push(line(handoff.focusError));
    lines.push('Browser automation is paused. When ready: /browser resume, then ask the agent to continue.');
  }
  if (status.pages?.length) {
    lines.push(`Tabs (last observed${status.observedAt ? ` ${line(status.observedAt)}` : ''}):`);
    for (const page of status.pages) {
      const flags = [page.owned ? 'agent' : 'existing/user', page.kept ? `kept${page.retention ? `: ${line(page.retention)}` : ''}` : null,
        handoff?.pageId === page.id && !handoff.invalidated ? 'handoff' : null].filter(Boolean);
      lines.push(`  ${page.id} [${flags.join(', ')}] ${line(page.url)}`);
    }
  }
  if (status.closed) lines.push(`Closed tabs: ${status.closed.length ? status.closed.join(', ') : 'none'}`);
  if (status.artifacts) lines.push(`Artifacts: ${line(status.artifacts)}`);
  if (!handoff) lines.push(status.connected
    ? 'Refresh: /browser tabs · Take over: /browser handoff <id> · Stop: /browser stop'
    : 'Start: /browser start · Choose profile: /browser use persistent <name>');
  return lines.join('\n');
}
