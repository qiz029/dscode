// The composition overlay that turns a terminal profile into one triggered run:
// the terminal rows are disabled and the trigger host is inserted instead. It is
// a pure string builder on purpose — the published launcher ships this file to
// compose the same overlay, and it must not pull the host's dependencies in.
export function triggerOverlay(pluginPath) {
  return `- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- id: dscode-session-cards\n  config:\n    enabled: false\n- insert:\n    - id: dscode-trigger-host\n      name: ${JSON.stringify(pluginPath)}\n`;
}
