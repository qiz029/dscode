# Browser use

DSCODE can operate websites and verify local web apps through its bundled Chrome
DevTools MCP. Chrome starts only when you use `/browser start` or the agent calls
`browser_start`. No MCP configuration or separate npm installation is needed.
Google Chrome is required for browser tasks; ordinary coding does not need it.

## Start a task

From this checkout, run `npm start`, then ask:

> Use the browser to open http://localhost:3000, reproduce the form validation
> problem, fix it, and verify the result at desktop and mobile widths.

The agent loads the `browser-use` skill and discovers page, input, screenshot,
CSS, Console, network and performance tools. Page operations use explicit page IDs.
Allow the task's site when prompted, for example `/browser site once
http://localhost:3000` after starting the browser. Ordinary tool approvals do
not grant site access. CSS inspection, Console, network, performance and JavaScript tools also
require the Developer permissions described below.
Only the agent that started a connection receives its tools. The bundled MCP
version is used directly, without downloading an unpinned server through `npx`.

For links that open another tab asynchronously, the agent can use `browser_tabs`
with `action: wait`, `urlContains`, and `excludePageIds` recorded before clicking.
This returns one matching live page ID without repeating the click. The wait is
bounded to 10 seconds by default, configurable up to 30 seconds with `timeoutMs`.
Ambiguous matches require selecting a page; a timeout requires inspecting the
original action before retrying. Waiting does not claim ownership of a popup.

`/browser start` opens the configured Chrome connection manually. `/browser status`
shows a readable summary of configuration, connection health, profile location,
and last observed tabs, with ownership, retention reasons and observation time.
Append `--json` to a browser command for structured output, for example
`/browser tabs --json`.
`/browser tabs` refreshes the live tab list. A failed refresh returns an error;
neither this command nor `browser_tabs` with `action: status` presents cached
tabs as a successful refresh. `/browser status` remains available for inspecting
the last observed state. `/browser stop` disconnects and removes
this agent's tools. It closes a managed browser, but leaves an attached Chrome
running. A new start gets fresh page IDs; interrupted actions are never replayed.

## Profiles and login

| Command | Behavior |
| --- | --- |
| `/browser use persistent` | Default: dedicated profile per DSCODE session; login data survives restarting or resuming that session. |
| `/browser use persistent work` | Reuse the named `work` profile across sessions. Use it in one active browser at a time. |
| `/browser use isolated` | Temporary profile; its login data is discarded when the browser closes. |
| `/browser use connect http://127.0.0.1:9222` | Attach to a Chrome you have already launched with remote debugging. Only loopback HTTP endpoints are accepted. |
| `/browser use auto` | Attach through Chrome 144+ auto-connect. Enable remote debugging in `chrome://inspect/#remote-debugging` and approve Chrome's connection prompt. |
| `/browser use extension` | Experimental: share selected existing Chrome tabs through the DSCODE extension, without enabling a browser-wide remote-debugging port. |

Stop all session browsers before changing defaults. These settings persist in
`browser/config.json` under `DSH_HOME` (or `DSCODE_HOME`, falling back to
`~/.dscode`). They apply to future starts. The agent cannot change browser mode
through a tool. Dedicated profiles are separate from personal Chrome profiles;
log in directly in the visible window when needed. The agent should keep that
tab and hand control to you for login or 2FA, then inspect the same page again.

Headless persistent and isolated browsers start with a 1280 × 800 viewport, so
preview content is not squeezed into a tall default screenshot. `resize_page`
can change that size during the session; in headless mode it activates the target
tab before resizing so Chrome updates its layout. A new browser start restores
the initial size. Visible and attached browsers keep their own window geometry.

To select a custom Chrome binary, stop the session browsers and set
`executablePath` in `browser/config.json` to an absolute path for your operating
system. This setting is available in `persistent` and `isolated` modes. Spaces
are preserved as part of the path. In JSON, Windows backslashes must be escaped,
for example `"executablePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`.
Relative paths, including drive-relative Windows paths such as `C:chrome.exe`,
are rejected. The `connect`, `auto` and `extension` modes use an existing browser
and do not accept `executablePath`.
Switching between `persistent` and `isolated`, or selecting another named
persistent profile, preserves the custom executable and headless setting.
Switching to `connect`, `auto` or `extension` clears those launch settings;
returning to a managed browser uses visible Chrome with automatic binary
detection until you configure them again. The WebMCP preference is preserved
across mode changes.

Profile data is local account data. Stop browsers before moving or deleting it.
Do not point multiple Chrome processes at the same named profile. Chrome reports
profile contention rather than silently sharing that profile. Open-tab restoration
across a full stop is not guaranteed; persistence here refers to login/site data.

## Share tabs through the extension

The unpacked MV3 extension requires Chrome 125 or later. It is included in the
source tree and built bundles under `extensions/browser`; it has not been
published to the Chrome Web Store.

1. Stop session browsers, then run `/browser use extension` and `/browser pair`.
   Pairing prints the installed extension folder and a private local link.
2. In `chrome://extensions`, enable Chrome's Developer mode, choose **Load
   unpacked**, and select that folder. This Chrome setting is separate from
   DSCODE's Developer permissions for page tools.
