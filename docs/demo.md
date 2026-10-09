# Demo guide

## Desktop feature summary

The 0.7.35 Desktop preview installs into official Harness Desktop.
Its qualified target is macOS Apple Silicon with runtime **0.2.0-rc.2**.
This version removes bundled Hub functionality. Demonstrate DSCODE on its own
and state which version is being shown.

| Area | What the user gains | Boundary |
| --- | --- | --- |
| DSCODE coding workflow | A DSCODE preset with custom model/account settings, session communication, memory, usage and delegation views | Terminal-only panels retain their terminal UI; model behavior depends on the configured provider. |
| DSCODE browser integration | Per-site and Developer permissions, screenshot preview and point annotations delivered to the conversation, manual login handoff | Official Harness already has Browser Use. DSCODE connects external Chrome; it does not enhance or share login state with the official embedded browser. |
| DSCODE optional services | Email inbox integration and scheduled work | Account configuration and explicit opt-in are required. Desktop must stay open for scheduled delivery. |

Hub community discovery belongs in a separate product demo. The removal does
not deliver a standalone Hub Desktop package. See [Plugin Hub](plugin-hub.md)
for the behavior of earlier published versions.

## Five-minute Desktop walkthrough draft

Allow separate time for downloads and account setup. This complete timed
walkthrough has not been rehearsed with a live model.

### Prepare

