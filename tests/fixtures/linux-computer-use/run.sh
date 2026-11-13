#!/bin/sh
set -eu
Xvfb :97 -screen 0 1280x800x24 -nolisten tcp &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
sleep 1
export PYTHONDONTWRITEBYTECODE=1
/usr/bin/python3 /work/tests/fixtures/linux-computer-use/driver_test.py
/usr/bin/python3 /work/tests/fixtures/linux-computer-use/portal_test.py
/usr/bin/python3 /work/tests/fixtures/linux-computer-use/seat_test.py
/usr/bin/python3 /work/tests/fixtures/linux-computer-use/desktop_test.py
dbus-run-session -- sh -c 'openbox >/tmp/dscode-openbox.log 2>&1 & /usr/bin/python3 /work/tests/fixtures/linux-computer-use/probe.py'
