# DSCODE for Harness Desktop

DSCODE adds a coding preset, browser workflows, cross-session collaboration,
memory and task management to the official DeepSeek Harness Desktop application.

**Version:** {{VERSION}} · **Harness runtime:** {{RUNTIME}}

{{BUILD_KIND}}

This package is a Desktop extension. Install the official Harness Desktop
application first. It does not contain a standalone application, the DSCODE
terminal UI, or an automatic updater.

## Requirements

- The exact Harness runtime shown above. A Desktop product version may differ
  from its embedded runtime; check the bundled `dsh --version`.
- The currently qualified application platform is macOS 14+ on Apple Silicon.
- A configured model account or custom provider. Screenshot understanding
  requires an image-capable model.
- Google Chrome for browser tasks.

Other platforms and newer Harness runtimes require separate qualification.
Do not force an installation that reports incompatible peer dependencies.

## Install a candidate

Download the candidate `.tgz` and compare its SHA-256 with the release receipt.
In Harness Desktop, open **Plugins → Add plugin**, enter the absolute path to
the downloaded `.tgz`, install it, then choose **Enable now**.

For CLI installation, fully quit the application and use its bundled CLI,
replacing the package path with your download:

```sh
desktop_dsh='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$desktop_dsh" plugin --profile desktop add /absolute/path/to/dscode-desktop.tgz --ignore-scripts
```

Restart Desktop, select the **DSCODE** preset, select a workspace, and configure
the model under **Settings → DSCODE models** or **DSCODE accounts**.

Installation through the official **Plugins → Add plugin** interface was checked
on macOS Desktop 0.2.0-rc.2. Public npm installation instructions accompany a
public release; a candidate build alone does not publish a package.

## Moving from the earlier private probe

Do not enable the old probe and this package together: they register the same
DSCODE components. Quit Desktop, remove the old package, then install this one:

```sh
"$desktop_dsh" plugin --profile desktop remove @toddzheng024/dscode-desktop-preset-probe --config.ignore-scripts=true
```

Migration from the old package name was checked separately on Desktop
0.2.0-rc.2: removal followed by installation preserved sessions, credentials,
configuration and the user patch. Keep a backup before migrating your own state.

## Included capabilities

- Coding tools, a persistent shell, unified-diff `apply_patch`, worktree-backed
  delegation and a task board.
- Browser tools, explicit site and Developer permissions, preview and point
  annotations, manual handoff and optional Chrome tab sharing.
- Custom model and account settings, session usage and cost views.
- Durable session messaging, source-backed memory and opt-in scheduling.
- Email inbox, IMAP/Gmail setup and explicit message-to-session delivery.
- Independent code review, optional automatic permission review and diagnostics.
- Plugin Hub search, categories and details, read-only conversation discovery,
  and reviewed installation through the official plugin manager. Enable and
  configure installed plugins in **Settings → Plugins**; see `docs/plugin-hub.md`.

Use the bundled guides under `docs/` for individual settings and boundaries.
The terminal's state directory may differ from Desktop's; sharing credentials
does not automatically share sessions or memory. Scheduling runs only while
the application remains open.

## Qualification limits

Local native Host and official Desktop tests cover scripted execution and the
install lifecycle. They do not establish real-model task quality. The included
experimental native Computer Use adapter still needs screenshot and input
qualification with macOS Accessibility permission. General remote HTTP MCP
has separate unresolved runtime compatibility/security work; it is outside
this package's qualified browser workflow.

## Remove or replace

Fully quit the application before using the bundled CLI to replace or remove
the package. Repeating `plugin ... add` with a compatible newer tarball replaces
the installed version. To remove:

```sh
"$desktop_dsh" plugin --profile desktop remove @toddzheng024/dscode-desktop --config.ignore-scripts=true
```

Restart afterward. Removal does not erase sessions, memory, or saved credentials
and does not revoke provider accounts. It removes the package's live components.

## Source and support

[Source and issues](https://github.com/qiz029/dscode) ·
[Usage guides](https://github.com/qiz029/dscode#documentation)

DSCODE is an independent community project. Original third-party licenses and
modification notices are included in `LICENSE` and `THIRD_PARTY_NOTICES.md`.
