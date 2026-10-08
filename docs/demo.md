# Demo guide

## Desktop feature summary

The 0.7.34 Desktop preview installs into official Harness Desktop. Its qualified
target is macOS Apple Silicon with Harness runtime **0.2.0-rc.2**. Present the
DSCODE workflow and the Plugin Hub contribution separately:

| Area | What the user gains | Boundary |
| --- | --- | --- |
| DSCODE coding workflow | A DSCODE preset with custom model/account settings, session communication, memory, usage and delegation views | Terminal-only panels retain their terminal UI; model behavior depends on the configured provider. |
| DSCODE browser workflow | Browser tools, per-site access, a screenshot preview and point annotations in the conversation | Chrome is required. An image-capable model is needed to interpret screenshots; captures expire and must be refreshed after navigation. |
| DSCODE optional services | Email inbox integration and scheduled work | Account configuration and explicit opt-in are required. Desktop must stay open for scheduled delivery. |
| Our Plugin Hub integration | Search and categories across our community catalog, package details, compatibility and reported scan information, plus read-only discovery tools for the agent | Catalog coverage defines the search scope. Reported scans do not establish that a plugin is safe. |
| Hub installation handoff | Review an exact npm version, confirm its installation and open official management | Official Harness inspects and installs it. New plugins remain disabled; official controls own enabling, configuration and removal. |

The Hub story is **find → understand → review → install → manage**. Its value is
community discovery and the information needed to choose a plugin. Do not count
DSCODE's browser, memory or coding features as Hub features, or claim that Hub
replaces official lifecycle management. This demo makes no claim that every
official Desktop version lacks search.

## Five-minute Desktop walkthrough draft

This draft is for existing DSH Desktop users. Choose the final emphasis and
recording length with the presenter; allow separate time for downloads and
account setup. The installation and UI paths have verification records, but
this complete timed walkthrough has not been rehearsed with a live model.

### Prepare

1. Use a disposable Desktop profile and a scratch workspace. Install
   `@toddzheng024/dscode-desktop@0.7.34` through **Plugins → Add plugin**, then
   choose **Enable now**. Select the **DSCODE** preset. Follow the
   [installation guide](browser-use.md#install-the-experimental-combined-desktop-package)
   if migrating from the old probe package.
2. Configure a model in private, confirm one short response and install Chrome.
   For the annotation segment, choose a model whose configuration accepts images.
   Do not record API keys, account login or personal workspace contents.
3. Open **Settings → Plugin Hub**, search for `dsh-theme-plugin`, and check the
   current details and compatibility. The recorded installation check used
   **0.3.3**; the live catalog may offer a newer exact version. Rehearse that
   version before using it in a recording. An incompatible or unavailable entry
   is a reason to show discovery only, without claiming installation succeeded.
4. Keep the [0.7.34 release page](https://github.com/qiz029/dscode/releases/tag/v0.7.34)
   ready for the installation and distribution closing shot. The public npm
   package and GitHub archive carry the same qualified bytes.

### Walkthrough

| Approximate time | Action | Point to explain |
| --- | --- | --- |
| 0:00–0:30 | Show the enabled DSCODE plugin and a DSCODE session in official Desktop. | Existing DSH Desktop users can add DSCODE through a plugin. |
| 0:30–1:30 | Open Plugin Hub, search, choose a category and open details. | Our Hub brings community discovery, descriptions and compatibility information into the application. |
| 1:30–2:30 | Choose **Review installation**, show the exact package/version, then **Confirm installation**. Wait for its actual outcome. | The user reviews the package; official Harness performs installation. Download time is additional. |
| 2:30–3:00 | Choose **Manage installed plugin**, show its disabled state and official controls. | Enabling, configuration and removal stay in official management. Enabling the example theme is optional. |
| 3:00–4:30 | In the DSCODE session, ask: “Use the browser to open https://example.com and inspect the page.” Grant that origin if requested. In **Browser preview**, refresh the image, select a point, type “Summarize the text at this point” and choose **Send annotation**. | This is DSCODE's browser workflow. The screenshot, page reference and selected point enter the conversation; show the real response only after it arrives. |
| 4:30–5:00 | Show the exact npm install specification and GitHub release assets/notes. | Users can install the released plugin today; releases include compatibility, changes and verification limits. |

For a Hub-only cut, keep the first four rows and the release closing shot. No
model account is needed to browse and install through the Hub UI. For a longer
DSCODE cut, add a scratch-project coding task and demonstrate the relevant
usage/delegation view after rehearsing it with the selected model.

### Rehearsal and reset

- Confirm the selected package is absent before the install shot. Remove a
  previous demo installation through official **Plugins** in the disposable
  profile, then reopen Hub. Do not remove plugins from a personal profile to
  prepare the demonstration.
- Show success, cancellation, refusal or restart-required exactly as reported.
  After a Host restart, inspect official **Plugins** before attempting another
  installation; Hub operation history does not survive the restart.
- If the Hub/network is unavailable, use a clearly identified earlier recording
  or continue with the DSCODE segment. Do not label cached footage as a live
  successful install.
- Refresh the browser screenshot and select a new point if the capture expires
  or navigation occurs. Text-only delivery must be described as text-only.
- Keep standalone DMG delivery, coordinated update/changelog UI, Profile
  rollback and native Computer Use permission qualification out of this demo's
  claims. See [Plugin Hub](plugin-hub.md), [Browser use](browser-use.md) and the
  [release notes](releases/0.7.34.md) for the shipped behavior and limits.

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
