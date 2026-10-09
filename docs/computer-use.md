# Computer Use

Computer Use observes and operates local macOS application windows through
Accessibility, with screenshot artifacts for visual evidence. Prefer a connector,
API, CLI or browser tool when one can complete the task directly.

## Experimental Desktop adapter

The [combined Desktop package](browser-use.md#install-the-experimental-combined-desktop-package)
includes an experimental native adapter. It requires macOS 14 or later; the
packaged helper supports Apple Silicon and Intel. Other platforms keep the Host
available and report Computer Use as unsupported, without exposing its tools.

In a DSCODE session, load the `dscode-computer-use` skill before using native tools.
Loading the exact bundled skill activates app discovery, observation, click,
value entry, typing, keyboard, scrolling, dragging, advertised Accessibility
actions, bounded waits and sensitive-action confirmation. Native Standard
sessions do not receive this skill or its tools. A successful skill load is
restored from persisted session history; unloading the plugin removes its tools
from open agents, and reloading restores them where that history permits.

`/computer` or `/computer status` checks helper health and reports Accessibility
and Screen Recording permissions. A healthy helper can still report a missing
OS permission. It does not change those permissions or application grants.

The current qualification covers helper integrity and initialization, app
discovery, progressive activation, native session resume, Standard isolation,
denied unconfigured app access, and live-plugin unload/reload on Host versions
`0.2.0-rc.2` and `0.2.1-alpha.1`. The tested helper reported Accessibility denied.
**Reading application windows, screenshot capture and input actions have not yet
been qualified in the Desktop adapter.** Their presence in the tool catalog does
not establish that those operations work on your machine.

## Application and OS permissions

There are two independent permission layers:

- macOS Accessibility and Screen Recording govern the native process. Grant them
  through System Settings when you choose to permit these capabilities. Use
  `/computer` to recheck after changing permissions or restarting Desktop.
- DSCODE app read/control grants select which applications a session may use.
  Missing grants follow the session's approval policy. A rejected request stays
  rejected for that session and scope. With prompts disabled, missing grants are
  denied without a user dialog; full filesystem access does not grant app access.

The Desktop entry is `dscode-desktop-computer-use`. Its profile configuration can
grant exact bundle IDs. For example, this grants read access only to TextEdit:

```yaml
- id: dscode-desktop-computer-use
  config:
    allowAllApps: false
    observationTtlMs: 30000
    grants:
      - bundleId: com.apple.TextEdit
        read: true
        control: false
```

Restart Desktop after editing the profile configuration. `control: true` also
permits reading that app. Wildcard bundle IDs are rejected. Defaults grant no
applications and preserve the user's foreground app for both pointer and
keyboard input. The adapter uses the Host's configuration directly and does not
install the upstream plugin's retired Settings API or its old Web settings page.

## Observation and image evidence

Actions require a fresh observation ID. Element indices belong to that
observation; opaque target handles permit only validated, unambiguous rebinding.
Successful actions return fresh state. Sensitive actions require a one-use
confirmation tied to the app, observation and exact action; a changed target
requires fresh confirmation.

Screenshots are stored as workspace image artifacts. Use the Host's `read_image`
tool and an image-capable model to inspect the returned path. Missing model image
support is a separate limitation from Screen Recording permission. The Desktop
adapter does not require the separate upstream Vision Toolkit plugin.

The terminal installation continues to use its existing `computer-use` skill and
upstream bundle. Desktop-specific activation, configuration and qualification
described here do not change that terminal integration.
