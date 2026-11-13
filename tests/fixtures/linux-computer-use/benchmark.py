"""Real application benchmark. No inference; bytes and latency are measured,
model tokens remain null rather than using a misleading bytes/4 estimate.
"""
import json
import math
import os
from pathlib import Path
import signal
import statistics
import subprocess
import tempfile
import time
from driver import Helper, ROOT
from gi.repository import Gio, GLib

fixtures = ROOT / "tests/fixtures/linux-computer-use"
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
for key in ["IsEnabled", "ScreenReaderEnabled"]:
    bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
        GLib.Variant("(ssv)", ("org.a11y.Status", key, GLib.Variant("b", True))), None, Gio.DBusCallFlags.NONE, 3000, None)
directory = Path(tempfile.mkdtemp(prefix="dscode-app-bench-"))
(directory / "benchmark.txt").write_text("original fixture text")
cases = [
    ("gtk-large", ["/usr/bin/python3", str(fixtures / "app.py")], "python3", "edit-and-click"),
    ("qt", ["/usr/bin/python3", str(fixtures / "qt-app.py")], "qt-app.py", "edit-and-click"),
    ("chromium", ["chromium", "--no-sandbox", "--disable-gpu", "--force-renderer-accessibility=complete", "--no-first-run", "--user-data-dir=" + str(directory / "chromium"), "--app=" + (fixtures / "page.html").as_uri()], "chromium", "edit-and-click"),
    ("electron", ["/opt/dscode-electron/node_modules/electron/dist/electron", "--no-sandbox", "--force-renderer-accessibility", str(fixtures / "electron-app.cjs")], "electron", "edit-and-click"),
    ("mousepad", ["mousepad", str(directory / "benchmark.txt")], "mousepad", "edit-document"),
    ("thunar", ["thunar", str(directory)], "thunar", "find-file"),
]
report = {"format": 1, "modelTokens": None, "inference": "none; scripted desktop tasks", "applications": []}


def percentile(values):
    return round(sorted(values)[math.ceil(len(values) * 0.95) - 1], 2)


for name, command, fallback, task in cases:
    task_started = time.perf_counter()
    helper = Helper()
    log = open(directory / f"{name}.log", "w")
    child, snapshot = None, None
    row = {"application": name, "task": task, "success": False, "actionRetries": 0}
    try:
        child = subprocess.Popen(command, env={**os.environ, "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1", "DSCODE_LARGE_FIXTURE": "1" if name == "gtk-large" else ""}, stdout=log, stderr=log, start_new_session=True)
        app = None
        for _ in range(100):
            apps = helper.call("list-apps")
            matches = [item for item in apps if item["pid"] == child.pid and item["accessibility"] == "granted"]
            if not matches:
                matches = [item for item in apps if fallback in item["name"].lower() and item["accessibility"] == "granted"]
            if len(matches) == 1:
                app = {key: matches[0][key] for key in ["pid", "bundleId", "name"]}
                snapshot = helper.observe(app)
                if len(snapshot["elements"]) > 2:
                    break
            time.sleep(0.1)
        if not app:
            raise RuntimeError("Application did not expose an AT-SPI root.")
        time.sleep(0.5)
        snapshot = helper.observe(app)
        if task == "find-file":
            helper.act_fresh(app, {"kind": "click"}, lambda item: item["title"] == "List View" and item["actions"],
                scope={"name": "List View", "exact": True})
            time.sleep(0.3)
            snapshot = helper.observe(app)
            target = next(item for item in snapshot["elements"] if item["title"] == "benchmark.txt" or item.get("value") == "benchmark.txt")
        elif task == "edit-document":
            target = next(item for item in snapshot["elements"] if "original fixture text" in item.get("value", "") and item["role"] == "text")
        else:
            target = next(item for item in snapshot["elements"] if item["title"] == "Fixture input" and item["role"] in ["text", "entry"])
        root_scope = {"root": {"locator": target["locator"], "title": target["title"], "role": target["role"], "helperInstance": snapshot["helperInstance"]}, "maxDepth": 0}
        full_times, scoped_times, full_sizes, scoped_sizes = [], [], [], []
        for _ in range(5):
            time.sleep(0.11)  # Measure real traversals, not the 100 ms cache.
            full = helper.observe(app)
            full_times.append(helper.calls[-1]["elapsedMs"])
            full_sizes.append(len(json.dumps(full, ensure_ascii=False).encode()))
            scoped = helper.observe(app, root_scope)
            scoped_times.append(helper.calls[-1]["elapsedMs"])
            scoped_sizes.append(len(json.dumps(scoped, ensure_ascii=False).encode()))
        row.update({"fullP95Ms": percentile(full_times), "subtreeP95Ms": percentile(scoped_times),
            "fullBackendBytes": round(statistics.median(full_sizes)), "subtreeBackendBytes": round(statistics.median(scoped_sizes)),
            "fullVisitedNodes": full["metrics"]["visitedNodes"], "subtreeVisitedNodes": scoped["metrics"]["visitedNodes"]})
        expected = "DSCODE 中文 ✓"
        if task != "find-file":
            current = helper.observe(app, root_scope)
            if name in ["chromium", "electron"]:
                # Chromium does not expose AT-SPI EditableText for HTML inputs.
                # Exercise its accessible button; DOM editing belongs to browser-use.
                expected = current["elements"][0]["value"]
                row["task"] = "click-and-verify"
            else:
                helper.act_fresh(app, {"kind": "set-value", "value": expected},
                    lambda item: item["title"] == target["title"] and item["role"] == target["role"], scope=root_scope)
                edited = helper.observe(app, root_scope)
                assert edited["elements"][0]["value"] == expected, edited
            if task == "edit-and-click":
                # Admit input against the button's scope, so unrelated browser
                # accessibility updates do not stale the whole application tree.
                helper.act_fresh(app, {"kind": "click"},
                    lambda item: item["title"] == "Apply fixture" and item["actions"],
                    scope={"name": "Apply fixture", "exact": True})
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    current = helper.observe(app)
                    if f"Applied: {expected}" in json.dumps(current, ensure_ascii=False):
                        break
                    helper.call("wait-change", eventEpoch=current["eventEpoch"], timeoutMs=500)
                else:
                    raise AssertionError("Button postcondition not observed.")
        row["success"] = True
    except Exception as error:
        row["error"] = f"{type(error).__name__}: {error}"[:1600]
        row["applicationLog"] = (directory / f"{name}.log").read_text()[-2000:]
        if snapshot:
            row["observedRoles"] = [{"role": item["role"], "title": item["title"], "value": item.get("value")} for item in snapshot["elements"][-40:]]
    finally:
        row["actionRetries"] = helper.action_retries
        helper.close()
        try:
            if child:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        log.close()
    report["applications"].append(row)
    row["taskElapsedMs"] = round((time.perf_counter() - task_started) * 1000, 2)
    actions = [call["elapsedMs"] for call in helper.calls if call["command"] == "act"]
    row["actionP95Ms"] = percentile(actions) if actions else None
    print(json.dumps(row, ensure_ascii=False), flush=True)

output = Path(os.environ.get("DSCODE_BENCHMARK_OUTPUT", "/tmp/dscode-computer-benchmark.json"))
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print("LINUX_COMPUTER_BENCHMARK: " + json.dumps({"passed": sum(row["success"] for row in report["applications"]), "total": len(cases), "report": str(output)}))
print("BENCHMARK_REPORT: " + json.dumps(report, ensure_ascii=False))
raise SystemExit(0 if all(row["success"] for row in report["applications"]) else 1)