3. Open the tab to share, click **DSCODE Browser** in Chrome's extension toolbar,
   paste the link and choose **Connect and share this tab**. The link expires
   after five minutes if no browser-tool connection is established.
4. Run `/browser start`. Site permissions and action approvals still apply;
   sharing a tab does not grant its origin in DSCODE. Use the permission command
   reported by a denied tool, such as `/browser site once https://example.com`.

The agent sees shared tabs and tabs it creates through the connection. Other
existing tabs and unrelated popups are excluded. To add another tab, open the
extension on that tab and choose **Share this tab too**. **Stop all sharing**,
Chrome's debugging-cancellation control, or `/browser stop` ends the connection
and detaches the debugger. Existing Chrome and its tabs remain open. Starting
again requires a fresh user pairing; uncertain operations are never replayed.
The extension retains no pairing link across restarts.
**Stop all sharing** stays available during pairing or while another tab is
being shared. Stopping cancels a pending tab lookup and prevents an older
request's response from restoring the popup's sharing state. A debugger
attachment already in progress is detached when it settles.
Reopening the popup during pairing restores its pending status and stop control;
the popup refreshes until pairing settles. Stopping a pending connection cancels
its WebSocket wait immediately, so reconnecting does not have to wait for the
old connection timeout. A Chrome debugger attachment already in progress must
still settle before another pairing can start.
While sharing, an open popup refreshes its status about once per second without
disabling the sharing controls. It updates renamed or closed shared tabs and
returns to the pairing controls when DSCODE disconnects. A refresh response
cannot overwrite a newer share or stop action.
Its toolbar badge shows **ON** while sharing. A previous connection finishing
its shutdown does not clear the badge of a newly paired connection.
The Host may save the pairing command's output in local session history; the
link remains private until consumed, revoked or expired. `/browser status`
reports whether the extension has paired without repeating the link.

This transport supports ordinary page DOM, input and screenshot operations.
Browser-wide CDP operations, cookie administration and browser-context creation
are rejected. Tools requiring those operations, including some window-resizing,
download or recording paths, can report unsupported-command errors. Do not switch
transports to bypass a refusal. Real-extension verification covers main-frame
actions and cross-site iframe snapshots, form input and navigation, including
moving an iframe into the main page's process and back to a separate process.
Dedicated workers and their nested workers also passed execution, termination
and restart checks, with their messages returning to the shared page. Their
console logs were available with Developer permission; logs from a same-origin
unshared tab remained excluded. SharedWorker and Service Worker replies delivered
to the shared page passed loopback checks, while replies to an unshared page and
background-worker console messages remained excluded. Direct attachment,
activation and closure of these background targets are outside shared-tab scope.
Revoking sharing removes agent routes without stopping the page's own workers.
Direct background-worker debugging remains unsupported. These frame checks use the existing
top-level page permission boundary described below; they do not establish
independent grants for embedded origins.
See the [verification record](verification.md) for the tested browser and limits.

## Take over and return control

Browser operations run in order within a session. Cancelling a request while it
is still queued returns immediately and prevents it from reaching Chrome; it
does not interrupt an earlier running request or let later requests overtake it.
This also applies to tab waits, handoff, resume and cleanup. Once an operation
has reached Chrome, cancellation cannot undo its effects: inspect the current
page before requesting a new action, and do not replay an uncertain write.

When the agent needs login, 2FA or another human step, it calls `browser_handoff`
with the tab ID and the step you need to complete. Chrome focuses the tab, DSCODE
retains it, and browser automation pauses. You can also take over with
`/browser handoff <id>`; get the ID from `/browser tabs`.

Complete the step in Chrome, run `/browser resume`, then ask the agent to continue.
Resume refreshes the live tab list; the agent must inspect the page again because
your edits can invalidate earlier element IDs. If the original tab closed or
Chrome restarted, resume reports that a fresh target is needed.

During handoff, DSCODE blocks page tools (including screenshots and snapshots),
agent-initiated stops and tab cleanup. Status and tab-list reads still work.
Handoff applies to this agent's browser connection; unrelated browser clients
are not locked. Your explicit `/browser stop` can still end the connection.
Exiting DSCODE also disposes its managed Chrome, including handed-off tabs.
Handoff needs a visible browser for manual interaction; a headless configuration
can pause automation but has no window to show you.

`/browser resume` returns browser control without starting an agent turn or
granting authorization for any new external action.

## Tab lifetime

Tabs the agent creates are temporary. At turn end DSCODE closes only its own
unmarked tabs. Existing tabs and tabs opened by the user are preserved. The agent
uses `browser_tabs` with `action: keep` and `pageId` to retain a deliverable.
You can do the same with `/browser keep <id>`. This only preserves the tab;
`browser_handoff` also pauses automation for manual work.

