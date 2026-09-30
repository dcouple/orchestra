"""Native user-level MCP registration. OAuth remains owned by each CLI."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from connections import native_name, registry_lock, registry_path


def durable_env(harness):
    env = os.environ.copy()
    if harness == 'codex':
        home = Path(env.get('CODEX_HOME', str(Path.home() / '.codex'))).expanduser().absolute()
        # Omnigent's temporary homes must never become the initial login store.
        if any(p.startswith('omnigent-codex-home-') for p in home.parts) or (
                any(p.startswith('omnigent') for p in home.parts)
                and ('codex-native' in home.parts or 'codex' in home.parts)):
            raise ValueError('Run connection setup from your ordinary terminal, outside Omnigent\'s temporary CODEX_HOME')
    return env


def _run(argv, *, cwd=None, interactive=False, env=None):
    if not shutil.which(argv[0]):
        raise ValueError(f'Missing executable: {argv[0]}')
    if interactive:
        return subprocess.run(argv, cwd=cwd, env=env)
    return subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=45)


def inspect_registration(harness, name, cwd=None):
    """Return sanitized effective settings; never return raw native output."""
    server = native_name(name)
    argv = [harness, 'mcp', 'get', server] + (['--json'] if harness == 'codex' else [])
    result = _run(argv, cwd=cwd, env=durable_env(harness))
    if result.returncode:
        text = result.stdout + result.stderr
        if 'No MCP server named' in text or 'No MCP server found' in text:
            return None
        raise ValueError(f'Could not inspect {harness} MCP registration {server}; run {harness} mcp get {server} in your terminal')
    if harness == 'codex':
        try:
            data = json.loads(result.stdout)
            transport = data['transport']
            return {'url': transport.get('url'), 'type': transport.get('type'),
                    'enabled': data.get('enabled', True),
                    'custom_auth': any(transport.get(k) for k in ('bearer_token_env_var', 'http_headers', 'env_http_headers', 'http_headers_helper'))}
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ValueError('Could not parse Codex MCP settings; update the adapter for this CLI version') from None
    output = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', result.stdout)
    fields = {}
    for line in output.splitlines():
        key, sep, value = line.strip().partition(':')
        if sep:
            fields[key] = value.strip()
    if 'URL' not in fields or 'Type' not in fields or 'Scope' not in fields:
        raise ValueError('Could not parse Claude MCP settings; update the adapter for this CLI version')
    return {'url': fields['URL'], 'type': fields['Type'], 'enabled': True,
            'user_scope': fields['Scope'].startswith('User config'),
            'custom_auth': any(k in fields for k in ('Headers', 'Headers helper', 'HeadersHelper'))}


def matches(harness, actual, definition):
    return bool(actual and actual['url'] == definition['url']
                and actual['type'] == ('http' if harness == 'claude' else 'streamable_http')
                and actual['enabled'] and not actual['custom_auth']
                and actual.get('user_scope', True))


def require_registrations(harness, definitions, cwd=None, connections_file=None):
    for name, definition in definitions.items():
        actual = inspect_registration(harness, name, cwd)
        if not matches(harness, actual, definition):
            if actual is not None:
                raise ValueError(f'{harness} connection {native_name(name)} conflicts with the registry or is overridden/disabled; inspect its native settings before changing it')
            location = f' (registry: {registry_path(connections_file)})' if connections_file else ''
            raise ValueError(f'{native_name(name)} is not registered for {harness}; run orchestra-omni connections login {name} --harness {harness}{location}')


def registration_args(harness, name, definition):
    server = native_name(name)
    if harness == 'claude':
        return ['claude', 'mcp', 'add-json', '--scope', 'user', server,
                json.dumps({'type': 'http', 'url': definition['url']}, separators=(',', ':'))]
    return ['codex', 'mcp', 'add', server, '--url', definition['url']]


def login(harness, name, definition):
    """Register one native entry and hand the terminal to the native OAuth UI."""
    env = durable_env(harness)
    # One lock across registries for changes to the same user's native config.
    with registry_lock():
        actual = inspect_registration(harness, name)
        created = actual is None
        if actual is not None and not matches(harness, actual, definition):
            raise ValueError(f'Refusing to overwrite conflicting {harness} server {native_name(name)}; inspect/remove it with the native CLI first')
        if created:
            result = _run(registration_args(harness, name, definition), interactive=True, env=env)
            if result.returncode:
                raise ValueError('Native registration did not complete; inspect the native command output and retry')
        # Codex mcp add already starts OAuth when the server advertises it.
        # Do not ask the user to log in twice on their first registration.
        if definition['auth'] == 'native' and not (harness == 'codex' and created):
            result = _run([harness, 'mcp', 'login', native_name(name)], interactive=True, env=env)
            if result.returncode:
                raise ValueError('Native OAuth login did not complete; retry connections login')
        require_registrations(harness, {name: definition})
    print(f'{native_name(name)} configured for {harness}. Credentials remain in its native store.')
    print('Registration is user-level and can appear in other native sessions. Verify tool access in a fresh session.')
