# Session footer

## Experimental Desktop usage

The experimental combined Desktop package adds **Open right sidebar → Session
usage** for the selected open DSCODE session. It reads the same local ledger and
live token meter as the terminal footer. The panel shows recorded cost, model
calls, pending calls, context percentage, input cache share, smoothed request
speed, session-average speed and the latest 50 per-turn cost estimates. The
session total includes all recorded turns, attributed child calls and background
work. Cost outside recorded turn windows is shown separately. Known cached
provider balance or subscription figures are included; opening or refreshing the
panel does not request new account data or start a model turn.

The panel refreshes once per second while visible and clears its state when
hidden or switched to another session. Refresh failures clear the old figures
and display an error. Standard sessions and closed sessions have no DSCODE usage
view. Unknown values remain explicit; `+` marks a partial cost and pending calls
have not settled. Prices, historical gaps and speed definitions follow the same
rules below. The panel displays a configured cost budget but does not introduce
a Desktop spending enforcement mechanism.

## Terminal presentation

The footer keeps session identity and permissions on row 1. Row 2 places TPS, session-average TPS, context and the loaded skill count on the left; session cost, DeepSeek balance and peak/off-peak marker, optional last-turn cost, and cache rate form one group aligned to the right edge. Space separates the two groups, with `·` inside each group. When they cannot share a row, the financial group moves intact to a right-aligned third row. At narrow widths the average TPS yields before current TPS, context and skills; the metrics no longer disappear wholesale below 48 columns. Extremely narrow terminals may omit the optional last-turn cost and clip the financial group with an ellipsis. The composer and IME cursor account for the actual footer height. On the Grok and OpenCode Go subscription routes the money figure is the plan's usage instead of a cost: Grok's weekly credits, and Go's share of its five-hour, weekly and monthly caps (see [OpenCode Go](opencode-go.md)).

- **current**: a normalized exponential moving average (EWMA) of the root agent's completed request rates. Each request's rate is its provider-reported final `outputTokens` / its full request duration, including the first-token wait. Each valid completion gives the new rate weight 1 and multiplies all older weights by `0.5`; the displayed rate is the weighted sum divided by the weight sum. Thus newer requests always carry more weight, and each newer valid request halves every older sample's weight. The first valid request initializes the reading. Idle time, tools and in-flight requests do not decay it; aborted or invalid/missing-usage calls do not update it. Starting a request with a different provider, model or reasoning effort clears the history; that route shows `--` until its first valid completion. Text lengths never estimate tokens, and auxiliary and child calls do not enter the root's rate. A resumed session starts without a smoothed reading. This is a smoothed request rate, not instantaneous output or a fixed time window.
- **average**: settled assistant output tokens for the current root session / total LLM call time for those requests (each step from request start to settle, including the wait for the first token). Tool execution and idle time between two user turns do not count; child agent output does not count; a request still in flight does not count before it settles. If any message lacks exact usage or its step-start event, the figure shows `--`.
- **context**: the current session's token-meter context estimate / the model context window, recomputed after compaction. It covers the currently visible context; extra text an adapter injects temporarily is not part of the local estimate. If live telemetry is unavailable, the footer falls back to the latest recorded prompt usage, including cache reads and writes, against the recorded model window. That fallback describes the last request rather than estimating subsequent output or edits. Before any usable reading exists, it shows `--`.
- **session**: a dollar estimate accumulating the recorded model calls of the current session and its child agents, including compaction, title generation and auto review. A resumed session keeps the accumulated value; a new session starts over. Jev Decisions attempts are also included: a reported non-negative billed cost is used directly; a missing or invalid cost makes the total partial. MCP/API service costs outside the model are not included.
- **cache**: cumulative cache-read tokens / cumulative all input tokens, weighted by tokens, not a request hit rate and not the average of per-request percentages.

`+` means only part of the cost is computable; `--` means the data or the price is unknown; `…` means a request has not finished. The cost of the current request is not advanced before usage arrives. The footer refreshes every second and makes no extra model request.

A small activity indicator beside the first TPS figure spins while the main model request is waiting or streaming. It stops when that request completes or aborts, including while tools are running. With animations disabled, an active request shows a static circle. The slot stays reserved while idle so the numbers do not shift. The indicator follows the footer's one-second refresh; its animation never interpolates or alters the TPS number, which changes only when a completed request supplies valid usage.

`current` and `average` are each coloured by their own TPS: yellow below 75, green from 75 to below 150, blue from 150 to 250 inclusive, purple above 250. The cache rate is coloured the same way on its own bands: red below 90%, yellow to 95, green to 98, blue above. An unknown `--` keeps the normal colour; labels, units and separators never change colour with the figure.

Prices use a 2026-09-11 snapshot of the [official DeepSeek price list](https://api-docs.deepseek.com/quick_start/pricing/), distinguishing peak and off-peak by request start time and matching only supported official providers/models. A price update means updating `plugins/session-metrics/pricing.mjs`; the figure shown is not a vendor invoice. An older session can recover part of its calls from the log, but historical review/title/child-agent usage may be incomplete, which is why it is marked as a partial total.

Records are stored in `$DSH_HOME/session-metrics/` and contain only metadata such as model, times, usage and cost, never prompts or credentials. Every model call writes one `start` row (`time` is the request start, `purpose` is `agent`, `compaction`, `session-title`, `review`, `memory`, `session-card` or `doctor`) and one `end` row; an `end` row's `time` is still the start time (used for pricing), `endTime` is when the stream finished, and `firstTokenTime` is when the first text, reasoning or tool-argument increment arrived (omitted when there was no output), so a single LLM call takes `endTime - time` and its first-token latency is `firstTokenTime - time`. Calls for automatic permission review, code review, memory extraction, session cards and `/doctor` do not carry a `sessionId` in the request (avoiding session-log delivery, cache affinity and agent-only prompt rewriting) but are attributed through async context to the session that made them; memory extraction and consolidation keep the initiating session captured at run start, even if another session starts or that owner closes. Manual `/memories run` and `note` use their caller; see [Memory](memory.md) for periodic-run attribution. A call that cannot be attributed to a session (such as the `dscode doctor` command line) is not recorded. The raw session log gains no custom events.
