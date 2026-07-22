#!/usr/bin/env python3
"""Build one safely quoted daemonctl command and forward it through gcloud SSH."""

from __future__ import annotations

import os
import shlex
import subprocess
import sys
from typing import NoReturn


COMMANDS = {
    "status",
    "sessions",
    "top",
    "restart",
    "hard-restart",
    "config",
    "update",
    "subscriptions",
}


def fail(message: str) -> NoReturn:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        fail(f"missing {name}")
    return value


def extra_args() -> list[str]:
    try:
        return shlex.split(os.environ.get("DAEMON_REMOTE_ARGS", ""), posix=True)
    except ValueError as error:
        fail(f"invalid ARGS quoting: {error}")


def daemon_args(command: str) -> list[str]:
    extras = extra_args()
    if command == "hard-restart":
        return ["restart", "--hard", *extras]
    if command == "config":
        planner = required_env("DAEMON_REMOTE_PLANNER")
        implementer = required_env("DAEMON_REMOTE_IMPLEMENTER")
        return ["config", "--planner", planner, "--implementer", implementer, *extras]
    if command == "update":
        ref = os.environ.get("DAEMON_REMOTE_REF", "")
        return ["update", *(["--ref", ref] if ref else []), *extras]
    if command == "subscriptions" and not extras:
        fail("set ARGS to list, add, remove, or reauth arguments")
    return [command, *extras]


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        fail("usage: daemonctl-remote.py status|sessions|top|restart|hard-restart|config|update|subscriptions")
    command = sys.argv[1]
    remote = shlex.join(["sudo", required_env("DAEMON_REMOTE_DAEMONCTL"), *daemon_args(command)])
    argv = [
        required_env("DAEMON_REMOTE_GCLOUD"),
        "compute",
        "ssh",
        required_env("DAEMON_REMOTE_HOST"),
        f"--project={required_env('DAEMON_REMOTE_PROJECT')}",
        f"--zone={required_env('DAEMON_REMOTE_ZONE')}",
        f"--command={remote}",
        "--",
        "-t",
    ]
    return subprocess.run(argv, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
