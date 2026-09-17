import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { GROK_AUTH_PATH, grokAuthState, minutesLeft, parseGrokAuth } from "../plugins/grok/auth.mjs";
import { parseGrokModels, setGrokModels } from "../plugins/grok/models.mjs";
import { grokSubscriptionNow, parseGrokCredits, parseGrokSettings, readGrokSubscription, setGrokSubscription, writeGrokSubscription } from "../plugins/grok/billing.mjs";
import { REPLAY_KIND, effortInfo, errorCode, mapUsage, requestBody, sseData, translate, wireEffort } from "../plugins/grok/wire.mjs";
import { GrokAdapter } from "../plugins/grok/adapter.mjs";
import { loginHint, resolveOptions } from "../plugins/grok/index.mjs";
import { PROVIDERS, pickModel, providerArgument, providerOfLabel } from "../plugins/providers/catalog.mjs";

const encoder = new TextEncoder();
async function* chunks(...parts) { for (const part of parts) yield encoder.encode(part); }
const sse = (...events) => events.map(event => "data: " + (typeof event === "string" ? event : JSON.stringify(event)) + "\n\n").join("");
const collect = async iterable => { const out = []; for await (const item of iterable) out.push(item); return out; };
const jwt = exp => "header." + Buffer.from(JSON.stringify({ exp, sub: "user-1" })).toString("base64") + ".sig";
const tool = name => ({ name, description: name, parameters: { type: "object", properties: {} } });
const conversation = [{ role: "system", content: [{ type: "text", text: "Rules." }] }, { role: "user", content: [{ type: "text", text: "Do work." }] }];
const CATALOG = parseGrokModels({ data: [{ id: "grok-4.6", name: "Grok 4.6", context_window: 500000, max_completion_tokens: 32768, auto_compact_threshold_percent: 80, reasoning_effort: "high", reasoning_efforts: [{ id: "xhigh" }, { id: "high" }, { id: "medium" }, { id: "low" }], supports_backend_search: true, compaction_at_tokens: true }] });

test("the local grok login is read as-is, and an expired one is reported instead of refreshed", () => {
  const now = Date.UTC(2026, 8, 17, 6, 0, 0);
  const entry = { key: jwt(now / 1000 + 3600), refresh_token: "refresh-1", user_id: "user-1", expires_at: new Date(now + 3600e3).toISOString() };
  const file = { "https://auth.x.ai::client-1": entry };
  const parsed = parseGrokAuth(file);
  assert.equal(parsed.token, entry.key);
  assert.equal(parsed.userId, "user-1");
  assert.equal(parsed.refreshToken, "refresh-1");
  assert.equal(parsed.expiresAt, now + 3600e3);
  assert.equal(parsed.clientId, "client-1");
  assert.equal(minutesLeft(parsed, now), 60);
  assert.equal(grokAuthState({ now, read: () => JSON.stringify(file) }).kind, "ready");
  const stale = { "https://auth.x.ai::client-1": { ...entry, key: jwt(now / 1000 - 60) } };
  assert.equal(grokAuthState({ now, read: () => JSON.stringify(stale) }).kind, "expired");
  assert.equal(grokAuthState({ now, read: () => { throw new Error("missing"); } }).kind, "missing");
  assert.equal(grokAuthState({ now, read: () => "not json" }).kind, "malformed");
  assert.equal(grokAuthState({ now, read: () => JSON.stringify({ other: {} }) }).kind, "malformed");
  assert.equal(parseGrokAuth(null), undefined);
  assert.equal(GROK_AUTH_PATH.endsWith(".grok/auth.json"), true, "the CLI owns that file, DSCODE only reads it");
});

test("the Grok catalog keeps context, detents and the media filter", () => {
  const models = parseGrokModels({ data: [
    { id: "grok-4.6", name: "Grok 4.6", description: "frontier", context_window: 500000, auto_compact_threshold_percent: 80, max_completion_tokens: 32768, reasoning_effort: "high", reasoning_efforts: [{ id: "xhigh" }, { id: "high" }, { id: "medium" }, { id: "low" }], supports_backend_search: true, compaction_at_tokens: true },
    { id: "grok-imagine-image", name: "Imagine" },
    { id: "grok-4.3", context_length: 1000000 },
  ] });
  assert.deepEqual(Object.keys(models), ["grok-4.6", "grok-4.3"], "image models stay off the agent catalog");
  assert.equal(models["grok-4.6"].contextWindow, 500000);
  assert.equal(models["grok-4.6"].maxOutput, 32768);
  assert.deepEqual(models["grok-4.6"].efforts, ["low", "medium", "high", "xhigh"], "DSCODE effort ids, in DSCODE order");
  assert.equal(models["grok-4.6"].defaultEffort, "high");
  assert.equal(models["grok-4.6"].backendSearch, true);
  assert.equal(models["grok-4.6"].compactThresholdPercent, 80);
  assert.equal(models["grok-4.6"].compactionAtTokens, true);
  assert.equal(models["grok-4.3"].contextWindow, 1000000);
  assert.equal(models["grok-4.3"].efforts, undefined, "a model without detents offers none");
});

