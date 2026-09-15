"""Small local adapter; the Omnigent runtime remains an external dependency."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

OMNIGENT_VERSION = "0.13.0"
INTEGRATION = Path(__file__).resolve().parent
ORCHESTRA = INTEGRATION.parents[1]
HARNESSES = ("claude", "codex")
TEXT_SUFFIXES = {".md", ".html", ".sh", ".py", ".json", ".yaml", ".yml", ".toml", ".txt"}


def read_object(path):
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def read_sources(repo):
    """Read only the canonical system, rejecting links outside its source tree."""
    result = {}
    for directory in ("claude/skills", "claude/agents", "codex/skills", "references"):
        source = repo / directory
        if not source.is_dir():
            raise ValueError(f"Missing Orchestra sources: {source}")
        for path in sorted(source.rglob("*")):
            if path.name == ".DS_Store" or "__pycache__" in path.parts:
                continue
            if path.is_symlink():
                raise ValueError(f"Symlinks are not supported in canonical bundle sources: {path}")
            if path.is_file():
                result[path.relative_to(repo).as_posix()] = (path.read_bytes(), path.stat().st_mode & 0o111)
    return result


def rewrite_paths(data, suffix, destination):
    if suffix not in TEXT_SUFFIXES:
        return data
    text = data.decode("utf-8")
    for old, new in (
        (".references", destination / "support/references"),
        (".claude/agents", destination / "support/claude/agents"),
        (".claude/skills", destination / "support/claude/skills"),
        (".codex/skills", destination / "support/codex/skills"),
    ):
        text = re.sub(r"(?<![\w/~])" + re.escape(old) + r"(?=/|[^\w.-]|$)", lambda _: str(new), text)
    return text.encode("utf-8")


def cache_root():
    base = os.environ.get("ORCHESTRA_OMNI_CACHE")
    return Path(base).expanduser().resolve() if base else Path.home() / ".cache/orchestra/omnigent"


def build_bundle(agent, harness, tools_files=(), *, integration=INTEGRATION, repo=ORCHESTRA, cache=None):
    """Create an immutable snapshot; changed sources produce a new path."""
    if Path(agent).name != agent or agent in (".", ".."):
        raise ValueError("Agent must name a directory under integrations/omnigent/agents")
    config = read_object(integration / "agents" / agent / "config.json")
    if any(not isinstance(config.get(key), str) or not config[key] for key in ("name", "description")):
        raise ValueError("Agent config needs a name and description")
    if not isinstance(config.get("tools", {}), dict):
        raise ValueError("Agent tools must be an object")
    selections = read_object(integration / "agents" / agent / "skills.json")
    names = selections.get(harness)
    if not isinstance(names, list) or not names or any(not isinstance(n, str) for n in names):
        raise ValueError(f"Agent {agent} needs a nonempty {harness} skill list")
    if len(names) != len(set(names)) or any(Path(n).name != n or n in (".", "..") for n in names):
        raise ValueError("Skill names must be unique directory names")
    sources = read_sources(repo)
    for name in names:
        if f"{harness}/skills/{name}/SKILL.md" not in sources:
            raise ValueError(f"Missing canonical {harness} skill: {name}")
    config["executor"] = {"type": "omnigent", "config": {"harness": f"{harness}-native"}}
    config.setdefault("tools", {})
    for path in tools_files:
        for name, definition in read_object(path).items():
            if name in {"agents", "builtins", "timeout", "retry", "sandbox"}:
                raise ValueError(f"Reserved Omnigent tools key: {name}")
            if name in config["tools"]:
                raise ValueError(f"Duplicate tool connection: {name}")
            if not isinstance(definition, dict) or definition.get("type") != "mcp":
                raise ValueError(f"Connection {name} must be an Omnigent type: mcp entry")
            config["tools"][name] = definition
    cache = (cache or cache_root()).resolve()
    # Source Markdown contains unquoted shell paths. Do not introduce shell syntax.
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(cache)):
        raise ValueError("Set ORCHESTRA_OMNI_CACHE to an absolute path using only letters, digits, /, _, -, and .")
    digest = hashlib.sha256()
    digest.update(Path(__file__).read_bytes())
    digest.update(json.dumps([config, names, str(cache)], sort_keys=True).encode())
    for name, (data, executable) in sorted(sources.items()):
        digest.update(json.dumps([name, executable, len(data)]).encode())
        digest.update(data)
    destination = cache / digest.hexdigest()
    files = {"config.yaml": (json.dumps(config, indent=2).encode() + b"\n", 0)}
    for relative, (data, executable) in sources.items():
        rewritten = rewrite_paths(data, Path(relative).suffix, destination)
        files["support/" + relative] = (rewritten, executable)
        prefix = f"{harness}/skills/"
        if relative.startswith(prefix) and relative[len(prefix):].split("/")[0] in names:
            files["skills/" + relative[len(prefix):]] = (rewritten, executable)
        if harness == "claude" and relative.startswith("claude/agents/") and relative.endswith(".md") and not relative.endswith("/README.md"):
            files["agents/" + relative[len("claude/agents/"):]] = (rewritten, executable)
    if harness == "claude":
        plugin = {"name": config["name"], "version": "0.1.0", "description": config["description"]}
        files[".claude-plugin/plugin.json"] = (json.dumps(plugin, indent=2).encode() + b"\n", 0)
    manifest = {"omnigent_version": OMNIGENT_VERSION, "agent": agent, "harness": harness,
                "skills": names, "files": {name: hashlib.sha256(data).hexdigest() for name, (data, _) in files.items()}}
    files["orchestra-bundle.json"] = (json.dumps(manifest, indent=2).encode() + b"\n", 0)

    def verify_existing():
        actual = set()
        for path in destination.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"Cached bundle contains a symlink: {destination}")
            if path.is_file():
                actual.add(path.relative_to(destination).as_posix())
        if actual != set(files):
            raise ValueError(f"Cached bundle file set has changed: {destination}")
        for name, (data, executable) in files.items():
            path = destination / name
            if not path.is_file() or path.is_symlink() or path.read_bytes() != data or path.stat().st_mode & 0o111 != executable:
                raise ValueError(f"Cached bundle has changed: {destination}. Use a new ORCHESTRA_OMNI_CACHE directory.")

    if destination.exists():
        verify_existing()
        return destination
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = Path(tempfile.mkdtemp(prefix=".building-", dir=cache))
    try:
        for name, (data, executable) in files.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o644 | executable)
        try:
            temporary.rename(destination)
        except OSError:
            if not destination.is_dir():
                raise
            verify_existing()
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return destination


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor", help="Check locally installed runtime prerequisites")
    build = commands.add_parser("build", help="Print a cached agent bundle path without launching")
    build.add_argument("agent")
    build.add_argument("--harness", choices=HARNESSES, required=True)
    build.add_argument("--tools", action="append", default=[], type=Path, help="JSON map of MCP connections (repeatable)")
    for command, help_text in (("run", "Open the native Claude/Codex TUI"), ("agent", "Open an Omnigent session with a configured agent bundle")):
        child = commands.add_parser(command, help=help_text)
        if command == "run":
            child.add_argument("harness", choices=HARNESSES)
        else:
            child.add_argument("agent")
            child.add_argument("--harness", choices=HARNESSES, required=True)
            child.add_argument("--tools", action="append", default=[], type=Path)
            child.add_argument("--task", help="Run one initial task through Omnigent's one-shot bundle path")
        child.add_argument("--project", type=Path, default=Path.cwd())
        child.add_argument("--model")
        child.add_argument("--resume", metavar="OMNIGENT_SESSION_ID")
        if command == "run":
            child.add_argument("--message", help="Initial message in the native TUI")
        child.add_argument("--dry-run", action="store_true", help="Print launch arguments without starting processes")
    return cli


def launch_args(args, bundle=None):
    if args.command == "run":
        argv = ["omni", args.harness, "--server", ""]
        if args.harness == "claude":
            argv.append("--use-native-config")
        if args.message is not None:
            argv.extend(["-p", args.message])
    else:
        argv = ["omni", "run", str(bundle), "--server", "local"]
        if args.task is not None:
            argv.extend(["-p", args.task])
    if args.model:
        argv.extend(["--model", args.model])
    if args.resume:
        argv.extend(["--resume", args.resume])
    return argv


def check_runtime(harness=None):
    missing = [name for name in ("omni", "tmux") + ((harness,) if harness else ()) if not shutil.which(name)]
    if missing:
        raise ValueError("Missing executable(s): " + ", ".join(missing) + ". See integrations/omnigent/README.md.")
    result = subprocess.run(["omni", "--version"], capture_output=True, text=True, timeout=30)
    if result.returncode or not re.search(r"(?<![\d.])" + re.escape(OMNIGENT_VERSION) + r"(?![\d.])", result.stdout + result.stderr):
        raise ValueError(f"This integration requires Omnigent {OMNIGENT_VERSION}; install the pinned version in README.md.")


def main(argv=None):
    cli = parser()
    args = cli.parse_args(argv)
    try:
        if args.command == "doctor":
            check_runtime()
            print(f"Omnigent {OMNIGENT_VERSION}: OK; tmux: OK")
            for name in HARNESSES:
                print(f"{name}: {'available' if shutil.which(name) else 'not installed'}")
            print("Authentication, MCP connections and trace exports were not tested.")
            return 0
        if args.command == "build":
            print(build_bundle(args.agent, args.harness, args.tools))
            return 0
        project = args.project.expanduser().resolve()
        if not project.is_dir():
            raise ValueError(f"Project directory does not exist: {project}")
        message = getattr(args, "message", None) if args.command == "run" else args.task
        if message is not None and not message.strip():
            raise ValueError("The starter message/task must not be empty")
        if args.resume and message is not None:
            raise ValueError("Resume first, then send a message in the session")
        if args.command == "agent" and cache_root().resolve().is_relative_to(project):
            raise ValueError("ORCHESTRA_OMNI_CACHE must be outside the target project")
        if not args.dry_run:
            check_runtime(args.harness)
        bundle = build_bundle(args.agent, args.harness, args.tools) if args.command == "agent" else None
        argv = launch_args(args, bundle)
        if args.dry_run:
            print(json.dumps({"cwd": str(project), "argv": argv}, indent=2))
            return 0
        os.chdir(project)
        os.execvp(argv[0], argv)
    except (ValueError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
