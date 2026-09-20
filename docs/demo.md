# The 90-second demo

Most coding agents work alone. This script shows the three things DSCODE does
instead — sessions that can see each other, an independent reviewer for code and
for approvals, and side questions that never disturb the main conversation — in
an order a stranger can follow.

The recording lands in `assets/demo.gif`; put that image directly under the
README tagline. Every command below is real, so the demo is reproducible: the
only unpredictable part is the model's own wording.

## Record it

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

## Shot list

| Time | Screen | Do this | Say this (captions) |
|---|---|---|---|
| 0:00–0:06 | Shell in the scratch repo | `dscode` | "A coding agent in your terminal — macOS, local, one pinned harness." |
| 0:06–0:22 | TUI, main session | Type `Add a bounds check to parse() in parser.ts and run the tests.` | "It reads the file, edits it, runs the tests." |
| 0:22–0:36 | Same terminal | `/btw why would the first turn have a cold cache?` — leave the main turn running | "A side question runs in its own read-only child session. The answer never enters the main conversation." |
| 0:36–0:56 | Second terminal | `dscode sessions` then `dscode send <the other session id> --steer "review the change in parser.ts and reply with what you would change"` | "Two sessions on one machine can find each other, hand work over and answer." |
| 0:56–1:06 | Back in the first terminal | Show the reply arriving (`/mailbox`, or the agent's `read_session`/`send_session` tools if you asked it to hand the review over itself) | "The answer comes back as a message, not as a new task." |
| 1:06–1:20 | Same terminal | `/review` | "And the diff can go to an independent reviewer model that never saw this session." |
| 1:20–1:30 | Closing card | Static title + `npm i -g @toddzheng024/dscode` | "Agents that work as a team. `npm i -g @toddzheng024/dscode`" |

Two beats worth keeping if you have the seconds:

- `/permission auto` then `/review-usage`: the approval layer is a model that
  scores whether **your instruction** authorized the exact action, and the panel
  shows what that cost. Hard to stage reliably on camera; describe it in the
  closing card instead if the demo must be shot in one take.
- `/agents` at the end: the `/btw` child session is a real, read-only session,
  not a hidden prompt.

## Reproduce it without recording

```sh
npm i -g @toddzheng024/dscode
cd ~/demo && dscode                      # terminal 1: the main session
dscode sessions                          # terminal 2: both session ids
dscode send <id> --steer "review the change in parser.ts and reply with what you would change"
dscode read <id>                         # read that session's event page
dscode watch <id>                        # subscribe to it instead
```

In the TUI: `/btw <question>` (side question), `/review` (independent review of
the diff), `/permission auto` + `/review-usage` (approval policy and its cost),
`/agents` (every child session), `/mailbox` (messages between sessions).