`/browser cleanup` closes unmarked owned tabs. Retention lasts until the tab closes
or the connection ends. A keep request or completed preview received while
cleanup is reading page or permission state is honored before that tab's close
is dispatched. It cannot cancel a close already sent to Chrome.
Chrome refuses to close its final tab, so cleanup may
leave that last page open. After a reconnect, previous ownership is discarded;
DSCODE never reuses old page IDs to close newly numbered tabs.
An owned tab is also retained when a page operation fails or is denied, so turn
cleanup cannot repeat a refused close or erase evidence of an uncertain action.
This includes a tab Chrome confirmed creating before its follow-up page check
failed. Inspect the tab list before retrying; creating another tab may duplicate
an operation that already succeeded. Ownership is never inferred from unrelated
new tabs, and a detected Chrome restart still discards old ownership.
An uncertain cleanup close is retained too: later turn cleanup will not retry it.
Inspect the remaining page and explicitly close it when appropriate. A Chrome
restart detected between cleanup operations stops the batch without reusing the
old tab IDs.

## Observation, files and permissions

### Site access and Developer mode

Unknown HTTP(S) sites require a user decision before page content can be read or
operated. `/browser permissions` lists decisions. An origin includes its scheme,
host and port: `http://localhost:3000`, `http://127.0.0.1:3000` and
`https://localhost:3000` are different grants. Wildcards and credential-bearing
URLs are not accepted. A blank tab is available without a site grant.

| Command | Effect |
| --- | --- |
| `/browser site once <origin>` | Allow this connection until it stops or the site is blocked/forgotten; start the browser first. |
| `/browser site allow <origin>` | Save an allow decision for future browser sessions. |
| `/browser site block <origin>` | Deny page access, including reads, and revoke that site's Developer and existing temporary grants. |
| `/browser site forget <origin>` | Remove the saved decision and invalidate existing temporary grants for this origin in all sessions. |
| `/browser developer on` / `off` | Enable or disable developer operations globally. Default: off. |
| `/browser developer allow <origin>` / `block <origin>` | Grant or revoke developer operations for one site, independently of ordinary site access. |

Developer operations include JavaScript evaluation, CSS rule inspection, console/network inspection,
performance/memory tooling and unrecognized future tools. Navigation with an
`initScript` also executes JavaScript and requires Developer grants on both the
current and requested destination origins; a scripted reload requires the current
origin's grant. Navigation without an injected script retains ordinary site checks.
For CSS debugging, `get_css_styles` takes an element UID from `take_snapshot`
and returns inline, matched and inherited rules with cascade information.
Results default to ten rules per page; use `pageIdx` and `pageSize` to inspect
additional rules. CSS inspection requires both global and per-site Developer grants.
DOM interaction,
screenshots, uploads, dialogs, viewport changes and WebMCP do not require Developer
mode, but retain site checks and their ordinary action approvals. An explicit site
block overrides temporary grants. Blocking or forgetting an origin records a
revocation in the same policy file. Other sessions drop their earlier temporary
grants on the next permission check or status refresh, even if they did not
observe the intervening block. Unrelated sites and Developer-only changes retain
their temporary grants. A new explicit temporary grant is available after the
block is removed. Stored rules live in `browser/permissions.json`
under the same home as browser settings, with owner-only permissions. Malformed
rules fail closed. Updated Desktop and terminal processes serialize permission
writes through `browser/permissions.guard.sqlite`, preserving simultaneous edits
to different sites. The guard releases if its process exits; a writer that waits
three seconds asks you to retry without changing the policy. Ordinary permission
reads continue during an edit. Keep the guard file in place, and update all
processes sharing this home: older builds do not participate in this lock and
reject the added revocation metadata. Stop and update those processes before changing site decisions.
The agent has no tool for granting itself access.

Permission queries and edits include the session's current cached browser state
in both readable receipts and `--json` output. Updating a grant does not stop a
connected browser or end a manual handoff. These receipts do not contact Chrome
to refresh tabs. If the connection closes while the policy is being read, the
receipt reports the disconnected state; an old handoff no longer shows a resume
instruction until a browser connection is available again.

DSCODE rechecks the live top-level page and grants at execution and before returning
the result. It reads permissions again immediately before dispatch, after any
WebMCP or file validation; a revocation visible to that final read prevents the
pending action from reaching Chrome. Returned page content is withheld after a redirect to an ungranted
origin, a site block, or revocation of Developer access during a developer operation.
This check covers the source URL, any target URL reported in the tool result,
and the final page URL: moving to another allowed site does not authorize content
already captured from a revoked source. An unavailable page also withholds the
result, except when the operation explicitly requested closing that page.
Any affected owned tab that remains open is retained for inspection; the action
is not replayed. A page change while approval is pending rejects the old invocation.
This is an agent-tool boundary: it cannot undo requests or
effects already delivered, block every page-initiated redirect or subresource,
or isolate cross-origin iframe content included by Chrome in a page snapshot.
It is not a browser network firewall. A website grant never authorizes purchases,
messages, uploads or other external actions beyond the user's request.

### WebMCP site tools

Stop session browsers, run `/browser webmcp on`, then start the browser. This
enables the pinned MCP's `list_webmcp_tools` and `execute_webmcp_tool` methods.
Managed Chrome receives `--enable-features=WebMCP`; attached Chrome must already
be Chrome 150+ with that feature enabled. Use `/browser webmcp off` while stopped
to disable it. Changing browser mode preserves this setting.