1. Use a disposable Desktop profile and scratch workspace. For the published
   demo, install `@toddzheng024/dscode-desktop@0.7.35` through **Plugins → Add
   plugin**, then choose **Enable now**. Fully quit and reopen Desktop after
   updating. Hub is separate from this package. For local development builds,
   follow the [installation guide](browser-use.md#install-the-experimental-combined-desktop-package)
   and identify the checkout being demonstrated.
2. Select the **DSCODE** preset when creating the session. Harness 0.2.0-rc.2
   gates the preset picker behind **Show coding view**; ensure that option and
   the Agent presets UI are enabled before recording. A Standard session does
   not acquire the complete DSCODE preset just because the package is installed.
3. Configure a model in private, confirm one short response and install Chrome.
   For annotations, choose a model that accepts images. Do not record API keys,
   account login or personal workspace contents.
4. Rehearse one small coding task and the browser annotation with that model.
   Keep the matching release page or local-build information ready. A local
   build must not be presented as the published 0.7.35 archive.

### Walkthrough

| Approximate time | Action | Point to explain |
| --- | --- | --- |
| 0:00–0:30 | Show the enabled DSCODE plugin and a DSCODE session. | Existing DSH Desktop users can add the coding workflow through a plugin. |
| 0:30–2:00 | Run the rehearsed small coding task in the scratch workspace. | Show actual changes and verification; model quality is not established by the installation checks. |
| 2:00–4:00 | Ask the agent to open https://example.com. Grant that origin if requested. In **Browser preview**, refresh, select a point, enter “Summarize the text at this point” and choose **Send annotation**. | Basic browsing overlaps official Browser Use. The demonstrated DSCODE additions are the permission controls and screenshot/point handoff into the conversation. |
| 4:00–4:30 | Open the session usage view; show the delegation view only if the task actually delegated. | Views reflect the current DSCODE session and available records. |
| 4:30–5:00 | Show the matching install specification and release notes, or label the local build. | Published availability and an unreleased change are distinct states. |

### Rehearsal and reset

- Reopen Desktop after a package update. Confirm both plugin activation and a
  working new DSCODE session before starting the recording.
- Refresh the screenshot and select a new point after navigation or expiry.
  Image understanding needs an image-capable model. Describe text-only delivery
  as text-only.
- Stop the session browser between rehearsals. Its Chrome profile and login
  state are separate from the official embedded browser.
- Keep standalone DMG delivery, Hub integration, coordinated update/changelog
  UI, Profile rollback and native Computer Use permission qualification out of
  this demo's claims. See [Browser use](browser-use.md) and the
  [0.7.35 release notes](releases/0.7.35.md) for published behavior and limits.

## The 90-second terminal demo

The terminal script shows sessions that can see each other, an independent
reviewer for code and approvals, and side questions that leave the main
conversation's context unchanged.

The recording lands in `assets/demo.gif`; put that image directly under the
README tagline. Rehearse the commands below with the selected model before
recording: response quality and timing are not established by this script.

### Record it

```sh
brew install asciinema agg
cd /path/to/dscode                 # the repo, so the cast can be saved next to it
asciinema rec demo.cast -i 2       # then run the shot list below; -i trims pauses
agg demo.cast assets/demo.gif      # renders the cast into the gif the README shows
```

Checked against **asciinema 3.2.1 + agg 1.9.0**: `rec` writes asciicast v3 by
default and `agg` reads it, as it does v2 — pass `-f asciicast-v2` if you use an
older `agg`. `-i 2` (idle time limit) caps every pause at two seconds, which
keeps the gif close to the 90 seconds you actually plan; recording has to happen
in a real terminal window, since the command needs the child's pty.

Before you hit record:

- Window at least **120 columns** and a font around 14pt: the footer, the panels
  and `/btw` all want width. Dark theme (the default).
- A scratch repository so nothing personal shows up:
  ```sh
  mkdir -p ~/demo && cd ~/demo && git init
  printf 'export const parse = (text: string) => text.split(",")\n' > parser.ts
  printf 'import { parse } from "./parser"\nconsole.log(parse("a,b,c"))\n' > index.ts
  git add -A && git commit -m "start"
  ```
- Your normal installation and credentials (do not show `dscode doctor` output
  or full home paths). Any interface language works; the captions below are
  English.

### Shot list

| Time | Screen | Do this | Say this (captions) |
|---|---|---|---|
| 0:00–0:06 | Shell in the scratch repo | `dscode` | "A coding agent in your terminal — macOS, local, one pinned harness." |
| 0:06–0:22 | TUI, main session | Type `Trim whitespace and ignore empty fields in parse() in parser.ts. Add and run tests.` | "It reads the file, edits it, runs the tests." |
| 0:22–0:36 | Same terminal | `/btw why would the first turn have a cold cache?` — leave the main turn running | "A side question runs in its own read-only child session. The answer never enters the main conversation." |
| 0:36–0:56 | Second terminal | `dscode sessions` then `dscode send <the other session id> --steer "review the change in parser.ts and reply with what you would change"` | "Two sessions on one machine can find each other, hand work over and answer." |
| 0:56–1:06 | Back in the first terminal | Show the reply arriving (`/mailbox`, or the agent's `read_session`/`send_session` tools if you asked it to hand the review over itself) | "The answer comes back as a message, not as a new task." |
| 1:06–1:20 | Same terminal | `/review` | "And the diff can go to an independent reviewer model that never saw this session." |
| 1:20–1:30 | Closing card | Static title + `npm i -g @toddzheng024/dscode` | "Agents that work as a team. `npm i -g @toddzheng024/dscode`" |

Two beats worth keeping if you have the seconds:

- `/permission auto-review` then `/review-usage`: the approval layer is a model that
  scores whether **your instruction** authorized the exact action, and the panel
  shows what that cost. Hard to stage reliably on camera; describe it in the
  closing card instead if the demo must be shot in one take.
- `/agents` at the end: the `/btw` child session is a real, read-only session,
  not a hidden prompt.

### Reproduce it without recording

```sh
npm i -g @toddzheng024/dscode
cd ~/demo && dscode                      # terminal 1: the main session
dscode sessions                          # terminal 2: both session ids
dscode send <id> --steer "review the change in parser.ts and reply with what you would change"
dscode read <id>                         # read that session's event page
dscode watch <id>                        # subscribe to it instead
```

In the TUI: `/btw <question>` (side question), `/review` (independent review of
the diff), `/permission auto-review` + `/review-usage` (approval policy and its cost),
`/agents` (every child session), `/mailbox` (messages between sessions).
