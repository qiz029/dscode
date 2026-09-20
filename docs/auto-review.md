# Auto permission review

The repository and the complete install package ship the `dscode-auto-review` plugin. It calls an independent LLM request for actions that need approval and answers allow, deny or hand-to-human; it keeps the workspace-write sandbox and the existing network behaviour. It is not Codex's built-in reviewer, and it is not a security proxy through which every operation passes.

## Usage

Restart `dscode` to load the plugin. New sessions default to auto; an existing session and a saved default keep their value, and either can be switched explicitly:

```text
/permission auto
/permission ask
/review-usage
```

Both `auto` and `ask` are `workspace-write + approval: ask`; the difference is that the first lets the plugin review before the request. The underlying `never` still refuses approval requests and does not mean automatically allowed. Computer Use application authorisation and sensitive-action confirmation always go to the user.

## What triggers a review

- Workspace file changes, ordinary shell, and curl/CLI network access under existing permissions: no new approval and no review model call.
- A shell/file tool asking for additional permission: enters the native approval path, and in auto mode the reviewer decides first.
- Chrome's explicitly read-only tools `list_pages`, `take_snapshot`, `get_console_message`, `list_console_messages`, `get_network_request`, `list_network_requests`, `performance_analyze_insight`: no new approval.
- Every other `mcp__*` tool: enters approval before execution, including Chrome navigation, clicking, script execution, upload and screenshots. An unknown MCP tool is not waved through because its name sounds read-only.
- A request another plugin raises through the native approval interface: handed to a human when it cannot be bound to the actual tool arguments about to execute.

This is not a global network firewall. A `curl POST` that was already allowed, or an external operation through an authenticated CLI, does not trigger auto by nature. The actual contents of a script inside the shell are not read by the reviewer either. Equivalent detours across tools are constrained by the review instruction, and no complete semantic recognition can be claimed; an identical action denied earlier in this turn is denied directly while there is no new user instruction.

## Input and authorisation

Before a tool executes, the plugin records the immutable arguments about to run and binds the review request to the agent and the call ID. Each allow applies to that one call; there is no permanent authorisation cache. The review model has no execution tools and does not receive the main agent's reasoning or a whole tool output.

The review input is the concrete tool arguments, the cwd, the direct user messages and the most recent denial reason. It does not additionally read `.env`, configured credentials or secret files. Common credential formats are redacted; when the action arguments look like they contain credentials the request goes to a human instead of asking a model to approve a distorted action. That detection is not complete DLP and cannot guarantee every arbitrary secret format is recognised, so do not paste credentials into arguments or user text.

An action JSON over 12,000 characters, all direct user text over 8,000 characters, or a missing direct user instruction is handed to a human: the authorisation constraint is never trimmed away just to force a review. A summary the agent generated itself is never taken as user authorisation. A long session may therefore hand more requests to a human, which is an explicit limit of this first version.

## Model and cost

By default it uses the provider/model the agent actually requested most recently, but with an independent, condensed review context. `config/harness.local.yml` can point at another model whose credentials are already configured:

```yaml
- id: dscode-auto-review
  config:
    provider: your-configured-provider
    model: your-reviewer-model
    timeoutMs: 30000
    maxOutputTokens: 768
    maxReviewsPerTurn: 20
```

provider/model must be set together or both left empty. Each request asks for at most 768 output tokens with a 30-second timeout; each agent makes at most 20 review model calls per turn, and beyond that requests go to a human. This call cap is not a billing cap: provider/adapter retries, thinking tokens and pricing are decided by the model configuration.

`/review-usage` shows this session's decision count, model attempts, reported input/output tokens, accumulated review time and the attempts missing complete usage. Missing usage is not treated as zero cost. A review that fails, is truncated, returns invalid JSON or times out goes to a human; when the human path is unavailable too, the native approval service refuses execution.

Three denials in a row cancel the current agent's run for the turn. An explicit denial is never silently converted into another "human allow" path; the agent receives the denial reason and the instruction not to take an equivalent detour. The user can switch with `/permission ask` and then give a new explicit instruction.