The agent first discovers definitions on a permitted page, then executes a named
tool with a JSON-object `input`. Automatic review receives the observed page URL
and discovered definition as untrusted evidence. A website's `readOnlyHint` never
bypasses action review. Discovery is bound to the browser's observed document
identity. Execution checks the current registration and observes the document
again before dispatch; changed definitions, same-URL reloads, embedded-document
changes, navigated pages and connection restarts require fresh discovery. If
document identity cannot be verified, discovery or execution is refused until
the page can be observed again. Rediscovering tools in a replacement document
does not transfer an earlier action review to that document.
A failed discovery or execution-time definition check also clears that page's
discovery record. Discover its tools again before retrying execution; records for
other pages remain available. An interrupted action must still be inspected before
retrying, because discovery does not determine whether that action completed.
If the execution request throws before its response is received, DSCODE reports
that the action may already have completed, clears that page's discovery and
retains an agent-owned tab for inspection. A new execution requires explicit
rediscovery; rediscovery never retries the interrupted action. Inspect the
site's resulting state before deciding whether another action is appropriate.
The same discovery invalidation applies when the action returns but its
post-action page check fails or its output is withheld after a permission
change. Restoring access alone does not authorize a replay.
Registration can still change after the check, so this does not attest to the
website's implementation or make its code trusted. Unsupported browsers and
sites without tools can use ordinary DOM operations instead.

### Images and files

