"""Compare two completed, paired DeepSWE Pier jobs without dropping failures."""

import argparse
import json
from pathlib import Path


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def arm(root: Path, name: str, threshold: float):
    job = root / name
    locked = read_json(job / "lock.json")["trials"]
    tasks = [(trial["task"]["name"], trial["task"]["digest"]) for trial in locked]
    if len(tasks) != 3 or len(set(tasks)) != 3:
        raise ValueError(f"{name}: expected three unique locked tasks")
    for trial in locked:
        kwargs = trial["agent"]["kwargs"]
        if kwargs != {"context_window": 1000000, "threshold_ratio": threshold}:
            raise ValueError(f"{name}: unexpected agent configuration")
        if trial["agent"]["model_name"] != "deepseek/deepseek-flash":
            raise ValueError(f"{name}: unexpected model")
    rows = {}
    for path in job.glob("*/result.json"):
        result = read_json(path)
        task = Path(result["task_id"]["path"]).name
        if task in rows:
            raise ValueError(f"{name}: duplicate result for {task}")
        report_path = path.parent / "agent" / "agent-report.json"
        reward_path = path.parent / "verifier" / "reward.json"
        report = read_json(report_path) if report_path.exists() else None
        reward = read_json(reward_path) if reward_path.exists() else None
        if report and (report["contextWindow"] != 1000000 or report["policy"]["thresholdRatio"] != threshold or report["policy"]["retainRatio"] != 0.16 or report["model"] != "deepseek-flash" or report["maxSteps"] != 200 or report["maxCalls"] != 250 or report["thinking"] != "disabled"):
            raise ValueError(f"{name}: report configuration differs for {task}")
        rows[task] = {"trial": path.parent.name, "result": result, "report": report, "reward": reward}
    expected = {task for task, _ in tasks}
    if set(rows) != expected:
        raise ValueError(f"{name}: result tasks do not match lock: {sorted(expected - set(rows))}")
    return tasks, rows


def metric(row, key):
    reward = row["reward"]
    return str(reward[key]) if reward and key in reward else "—"


def format_row(task, name, row):
    report = row["report"] or {}
    reward = row["reward"] or {}
    fraction = lambda stem: f'{reward.get(stem + "_passed", "—")}/{reward.get(stem + "_total", "—")}'
    return f'| {task} | {name} | {metric(row, "reward")} | {fraction("f2p")} | {fraction("p2p")} | {report.get("steps", "—")} | {report.get("compactions", "—")} | {report.get("prunes", "—")} | {report.get("peakInputTokens", "—")} | {report.get("failure") or ("finished" if report.get("done") else "no report")} |'


def compare(root: Path):
    tasks_80, rows_80 = arm(root, "threshold-80", 0.8)
    tasks_40, rows_40 = arm(root, "threshold-40", 0.4)
    if tasks_80 != tasks_40:
        raise ValueError("The two arms have different task names, order, or digests")
    lines = [
        "# DeepSWE 1M paired threshold comparison",
        "",
        "Three official DeepSWE v1.1 tasks, Pier 0.3.1, adapted DSH agent, DeepSeek Flash with thinking disabled, 1M configured window, 200 model steps / 250 calls. Both arms retain 16% recent history; only the native compaction trigger differs. One independent trajectory per task and arm.",
        "",
        "| Task | Trigger | Reward | F2P | P2P | Steps | Summaries | Prunes | Peak prompt (cache incl.) | Agent end |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for task, _digest in tasks_80:
        lines.append(format_row(task, "80%", rows_80[task]))
        lines.append(format_row(task, "40%", rows_40[task]))
    lines.extend(["", "Official binary rewards: " + ", ".join(f'{name} {sum((row["reward"] or {}).get("reward") == 1 for row in rows.values())}/3' for name, rows in (("80%", rows_80), ("40%", rows_40))) + "."])
    summaries = [sum((row["report"] or {}).get("compactions", 0) for row in rows.values()) for rows in (rows_80, rows_40)]
    if not any(summaries):
        lines.append("Neither arm actually summarized. The observed reward difference, if any, cannot be attributed to compression quality or trigger timing.")
    else:
        lines.append("This is exploratory: one stochastic run per arm per task cannot establish a reliable policy ranking. Inspect per-task summary counts and verifier failures before interpreting reward differences.")
    lines.extend(["", "Raw Pier job artifacts: [80%](threshold-80/result.json), [40%](threshold-40/result.json). The task list and exact invocation are in each arm's `lock.json`.", ""])
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    output = compare(args.root)
    path = args.root / "analysis.md"
    path.write_text(output, encoding="utf-8")
    print(path)