test("the weekly credit window parses with and without a used percentage", () => {
  const weekly = parseGrokCredits({ config: { creditUsagePercent: 12.5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-16T17:44:05Z", end: "2026-09-23T17:44:05Z" }, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true } });
  assert.equal(weekly.usedPercent, 12.5);
  assert.equal(weekly.periodEnd, "2026-09-23T17:44:05Z");
  assert.equal(weekly.periodStart, "2026-09-16T17:44:05Z");
  assert.equal(weekly.periodType, "USAGE_PERIOD_TYPE_WEEKLY");
  assert.equal(weekly.unified, true);
  const quiet = parseGrokCredits({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-23T17:44:05Z" } } });
  assert.equal("usedPercent" in quiet, false, "the server omits the percentage when a period has no usage");
  assert.equal(quiet.periodEnd, "2026-09-23T17:44:05Z", "the reset time is always there");
  assert.deepEqual(parseGrokCredits(undefined), {});
  assert.equal(parseGrokCredits({ config: { creditUsagePercent: "nonsense" } }).usedPercent, undefined);
  assert.equal(parseGrokSettings({ subscription_tier_display: "SuperGrok Heavy", default_model: "grok-4.6" }).tier, "SuperGrok Heavy");
  const gated = parseGrokSettings({ allow_access: false, gate_message: "Weekly limit reached", gate_url: "https://x.ai/usage" });
  assert.equal(gated.blocked, true);
  assert.equal(gated.gateMessage, "Weekly limit reached");
});

test("the subscription snapshot survives a round trip through its state file", () => {
  const home = mkdtempSync(join(tmpdir(), "dscode-grok-billing-"));
  try {
    writeGrokSubscription(home, { tier: "SuperGrok Heavy", usedPercent: 3, periodEnd: "2026-09-23T17:44:05Z", fetchedAt: 1 });
    const read = readGrokSubscription(home);
    assert.equal(read.tier, "SuperGrok Heavy");
    assert.equal(read.usedPercent, 3);
    assert.equal(read.version, 1);
    assert.equal(readGrokSubscription(join(home, "nope")), undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a footer drawn before the first refresh still shows the last written window", () => {
  const home = mkdtempSync(join(tmpdir(), "dscode-grok-now-"));

  try {
    setGrokSubscription(undefined);
    assert.equal(grokSubscriptionNow(home), undefined, "no live state and no file is simply nothing to show");
    setGrokSubscription(undefined);
    writeGrokSubscription(home, { tier: "SuperGrok Heavy", usedPercent: 4, periodEnd: "2026-09-23T17:44:05Z" });
    assert.equal(grokSubscriptionNow(home).tier, "SuperGrok Heavy", "the file answers when the process has no state yet");
    writeGrokSubscription(home, { tier: "Written later", usedPercent: 9 });
    assert.equal(grokSubscriptionNow(home).tier, "SuperGrok Heavy", "the read is memoized for one refresh window");
    setGrokSubscription(undefined);
    assert.equal(grokSubscriptionNow(home).tier, "Written later", "the next window re-reads the file");
    setGrokSubscription({ tier: "Live", usedPercent: 1 });
    assert.equal(grokSubscriptionNow(home).tier, "Live", "the live process value wins over the file");
  } finally { setGrokSubscription(undefined); rmSync(home, { recursive: true, force: true }); }
});

test("the Grok request body carries the detents xAI accepts and nothing OpenRouter-only", () => {
  const options = { model: "grok-4.6", messages: conversation, tools: [tool("bash"), tool("workflow")], reasoningEffort: "xhigh", maxTokens: 4096, sessionId: "s1" };
  const body = requestBody(options, { entry: CATALOG["grok-4.6"] });
  assert.equal(body.model, "grok-4.6");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.reasoning_effort, "xhigh");
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.tools.map(entry => entry.function.name), ["bash"], "workflow is never offered");
  assert.equal(body.session_id, undefined);
  assert.equal(body.provider, undefined);
  assert.equal(body.messages[0].content, "Rules.");
  assert.equal(requestBody({ ...options, reasoningEffort: "ultra" }, {}).reasoning_effort, "xhigh", "Ultra rides the top detent");
  assert.equal(requestBody({ ...options, reasoningEffort: "minimal" }, {}).reasoning_effort, "low");
  assert.equal(requestBody({ ...options, reasoningEffort: undefined }, {}).reasoning_effort, undefined);
  assert.equal(wireEffort("max"), "xhigh");
  assert.equal(wireEffort("off"), "none");
  assert.equal(effortInfo("xhigh").name, "XHigh");
  assert.equal(effortInfo("ultra").description.length > 0, true);
  assert.throws(() => requestBody({ ...options, reasoningEffort: "maximal" }, {}), LlmError);
});

test("a Grok stream becomes reasoning, text, tool-call and usage chunks", async () => {
  const events = [
    { id: "gen-1", choices: [{ index: 0, delta: { reasoning_content: "Think" } }] },
    { choices: [{ index: 0, delta: { content: "Hello" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "echo", arguments: "{\"text\":" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"ping\"}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 130, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 25 } } },
    "[DONE]",
  ];
  const out = await collect(translate(sseData(chunks(sse(...events))), { model: "grok-4.6" }));
  assert.deepEqual(out.map(chunk => chunk.type), ["block-start", "reasoning-delta", "block-start", "text-delta", "block-start", "tool-call-delta", "tool-call-delta", "block-end", "block-end", "block-end", "usage", "finish"]);
  assert.equal(out[1].text, "Think");
  assert.equal(out[3].text, "Hello");
  assert.equal(out.filter(chunk => chunk.type === "tool-call-delta").map(chunk => chunk.argumentsDelta).join(""), "{\"text\":\"ping\"}");
  assert.deepEqual(out.find(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call").block, { type: "tool-call", id: "call-1", name: "echo", arguments: "{\"text\":\"ping\"}" });
  assert.deepEqual(out.find(chunk => chunk.type === "usage").usage, { inputTokens: 36, outputTokens: 5, totalTokens: 105, cacheReadTokens: 64, reasoningTokens: 25 });
  const finish = out.at(-1);
  assert.deepEqual(finish.reason, { kind: "tool-calls" });
  assert.equal(finish.replayState.response.kind, REPLAY_KIND);
});

test("errors route to the codes the harness retries on", () => {
  assert.equal(mapUsage(undefined), undefined);
  assert.deepEqual(mapUsage({ prompt_tokens: 10, completion_tokens: 2 }), { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.equal(errorCode(401, { message: "bad" }), "AUTH");
  assert.equal(errorCode(429, { message: "slow down" }), "RATE_LIMIT");
  assert.equal(errorCode(402, { message: "no credit" }), QUOTA_EXCEEDED_CODE);
  assert.equal(errorCode(400, { message: "context length exceeded" }), CONTEXT_WINDOW_EXCEEDED_CODE);
  assert.equal(errorCode(503, { message: "later" }), "SERVER");
  assert.equal(errorCode(undefined, { message: "boom" }), "SERVER");
});

test("the Grok adapter reports the catalog context and detents", async () => {
  setGrokModels(CATALOG);
  try {
    const adapter = new GrokAdapter({ options: () => resolveOptions({}), ensureModels: async () => {}, resolveToken: async () => "token" });
    assert.equal(adapter.providerInfo("grok").name, "Grok");
    assert.deepEqual((await adapter.listModels("grok")).map(model => model.id), ["grok-4.6"]);
    const info = await adapter.resolveModel("grok", "grok-4.6");
    assert.equal(info.context.contextWindow, 500000);
    assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ["low", "medium", "high", "xhigh"]);
    assert.equal(info.reasoning.defaultEffort, "high");
    assert.equal(info.defaultMaxTokens, 32768);
    const unknown = await adapter.resolveModel("grok", "grok-9");
    assert.equal(unknown.context.contextWindow, 131072);
    assert.equal(unknown.reasoning, undefined);
  } finally { setGrokModels({}, 0); }
});

test("the grok provider joins the catalog and the switch helper", () => {
  const spec = PROVIDERS.find(provider => provider.id === "grok");
  assert.equal(spec.name, "Grok");
  assert.deepEqual(spec.aliases, ["grok", "xai", "x-ai"]);
  assert.equal(spec.credentialRef, "GROK_CLI_TOKEN");
  assert.equal(spec.defaultModel, "grok-4.6");
  assert.equal(providerArgument("xai"), "grok");
  assert.equal(providerArgument("grok-4.6"), null, "arguments are matched exactly and never echoed");
  assert.equal(providerOfLabel("grok/grok-4.6"), "grok");
  const rows = [{ provider: "grok", model: "grok-4.6", reasoning: { efforts: [{ id: "high" }] } }];
  assert.deepEqual(pickModel(rows, "grok", "deepseek-official/deepseek-flash", "max"), { row: rows[0], effort: undefined });
  assert.equal(loginHint({ kind: "missing" }).includes("grok login"), true);
  assert.equal(loginHint({ kind: "expired" }).includes("grok login"), true);
  assert.equal(loginHint({ kind: "malformed" }).includes("grok login"), true);
});
