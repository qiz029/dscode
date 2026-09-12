# DeepSWE real-repository pilot

This adapter runs public [Datacurve DeepSWE](https://github.com/datacurve-ai/deep-swe) v1.1 tasks through [Pier](https://github.com/datacurve-ai/pier). Pier provides the task's isolated `/app` checkout and its separate, unmodified verifier. The model-facing loop runs on the host with the pinned DSH `BasicCompactionEngine` and `ToolResultPruner` already used by `eval/continuation/`; its only tool executes shell commands in Pier's agent container. The reference solution and held-out verifier are never sent to the model.

This is an adapted agent configuration, **not** DeepSWE's leaderboard `mini-swe-agent` configuration or the complete DSCODE CLI. Report task verifier reward, compaction count, peak prompt tokens, steps, and provider errors separately. A run with zero compactions provides no comparison of compression quality.

The default policy is `shipped-80` from `eval/compaction/policies.json`: trigger at 80% of the configured 1,000,000-token window, retain 16% recent verbatim history, and use the native DSH summary and tool-result pruning. The optional `threshold_ratio=0.4` arm changes only the trigger to 40%; retention remains 16%. DeepSeek usage reports uncached input and cache-read input separately; peak prompt and total input must include both. The first pilot started before that correction was loaded, so its separate `usage-analysis.json` is authoritative for prompt usage. Provider model aliases may change remotely.

Use `--ak context_window=128000` to repeat a task at a smaller window while keeping the same 80%/16% policy. This is a separate configuration and must be reported separately from 1M runs.

The first two local runs are summarized in [`../results/deepswe-official-80/analysis.md`](../results/deepswe-official-80/analysis.md) when those ignored artifacts are present.

## Paired 1M threshold comparison

With `DEEPSEEK_API_KEY` already loaded in the host shell, run the same three official tasks in each arm. Pier's `--sample-seed 0 --n-tasks 3` fixes the task selection and order. The two invocations must use the same checkout, adapter version, step limit, and model. Docker Desktop needs enough memory for the chosen concurrency; `--n-concurrent 1` is safe for an approximately 8 GB allocation.

```bash
PYTHONPATH="$PWD/eval/deepswe" eval/private/.venv/bin/pier run \
  -p eval/private/deep-swe/tasks --sample-seed 0 --n-tasks 3 \
  --agent-import-path pier_agent:DSHCompactionAgent \
  --model deepseek/deepseek-flash \
  --ak context_window=1000000 --ak threshold_ratio=0.8 \
  --jobs-dir eval/results/deepswe-1m-80-vs-40-seed0 \
  --job-name threshold-80 --n-concurrent 1

PYTHONPATH="$PWD/eval/deepswe" eval/private/.venv/bin/pier run \
  -p eval/private/deep-swe/tasks --sample-seed 0 --n-tasks 3 \
  --agent-import-path pier_agent:DSHCompactionAgent \
  --model deepseek/deepseek-flash \
  --ak context_window=1000000 --ak threshold_ratio=0.4 \
  --jobs-dir eval/results/deepswe-1m-80-vs-40-seed0 \
  --job-name threshold-40 --n-concurrent 1
```

The official binary reward is the primary task result. Also compare F2P/P2P test counts, actual native summary count, peak prompt tokens including cache, agent steps, and errors. At 1M, the nominal triggers are 400K and 800K tokens, respectively. If neither arm summarizes, these trials do not measure compression quality even if their verifier results differ. Three tasks with one independent sample per arm are exploratory, not a leaderboard score or a statistically reliable policy ranking.

After both jobs finish, run `python3 eval/deepswe/compare.py eval/results/deepswe-1m-80-vs-40-seed0`. The comparator checks the Pier task digests, model, window, and both agent policies before writing `analysis.md` in that ignored results directory.

## Setup

```bash
git clone --depth 1 https://github.com/datacurve-ai/deep-swe eval/private/deep-swe
UV_CACHE_DIR=eval/private/uv-cache uv venv eval/private/.venv
UV_CACHE_DIR=eval/private/uv-cache uv pip install \
  --python eval/private/.venv/bin/python datacurve-pier==0.3.1
```

Docker Desktop must be running. Put `DEEPSEEK_API_KEY` in the shell environment without putting it in a Pier config or command argument. The agent container gets no API key; only the host-side model loop uses it. `eval/private/` and `eval/results/` are ignored by Git.

## Run one official task

```bash
PYTHONPATH="$PWD/eval/deepswe" eval/private/.venv/bin/pier run \
  -p eval/private/deep-swe/tasks/meriyah-explicit-resource-declarations \
  --agent-import-path pier_agent:DSHCompactionAgent \
  --model deepseek/deepseek-flash \
  --jobs-dir eval/results/deepswe-official-80 \
  --job-name seed0-first --n-concurrent 1
```

Pier writes the official `reward.json`, `ctrf.json`, logs, and job result under the named job directory. The custom adapter writes `agent-report.json`, `calls.jsonl`, and `steps.jsonl` under that trial's `agent/` directory. `node eval/deepswe/usage.mjs <trial-agent-directory>` recalculates prompt usage from the raw calls into a separate `usage-analysis.json`, preserving the original report. DeepSWE v1.1 only collects committed changes; the adapter starts a new task branch and commits any remaining final work tree after the model stops, recording this in `harness-commit.txt` and trial metadata. This does not alter the source contents. All run limits are in `agent.mjs`: 200 model steps, 250 provider calls, and a five-minute deadline per call. A task may fail before a compaction occurs.
