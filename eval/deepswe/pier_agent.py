"""Pier adapter for the local DSH compaction eval loop.

The Node process owns the model session. This adapter exposes only shell commands
inside Pier's agent container; the held-out verifier stays in Pier's separate
verifier container.
"""

import asyncio
import json
import os
from pathlib import Path

from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext


ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path(__file__).with_name("agent.mjs")


def _clip(value: str | None, limit: int = 12000) -> str:
    text = value or ""
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n[... {len(text) - limit} characters omitted ...]\n" + text[-half:]


class DSHCompactionAgent(BaseAgent):
    """Run DeepSeek Flash with DSH compaction at 80% or 40% pressure."""

    def __init__(
        self, *args, context_window: int | str = 1000000,
        threshold_ratio: float | str = 0.8,
        max_steps: int | str = 200, max_calls: int | str = 250,
        thinking: str = "disabled", **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.context_window = int(context_window)
        self.threshold_ratio = float(threshold_ratio)
        self.max_steps = int(max_steps)
        self.max_calls = int(max_calls)
        if self.context_window < 4096 or self.max_steps < 1 or self.max_calls < 1:
            raise ValueError("Invalid DeepSWE agent budget")
        if self.threshold_ratio not in {0.8, 0.4}:
            raise ValueError("DeepSWE threshold ratio must be 0.8 or 0.4")
        if thinking not in {"disabled", "enabled"}:
            raise ValueError("Invalid thinking mode")
        self.thinking = thinking

    @staticmethod
    def name() -> str:
        return "dsh-compaction"

    def version(self) -> str:
        return "1"

    async def setup(self, environment: BaseEnvironment) -> None:
        # DeepSWE requires the agent's patch to be committed. Keep identity in
        # the isolated task checkout; the model still decides what to commit.
        result = await environment.exec(
            "git config user.name 'DSH Eval' && git config user.email 'dsh-eval@example.invalid' && git switch -c dsh-eval",
            cwd="/app",
            timeout_sec=15,
        )
        if result.return_code:
            raise RuntimeError(f"Could not configure task checkout: {_clip(result.stderr)}")

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        if not os.environ.get("DEEPSEEK_API_KEY"):
            raise RuntimeError("DEEPSEEK_API_KEY is required on the Pier host")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        instruction_file = self.logs_dir / "instruction.json"
        instruction_file.write_text(json.dumps({"instruction": instruction}), encoding="utf-8")
        command = [
            "node", str(RUNNER), "--instruction", str(instruction_file),
            "--out", str(self.logs_dir),
            "--context-window", str(self.context_window),
            "--threshold-ratio", str(self.threshold_ratio),
            "--max-steps", str(self.max_steps),
            "--max-calls", str(self.max_calls),
            "--thinking", self.thinking,
        ]
        process = await asyncio.create_subprocess_exec(
            *command, cwd=str(ROOT), env=os.environ.copy(),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdin and process.stdout and process.stderr

        async def capture_stderr() -> None:
            with (self.logs_dir / "agent-stderr.txt").open("wb") as stream:
                while chunk := await process.stderr.read(8192):
                    stream.write(chunk)

        stderr_task = asyncio.create_task(capture_stderr())
        report = None
        try:
            while line := await process.stdout.readline():
                event = json.loads(line)
                if event.get("type") == "tool" and event.get("name") == "run_shell":
                    command_text = event.get("arguments", {}).get("command")
                    if not isinstance(command_text, str) or not command_text.strip() or len(command_text) > 20000:
                        result = {"ok": False, "error": "invalid-command"}
                    else:
                        try:
                            execution = await environment.exec(
                                command_text, cwd="/app", timeout_sec=120,
                            )
                            result = {
                                "ok": execution.return_code == 0,
                                "exitCode": execution.return_code,
                                "stdout": _clip(execution.stdout),
                                "stderr": _clip(execution.stderr),
                            }
                        except Exception as error:
                            result = {"ok": False, "error": type(error).__name__, "detail": _clip(str(error))}
                    process.stdin.write((json.dumps({"id": event["id"], "result": result}) + "\n").encode())
                    await process.stdin.drain()
                elif event.get("type") == "final":
                    report = event["report"]
                else:
                    raise RuntimeError("Unexpected DSH agent protocol message")
            code = await process.wait()
            await stderr_task
            if report:
                context.n_input_tokens = report.get("inputTokens")
                context.n_cache_tokens = report.get("cacheReadTokens")
                context.n_output_tokens = report.get("outputTokens")
                context.peak_context_tokens = report.get("peakInputTokens")
                context.summarization_count = report.get("compactions")
                context.n_agent_steps = report.get("steps")
                context.metadata = {"policy": report.get("policy", {}).get("id"), "model": report.get("model"), "agentReport": "agent-report.json"}
            if code:
                raise RuntimeError(f"DSH agent failed with exit code {code}; see agent-stderr.txt")
            if not report:
                raise RuntimeError("DSH agent exited without a final report")
            # DeepSWE v1.1 collects committed changes, so preserve the final work
            # tree even when the model used its whole step budget before commit.
            status = await environment.exec("git status --porcelain", cwd="/app", timeout_sec=15)
            if status.return_code:
                raise RuntimeError(f"Could not inspect task checkout: {_clip(status.stderr)}")
            if status.stdout and status.stdout.strip():
                commit = await environment.exec(
                    "git add -A && git commit -m 'DeepSWE agent changes'",
                    cwd="/app", timeout_sec=60,
                )
                (self.logs_dir / "harness-commit.txt").write_text(
                    (commit.stdout or "") + (commit.stderr or ""), encoding="utf-8"
                )
                if commit.return_code:
                    raise RuntimeError("Could not commit the agent's final work tree")
                context.metadata = {**(context.metadata or {}), "harnessCommittedWorktree": True}
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            await stderr_task
