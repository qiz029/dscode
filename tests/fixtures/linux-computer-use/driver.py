import json
import os
from pathlib import Path
import select
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]


class HelperError(RuntimeError):
    def __init__(self, error):
        super().__init__(json.dumps(error))
        self.code = error.get("code")


class Helper:
    def __init__(self):
        self.log = open(f"/tmp/dscode-helper-{uuid.uuid4().hex}.log", "w")
        self.process = subprocess.Popen(["/usr/bin/python3", "-u", str(ROOT / "plugins/computer-use/linux/helper.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True)
        self.seq = 0
        self.lease = None
        self.calls = []
        self.action_retries = 0

    def call(self, command, **args):
        self.seq += 1
        started = time.perf_counter()
        self.process.stdin.write(json.dumps({"id": self.seq, "command": command, **args}) + "\n")
        self.process.stdin.flush()
        if not select.select([self.process.stdout], [], [], 120 if command == "connect-portal" else 40)[0]:
            raise RuntimeError(f"Helper timed out: {command}")
        result = json.loads(self.process.stdout.readline())
        self.calls.append({"command": command, "elapsedMs": (time.perf_counter() - started) * 1000})
        if "error" in result:
            raise HelperError(result["error"])
        return result["result"]

    def observe(self, app, scope=None, screenshot="none"):
        return self.call("observe", app=app, options={"maxNodes": 1000, "maxDepth": 20, "maxTextBytes": 128000,
            "scope": scope, "screenshot": screenshot, "screenshotPath": f"/tmp/dscode-bench-{uuid.uuid4().hex}.png"})

    def act(self, observation, action, element=None, allow_desktop=False):
        if not self.lease:
            self.lease = self.call("control-acquire", owner=f"fixture-{os.getpid()}", ttlMs=60000)
        return self.call("act", expectedInstance=observation["helperInstance"], leaseToken=self.lease["token"],
            request={"app": observation["app"], "action": action, "element": element, "allowDesktopInput": allow_desktop,
                "expectedStateHash": observation["stateHash"], "interaction": {"pointerInputPolicy": "targeted", "keyboardPolicy": "activate"}},
            limits={"maxNodes": 1000, "maxDepth": 20, "maxTextBytes": 128000, "scope": observation.get("scope")})

    def act_fresh(self, app, action, select_element, scope=None, max_attempts=3):
        """Reobserve/reselect only after the helper explicitly rejects stale input.

        The helper emits COMPUTER_STALE_OBSERVATION before dispatching input.
        Timeouts, transport failures and other errors can have uncertain effects
        and must never replay the action. Successful dispatch is never retried.
        """
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        for attempt in range(max_attempts):
            current = self.observe(app, scope)
            matches = [element for element in current["elements"] if select_element(element)]
            if len(matches) != 1:
                raise AssertionError(f"Expected one matching target, observed {len(matches)}.")
            try:
                return self.act(current, action, matches[0])
            except HelperError as error:
                if error.code != "COMPUTER_STALE_OBSERVATION" or attempt + 1 == max_attempts:
                    raise
                self.action_retries += 1
                time.sleep(0.11)  # Expire the helper's 100 ms observation cache.

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdin.close()
        self.process.stdout.close()
        self.log.close()