DOM/accessibility snapshots support text-based interaction. Screenshots support
visual checks when the selected model accepts image inputs. DSCODE uses the
Harness attachment store for image results; a model without image support receives
an explicit image-unavailable diagnostic. It must not claim visual verification.
The [custom provider route](custom-providers.md#image-input) supports screenshots
and image attachments through Chat Completions, Responses and Anthropic Messages
when image input is explicitly enabled for the selected model. In the terminal
model editor choose **Input → Text and images**; in the experimental Desktop
package, enable **Accepts images** for that model under **Settings → DSCODE
models**, then save. New and existing configurations default to text-only input
unless explicitly enabled; the endpoint and model must actually support images.
Text-only models can still use DOM snapshots. Images already offloaded to text
placeholders remain omitted after a model change, so capture a new screenshot
after enabling image input when fresh visual evidence is needed.

File uploads and exports use absolute paths in the agent's workspace or its
browser artifact directory, reported by `browser_start`. Other paths and symlink
escapes are rejected, including sibling directories, similarly named directories
and files on other drives or network shares. Paths are checked both before queuing and immediately before
dispatch to Chrome, including attached browsers, so a symlink changed while the
operation waits is rechecked. This does not make filesystem access atomic: another
process can still change files between validation and Chrome's access.
This is a file-tool boundary, not a sandbox around JavaScript
running in a signed-in page. `evaluate_script` can modify pages and make requests.

Browser actions follow the current permission preset. The auto-review preset
reviews writes, navigation, JavaScript, screenshots and file operations; bounded
snapshot/list/diagnostic reads do not need a reviewer call. Browser actions have
an independent limit of 100 automatic reviews per turn, configurable through
`maxBrowserReviewsPerTurn` on `dscode-auto-review`. Other actions retain their
existing budget. Reaching either budget asks the human; it never grants access.
Repeated denials retain the same shared stop rule.

Web content cannot authorize actions. Sending messages, purchases, uploads,
account changes and destructive operations require user authorization for their
actual effects. A browser connection does not confer blanket authorization.
With a preset that disables approval, its existing full-access behavior applies.

## Troubleshooting and verification

- **Chrome missing:** install Chrome, then retry `/browser start`. A coding session
  remains usable without it.
- **Connection ended:** inspect any uncertain side effect, stop and start the
  browser, and list pages again. Do not replay a form submission blindly.
- **Page list unavailable or malformed:** refresh browser status before
  continuing. Cached tabs cannot authorize an action or annotation when the
  refresh lacks page metadata. If an action was already sent, inspect its result
  before requesting another operation; a failed verification cannot undo it.
- **Click reports failure with an open dialog:** the click may have succeeded.
  Inspect and handle the dialog before choosing another action.
- **Wrong account:** check `/browser status`; a session profile does not inherit
  personal Chrome logins. Choose an appropriate mode explicitly.
- **Profile in use:** stop the other browser using that named profile, or choose a
  different profile. Do not delete Chrome lock files to force concurrent use.

`npm run test:browser` exercises real headless Chrome on local fixtures and then
the native Harness tool/approval/image pipeline, including handoff and resume
across turns, without a paid model or external account. The real Chrome fixture
simulates a manual edit during the pause and verifies it after resume.
The WebMCP fixture exercises explicit site and Developer grants, two independently
counted server-side writes, same-URL reload and changed-definition refusal, direct-navigation denial,
and output withholding after a cross-origin redirect or in-flight revocation.
Developer and WebMCP calls wait on fixture responses while permission is revoked;
their results are withheld without replaying the operations. Additional cases hold
an actual Chrome read result, then navigate to another granted origin and revoke
the source grant, or close the page before delivery. It requires Chrome 150+.
Set `DSCODE_TEST_CHROME` to an absolute Chrome executable if necessary.
Normal unit tests do not require Chrome. `/doctor` does not perform this browser
exercise; a healthy general doctor report is not browser verification.
The Harness probe uses scripted model responses. It verifies the tool pipeline,
not a real model's success rate on long tasks. External account login, Chrome's
interactive auto-connect consent and comparisons against Codex are not automated
by this suite.

## Measure multi-step task performance

From a source checkout, run `npm run eval:browser -- --self-test` to verify the
evaluation pipeline without an API key. It drives the real DSCODE agent and Chrome
with fixed tool responses, marks the report as scripted, and records no model
quality score.

For a live DeepSeek evaluation, set `DEEPSEEK_API_KEY` locally and run:

```bash
npm run eval:browser -- --model deepseek-flash
```

To evaluate a saved custom service, use its `custom-…` ID from
`~/.dscode/providers.yaml` and an explicitly configured model:

```bash
npm run eval:browser -- --provider custom-YOUR-ID --model your-model-id
```

The evaluator snapshots that model's API format, context window, output budget,
thinking setting and image capability. It uses the same custom adapter as DSCODE,
including Chat Completions, Responses and Anthropic Messages. Credentials resolve
from the native shared credential store or its environment override. To use another
environment variable for this run, pass `--key-env VARIABLE_NAME`; never pass the
key value as an argument. Services configured with authentication `none` need no
key. `--providers-file /absolute/path/providers.yaml` selects another version-one
provider configuration without changing the saved services. `--thinking` is a
DeepSeek-only option; custom services use the saved model setting.

Invalid configuration or missing credentials stops before launching Chrome or
creating a report. Keys are passed to the isolated Host through its environment,
excluded from configuration snapshots, and redacted if echoed in recorded text.
Custom endpoint requests still incur whatever usage charges that service applies.

The three disposable local tasks cover a multi-page reservation form, reading a
random code in a second tab, and handling a dialog after a successful write.
They use a fresh headless Chrome profile. Each task must submit the right values
exactly once, read a random server-issued receipt, preserve the result tab and
finish within budget. An independent server-side check scores the result; an
agent's claim of success does not pass a task. The benchmark permits browser UI
tools on its loopback website; JavaScript evaluation, shell, files and external
websites are outside its tool surface. Fixture actions are preauthorized, so
approval counts measure dispatch rather than human approval latency.

Reports default to a new directory under `artifacts/local/`. `report.md` lists task
outcomes, elapsed time, model/tool calls, tool errors, handoffs and duplicate
submissions. `results.json` contains the independent checks and server state;
`traces.jsonl` contains browser tool activity. `manifest.json` records the model,
provider, endpoint, effective model settings, source hashes and budgets. Existing report directories are never overwritten.
Interrupted or incomplete runs retain partial evidence without a quality score;
provider/runtime errors also suppress the aggregate score.

Use `--cases reservation,reference,dialog`, `--max-calls 30`, `--max-tools 45`,
`--case-timeout-ms 240000` and `--call-timeout-ms 60000` to select tasks or bound a
run. Limits apply per task. Live evaluations incur normal model usage charges.
Handoffs are counted but need a person and are not completed automatically.

This small DOM task suite does not measure visual accuracy, production login,
real-site reliability or parity with Codex. Its scripted self-test cannot replace
live-model runs. No live-model score is implied by `npm run check` or CI passing.

The terminal uses a separate Chrome window, including user-shared tabs in
extension mode. It has no embedded preview pane or visual annotation UI. DOM actions, screenshots,
DevTools debugging, persistence and handoff use the browser tools described here.


## Experimental Desktop preview and annotations

The local browser bundle targets the official DeepSeek Harness Host and its
shared Web/Desktop sidebar. Build for the version displayed by your application:
`node scripts/build-browser-desktop.mjs 0.2.0-rc.2` for the official macOS download
verified on 2026-10-06, or `node scripts/build-browser-desktop.mjs 0.2.1-alpha.1`
for the newer source/npm runtime. Omitting the version selects 0.2.1-alpha.1.
The private, unpublished output is `artifacts/desktop/browser`; its core peers
match the selected target exactly. The two versions are distinct distribution
channels, so check the installed version before choosing a target.

The shared Web client on 0.2.1-alpha.1 and the official macOS Apple Silicon
Electron app on 0.2.0-rc.2 have been exercised with an isolated local fixture.
The macOS app was launched from its signed disk image. For this browser-only
bundle, persistent installation and upgrades remain unverified; the combined
package below has a separate native installation check. Windows and live-model
visual understanding remain unverified. This bundle
contains browser integration only. The complete DSCODE terminal preset still uses
its existing runtime.

In **Browser preview**, **Start browser** records readable connection and tab
status in the conversation. Explicit `/browser start --json` commands retain
their machine-readable output. You can also enter complete commands such as
`/browser handoff 2`, `/browser resume` or `/browser tabs --json` in the Desktop
composer. They run as user commands and record results without starting a model
turn. Invalid arguments produce a command error; these commands do not accept
attachments. **Stop browser** ends this session's browser
connection, clears the preview and keeps the unsent annotation. It remains
available during startup, capture, tab refresh and annotation requests; pending
permission changes finish first. Earlier responses cannot restore stopped
pixels or clear the draft. Start again and capture a fresh image before sending.
Stop uses the same browser ownership and persistent-profile rules as
`/browser stop`; it cannot recall an annotation already delivered to the agent.

An active handoff appears as **Waiting for you**, with the manual step and a
**Resume browser control** button. While visible, the pane checks the Host's
saved connection, handoff state and site permissions every 2.5 seconds when no other preview
operation is pending.
These checks do not contact Chrome, capture images or send model messages.
Hiding the pane stops them; **Refresh tabs** also reads the current state.
Stopping the browser elsewhere, including through `/browser stop`, clears the
old screenshot, selected point, tab selection and handoff notice on the next
idle check. The annotation draft stays available. Start or reconnect the browser
and capture a fresh preview before sending it.
If **Refresh tabs** observes disconnection first, it applies the same cleanup
and keeps the draft, even when the response includes historical tabs or a handoff.

During the pause, old pixels and the selected point are cleared, automatic refresh stops, and capture
and annotation sending are disabled. The annotation draft remains editable.
Complete the step in Chrome, then resume. Resuming records the user command in
the conversation and reloads tabs while preserving the draft, even if Chrome
restarted and a different tab is selected. Capture a fresh image and select a
point before sending. A failed resume leaves the handoff visible for retry.
Resuming only returns browser control; ask the agent to continue when ready.

Start the current session's browser, select a tab and
choose **Refresh preview**. The image comes from the Chrome page controlled by
the agent. Existing site permission is required. **Refresh while visible** polls
while the pane is visible and pauses when you select an annotation point. These
refreshes do not send messages to the model. A successful capture also updates
the selected tab address and reloads site permissions, so permission controls
follow the captured site after navigation. The fitted view leaves room for the
annotation controls; **Expand image** enlarges it for closer inspection.

PNG previews support up to 12 MiB of encoded image data. Large screenshots remain
available inline even when Chrome MCP also saves a temporary file; explicit
`take_screenshot` file exports stay file-only. If a preview exceeds the limit,
reduce the viewport and capture again. Model input may be resized or re-encoded
by the attachment pipeline to fit the selected provider's image budget.

The **Site permissions** summary shows the last loaded access decision. Expand
it to see the selected HTTP(S) origin and permission controls. These controls
start collapsed to leave more room for preview and annotation. **Allow this session** lasts until that browser stops;
**Always allow** saves access; **Block site** denies access and removes its
Developer grant. **Forget decision** clears both the saved decision and the
temporary grants for this origin in every session. To replace a saved allow or
block with temporary access, forget
the decision first. Selecting a tab does not grant access. Blank tabs have no
site controls.

Expand **Developer access** to enable or disable Developer mode globally and
grant or revoke it for the selected origin. Both the global mode and the site's
Developer grant are required, in addition to ordinary access. Editing a Developer
grant preserves temporary ordinary access. These controls use the same rules as
`/browser site` and `/browser developer`; tool-action approvals still apply.
The visible idle pane also reloads decisions changed elsewhere. A change to the
selected origin's access, temporary grant, Developer grant or global Developer
mode clears the old preview and selected point while keeping the draft. Changes
to other origins leave the current preview intact. **Refresh tabs** reloads
decisions immediately. Changing permissions through the sidebar clears
the preview and annotation point, stops automatic refresh and preserves typed
comment text. Permission controls remain available while a capture, tab refresh or
annotation request is pending. Responses from before a permission change cannot
restore the old image or access display, or clear the retained draft. Tabs
can be refreshed after the permission request settles even if the older request
has not returned; its late completion cannot unlock or overwrite a newer request.
An annotation already delivered to the agent cannot be recalled. Capture a fresh
image before sending. Permission controls were
exercised in both the shared Web client and the official macOS Electron 0.2.0-rc.2
window, including a narrow sidebar and a fresh image annotation after reauthorization.
These checks used disposable local fixtures and a scripted model.

Click the image, or use Tab to focus it and press Enter or Space to select its
center. Arrow keys move the point one screenshot pixel; hold Shift to move ten
pixels. Escape clears the point without clearing the draft. The selected pixel
coordinates appear below the image and are announced to assistive technology.
Keyboard selection follows the same expiry and pending-request restrictions as
mouse selection. Enter a comment and choose **Send annotation** to queue a user
message in the current session with the captured image, page URL, capture time
and pixel coordinates. You can keep editing while a send or tab refresh is
pending. Its completion clears only a draft that has not been edited since the
request started; newer text remains for a fresh screenshot and annotation point.
The image records past pixels; the agent must inspect the
live page before acting. Each capture can be sent once and expires 60 seconds
after the screenshot request starts. Time spent waiting for Chrome, transferring
the image and checking the page counts toward that limit; a capture that already
expired when it returns is refused. At expiry, the panel labels the image as expired, removes the selected
point and disables sending while retaining the typed draft. Choose **Refresh
preview** and select a fresh point to send it. Refresh after navigation or a
browser reconnection as well.
Handoff and revoked site permission prevent sending. A model that accepts only
text receives an image placeholder; the image remains stored in the conversation.
The send confirmation states when the model will receive text only, including
when model metadata is unavailable and image input cannot be confirmed.
Owned tabs used for preview are retained for inspection. Hiding the panel keeps
the current session's unsent text and selected tab in memory, but clears the
preview and point and stops automatic refresh. Reopening requires a fresh
capture and point before sending. Switching sessions or closing the pane clears
the draft; drafts do not survive an application reload. A send already dispatched
still belongs to its original session; its acknowledgement clears only text that
has not been edited, including after reopening the panel. Refreshing the tab
list clears the annotation point if its page closed or navigated. Navigation
within the same tab (including URL fragment changes), a same-URL reload or an
embedded-document change clears the old image and point while keeping the
comment draft. Refresh the preview and select a new point before sending it.
Choosing another tab or falling back to another tab after closure clears the
previous tab's draft. Text written before any tab is selected is kept when
starting the browser or refreshing an empty list selects the first tab. Capture
that tab and select a point before sending the retained text.
If a preview request fails, automatic refresh stops and the captured image and
selected point are cleared. The typed comment remains available for a fresh
capture. Revoking sharing while an annotation is awaiting image storage or model
metadata prevents that annotation from being queued. Before enqueueing, DSCODE
refreshes the observed tab list and rechecks the browser connection, page URL,
document identity, permissions, cancellation and the 60-second expiry. If the
tab closed, moved to another URL or reloaded during those waits, capture it
again before sending. The check includes iframe documents, including cross-site
and nested frames: reloading, adding or removing one invalidates the old preview.
Captures also require the same document set before and after the screenshot.
Document identity comes from Chrome's frame loaders, without page JavaScript or
Developer access. An unavailable or changing frame tree prevents capturing or
sending a preview. DOM-only updates within existing documents are not identified
by this check, and an external navigation can still occur after the last browser
observation. The annotation continues to describe past pixels.

This panel uses DSCODE's separate Chrome connection. The official sidebar's
independent browser webviews are not controlled by these tools. Extension
transport has been verified with native Desktop Host pairing, screenshot and
annotation endpoints. The combined rendered macOS panel and extension transport
also passed an isolated local fixture: point selection pauses refresh, sending
delivers one annotation with its image, and revoking sharing clears the preview,
stops refresh and preserves unsent comment text. This used the signed 0.2.0-rc.2
app, a disposable Chrome for Testing instance and a scripted model; ordinary
Chrome toolbar installation and live-model understanding remain unverified.

### Install the experimental combined Desktop package

The source checkout can also package the DSCODE agent preset, custom-model
and account settings, browser preview, durable session communication, cross-session
memory and opt-in task scheduling together. Ordinary builds remain private;
the separate [release process](hub-distribution.md#desktop-release-candidate-and-publication)
qualifies a public candidate for 0.2.0-rc.2. The Desktop preview is published on npm as
`@toddzheng024/dscode-desktop@0.7.33`. The package does
not yet include all DSCODE Host services. Its experimental
[native Computer Use adapter](computer-use.md) has passed helper and lifecycle
checks; window observation, screenshots and input await qualification with
macOS Accessibility permission.
Choose this package or the browser-only bundle; enabling both duplicates their
browser services.

The Desktop plugin's package name is `@toddzheng024/dscode-desktop`. It also
includes [Plugin Hub](plugin-hub.md) for community discovery and installation
through the official manager. The earlier private
`@toddzheng024/dscode-desktop-preset-probe` must be removed before installing
this package; both register the same DSCODE components. Back up your Desktop
state first. A separate macOS Desktop 0.2.0-rc.2 migration check preserved
sessions, credentials, configuration and user patches when removing the old
name and installing the formal package.

DSCODE sessions in the same Desktop state directory can discover session cards,
read other active DSCODE root sessions, send requests or notifications, and reply
through the production session bridge. `/session`, `/mailbox` and `/tasks` show
the endpoint, mailbox and communication history. Deferred notes wait for a
natural turn; reading or resuming a session does not wake them. See
[Session communication](session-communication.md) for delivery modes and budgets.
Cross-session memory uses the same extraction and evidence store as the terminal.
`/memories` controls reading, background generation and cleanup in DSCODE sessions;
native Standard sessions cannot modify this store and do not receive its prompt
or retrieval tool. See [Memory](memory.md#experimental-desktop-package) for state
directory, restart and removal behavior.

The terminal activity-line presentation is not included in this Desktop package.
The ordinary native Standard preset is excluded from DSCODE root discovery;
subagents inherit their parent's task budgets and are not independent targets.

Desktop and a normal DSCODE terminal installation usually use different state
directories. For external CLI access, copy the `--home` option printed by
Desktop's `/session`, for example `dscode sessions --home /path/to/desktop-home`.
This requires the DSCODE CLI separately; installing the Desktop package does not
install the terminal launcher. A shared model credential file does not make
sessions in different state directories discoverable to each other.

Build from a checkout whose dependencies have been installed. Use the exact
version shown in **About DeepSeek Harness**; currently accepted build targets
are `0.2.0-rc.2` and `0.2.1-alpha.1`. For the verified macOS application:

```bash
npm install --prefix .research/desktop-runtime --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.0-rc.2
node scripts/pack-desktop-preset.mjs .research/desktop-runtime
```

The command prints an absolute `.tgz` path under `artifacts/desktop/packages`
and writes a neighboring JSON receipt with its SHA-256, package identity and
target runtime. The filename includes the runtime version and content hash.
It does not install or publish anything, and it leaves the terminal runtime
unchanged.

The first build downloads the lockfile-pinned file-lock library and its four
macOS/Linux ARM64/x64 prebuild archives. SHA-512 verification precedes extraction;
later builds reuse the verified cache under `artifacts/desktop/native-cache`.
These dependencies and their licenses ship inside the tarball, avoiding the
bundled pnpm 11.7 upgrade hang when it fetches foreign optional prebuilds after
reporting completion. No dependency installation scripts run during packaging.
Including a platform's binary does not establish Desktop qualification on that
platform; the tested application remains macOS Apple Silicon.

The package also ships DSCODE's `apply_patch` helper for standard unified diffs.
DSCODE's persistent shell, child shells and fresh `shell_retry` calls resolve this
helper before any same-named command on the inherited PATH. `apply_patch --check`
validates without writing. This setup leaves the Desktop Host's global PATH and
native Standard shell providers unchanged; shell sandbox and approval rules still
apply.

Once a version has been published, **Plugins → Add plugin** also accepts
`@toddzheng024/dscode-desktop@<version>`. Pin the version whose release notes
match your Harness runtime. The `preview` npm tag follows the current Desktop
preview. For archive installation, download the matching `.tgz` and `.sha256`
from [GitHub Releases](https://github.com/qiz029/dscode/releases) and verify it
with `shasum -a 256 -c <downloaded-file>.tgz.sha256` before installing. Dependency
resolution still needs network access.

To install through the official interface, open **Plugins → Add plugin**, enter
the absolute `.tgz` path, install it and choose **Enable now**.

For CLI installation, open the application once to initialize its Desktop
profile, then fully quit it. Use its bundled command, adjusting the application
path and replacing the package placeholder with the printed tarball path:

```bash
desktop_dsh='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
desktop_package='/absolute/path/printed-by-pack-command.tgz'
"$desktop_dsh" plugin --profile desktop add "$desktop_package" --ignore-scripts
```

Reopen Desktop, choose **DSCODE** for a new session, and configure a model under
**Settings → DSCODE models**, or connect a supported account under
**Settings → DSCODE accounts**. Browser preview is available in the right sidebar.
**Settings → DSCODE schedules** manages tasks for an open DSCODE session and
explicitly enables or stops delivery. Its launch preference is saved; Desktop
must remain open to deliver tasks. See [Desktop scheduling](triggers.md#experimental-desktop-scheduling)
for restart, removal and permission behavior, and current qualification limits.

The account page saves or removes the shared OpenRouter API key. Changes also
affect terminal sessions and native routes reading that same credential file;
environment-owned keys remain read-only. The saved key is never returned to the
form. Choose **DSCODE OpenRouter** in the model picker for DSCODE reasoning
controls, including Ultra on supported models. The native OpenRouter route
remains available separately.

For Grok, run `grok login` in a terminal and refresh the account status. DSCODE
reads `~/.grok/auth.json` without changing or refreshing its tokens. For OpenCode
Go, use **Sign in to OpenCode Go**; the browser consent page identifies the
OpenCode CLI client used by the existing DSCODE login flow. The page shows
pending login status and supports cancellation and local sign-out. Choose
**DSCODE OpenCode Go** after signing in. Native OpenCode Go configuration remains
separate. DeepSeek account and API-key configuration use the native settings.
Account sign-out does not revoke the remote OpenCode token; see
[OpenCode Go](opencode-go.md) for login behavior and limits.

Background login polling preserves a failed action's error and any unsaved
OpenRouter key. A polling failure appears separately; recovery clears that
refresh error without hiding the action error. A successful key save clears
the key field. Polling leaves editing enabled; saving during an in-flight status
request waits for that request and then applies the save once.

These routes share DSCODE's production adapters and credential store. The
Desktop package retains the native default web-search provider; registering
DSCODE's routed search does not switch that default.

For an upgrade, fully quit Desktop and repeat the `add` command with the new
tarball. A running Host needs a restart to load replaced package code. A Desktop
runtime upgrade requires rebuilding the package for that exact runtime; the
native installer rejects incompatible peers.

To remove this experimental package, fully quit Desktop and run:

```bash
"$desktop_dsh" plugin --profile desktop remove @toddzheng024/dscode-desktop --config.ignore-scripts=true
```

On macOS Desktop `0.2.0-rc.2`, the combined package's native installation,
upgrade, rejection of an incompatible update, removal and reinstallation passed
an isolated lifecycle check with scheduling enabled. Its saved preference, task
definition and pending job survived; delivery resumed after upgrade and
reinstallation. Removing the package withdrew its scheduling and account RPCs.
The scheduling form's rendered interaction has separate qualification limits
linked above.
Model configuration, credentials, browser permissions, session files, deferred
mailbox messages and the user profile patch were preserved; an existing session
resumed after upgrade and after removal followed by reinstallation. Retrying the
same message key retained its identity. A deferred note stayed asleep through
these restarts and was delivered once on the next user turn.
The check also continued the same named child after upgrade and reinstallation.
Its worktree files survived, and its native shell ran in that original worktree.
A question waiting on the parent survived upgrade; replying resumed the child
and cleared its waiting indicator. Cold child names stayed reserved.
Removal withdraws the DSCODE preset and tools while retaining their data. Reinstall
a matching package to use that preset again. This check does not qualify Windows,
an in-place upgrade of the official application, or real-model visual quality.