## Persistence and distribution

The permission choice is stored by native DSH session events; the native approval asked/decided records keep recording the actual outcome. The review reason, action hash, usage and elapsed time are stored separately in `.runtime/auto-review/<session-id-sha256>.jsonl` (file mode 0600). The original command, request body, review prompt and full model response are not recorded. This sidecar is the reviewer's judgement record; after a hand-to-human, the final allow/deny follows the native session approval log.

The rc.1 session reader does not accept unknown event types, so no custom review event was forced into the session log. Back up the whole `.runtime` to keep the review records too.

The complete install package from `npm run dist` includes this plugin. The official npm/Hub bundle includes the reviewer; the older `npm run release` exported only the base composition and does not replace the complete release produced by `npm run release:hub`.

## Jev fast path (optional)

The essence of auto review is choosing one answer inside a given context, which does not need a model that writes essays. With `dscode-jev` mounted, a review first asks TypeSafe Jev (through OpenRouter's alpha Decisions endpoint `POST /api/alpha/decisions`), which answers four things in **one request**:

- `choice`: `allow` / `ask` / `deny`, with per-option probabilities and a `confidence`;
- `authorized`: whether the retained instructions cover this action, target and effect included. It is scored **separately from risk**: a dangerous action the instructions asked for should score high, and a dangerous action nobody asked for should score low. Instructions almost never name a concrete command, so the question asks about the task they asked for and the anchor is written into the question too — a step they ask for directly ≥0.9, a necessary step of a stated task 0.6–0.9, possibly part of the task but optional or unclear 0.2–0.6, not covered <0.2. This score is the switch for step 2 below (handing an authorised action to the model for a deeper review);
- `score`: how hard it is to roll back if it goes wrong (0–3 bands, and it may land between bands);
- `credential_risk`: whether credentials, tokens or other secrets are involved.

The order of judgement is in code, and the **allow and deny thresholds are deliberately asymmetric** — allow is the dangerous direction, while a deny is only "please don't do this":

1. **Automatic denial**: `deny` and (confidence ≥ `autoDeny`(0.95) and `P(deny)` ≥ `autoDenyProbability`(0.9)) **or** (confidence ≥ `autoDenyCorroborated`(0.9) and at least one of `score ≥ destructiveCeiling`(2) or credential risk ≥ `credentialRisk`(0.5) already over the line). If `authorized ≥ authorizedVeto`(0.6) — that is, the instructions appear to ask for it — the automatic denial is **vetoed and turned into a hand-to-human**: the cost of one wrongly denied action is work the user asked for not getting done, without even a prompt.
2. **Hand to the deeper model review when authorized**: credential risk ≥ 0.5, `score ≥ 2`, a `choice` other than `allow`, or confidence < `autoAllow`(0.85) — all four guard only the allow direction and none of them constitutes a denial. If `authorized ≥ authorizedVeto`(0.6) — the instructions appear to ask for it — they no longer go straight to a human but return `defer`, leaving the reviewer model to decide with the full pending arguments and the retained instructions in view: Jev's scores are coarse, and this deployment already allows ordinary network access and lets a CLI use credentials it stored itself. When the reviewer itself rules `human`, a human is still consulted, and a `defer` is never treated as an allow.
3. **Automatic allow**: `allow` with confidence ≥ `autoAllow`(0.85) and step 2 not triggered.
4. Everything else (an `ask` below `authorizedVeto`, not confident enough, over the line but not denied) → hand to a human.

One `defer` leaves two rows in the audit: first Jev's own verdict and risk scores (`decision: deferred`, with `credentialRisk`, `destructive`, `authorized`), then the reviewer model's actual ruling; only an `allow` really lets the action through. In other words step 2 turns credential and irreversible risk from a "hard stop" into "a second model's judgement plus a human backstop" — a deliberate trade whose cost is that those two signals no longer veto on their own, and whose benefit is that an escalation the user explicitly asked for (for example a verification that has to leave the sandbox during a release) no longer interrupts a human every time. To restore the hard stop, raise `authorizedVeto` above 1 (or switch Jev off as below).

When Jev is not configured (no `OPENROUTER_API_KEY` resolves), is disabled, times out, errors or returns something unusable, it always returns "no verdict" and auto review continues with the original reviewer model — **a Jev failure only falls back to the old behaviour and never loosens any permission**.

The `state` sent out has only two items: the call about to execute, and the direct user instructions retained for this session; each is truncated to 8000 characters and neither contains credentials.

Configuration lives on the `plugins/jev` line: `enabled` (default true), `model` (default `~typesafe/jev-latest`), `endpoint`, `apiKeyEnv` (default `OPENROUTER_API_KEY`), `timeoutMs` (default 8000), and the thresholds `autoAllow`(0.85), `autoDeny`(0.95), `autoDenyProbability`(0.9), `autoDenyCorroborated`(0.9), `authorizedVeto`(0.6), `credentialRisk`(0.5), `destructiveCeiling`(2). Setting `enabled: false` or removing the line returns to pure model review.

Two measurements on 2026-09-17 (the same four cases, `~typesafe/jev-latest` → `typesafe/jev-1.13-20260917`, provider TypeSafe): 96–813 ms per call, about $0.000025 (output billed at 0). The first run (thresholds only, no automatic denial) gave `git status --short` → allow; `git push --force origin main` (deny 0.92 / score 2.99) and `curl --data-binary @.env …` (deny 0.98 / cred 0.94) → hand-to-human; `rm -rf ~/Documents/notes` (deny 0.90 / score 1.97) → deny. The second run (the asymmetric policy in this section) gave allow, deny (0.98 / P(deny) 0.99), deny (0.99 / 1.00) and deny (0.97 / 0.98) in order; `authorized` was 0.83 on the ordinary read and 0.03 on the three dangerous actions. **Confidence drifts between two runs of the same action** (`rm -rf` moved from 0.90 to 0.97), which is exactly why a decisive denial requires two signals to agree and why the audit record exists for tuning the thresholds.

Four more cases were measured on this calibration path on 2026-09-19 (`typesafe/jev-1.13-20260917`): a "commit and release" instruction plus running `make release` outside the sandbox → `authorized` 0.68, `defer`; the same instruction naming `make release` → 0.86, `defer`; the same instruction plus `rm -rf ~/Documents/notes` → 0.07, `deny`; "look at the test coverage" plus the same `make release` → 0.11, `human`. To repeat it, score `approvalState({ action, context })` together with `approvalQuestions()` through `requestDecisions`, then read `approvalVerdict`.

A note on thresholds: Jev's probabilities are calibrated only in the **statistical** sense, and `confidence` is not a per-call guarantee. Align the thresholds with the audit records this plugin writes (`.runtime/auto-review/*.jsonl` carries decision, source, choice, confidence, denyProbability, authorized, usage and elapsed time) rather than copying the defaults.

## Verification

`npm test` covers the review rule entry points, argument binding, cancellation, timeout, invalid responses, credential interception, the model budget, mode switching, repeated denials and stopping. `tests/jev.test.mjs` uses a mock transport to cover the request shape, answer parsing, threshold judgement, timeout and failure fallback; `tests/auto-review.test.mjs` additionally covers "a Jev verdict spends no reviewer request", "a Jev denial counts towards the consecutive denials", "Jev unavailable falls back to model review", and "when authorized Jev hands the guard to the reviewer model, while a reviewer ruling of human still consults a human".

`npm run doctor` uses a real DSH agent and tool pipeline plus the deterministic local LLM adapter to verify that an allow executes, a denial does not execute, an invalid response goes to the test human approver, usage is recorded and the session recovers. It calls no paid remote model; real-model review quality, latency and cost are still to be verified in real use. The simulated human approver exists only in the doctor test overlay.
