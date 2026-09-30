"""Non-secret, machine-local connection registry for the Orchestra launcher."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit


def registry_path(path=None):
    return Path(path).expanduser().absolute() if path else Path.home() / '.config/orchestra/connections.json'


def validate_name(name):
    if not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,47}', name):
        raise ValueError('Connection names must start with a lowercase letter and contain only lowercase letters, digits and underscores (48 characters maximum)')
    return name


def native_name(name):
    return 'orchestra_' + validate_name(name)


def validate_definition(value):
    if not isinstance(value, dict) or set(value) != {'type', 'url', 'auth'}:
        raise ValueError('Connection needs exactly type, url and auth; tokens and headers do not belong in the registry')
    if value['type'] != 'mcp' or value['auth'] not in ('native', 'none'):
        raise ValueError('Connections require type=mcp and auth=native or none')
    url = value['url']
    if not isinstance(url, str) or any(c.isspace() or ord(c) < 32 for c in url):
        raise ValueError('Connection URL must be an HTTPS endpoint without whitespace')
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise ValueError('Invalid connection URL') from None
    if (parts.scheme != 'https' or not parts.hostname or parts.username is not None
            or parts.password is not None or parts.query or parts.fragment or '${' in url
            or (port is not None and port == 0)):
        raise ValueError('Use an HTTPS MCP endpoint without credentials, query parameters, fragments or environment references')
    return dict(value)


def read_registry(path=None):
    path = registry_path(path)
    if not path.exists():
        return {}
    try:
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('Duplicate JSON key')
                result[key] = value
            return result
        data = json.loads(path.read_text(), object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise ValueError(f'Invalid JSON in connection registry: {path}') from None
    if not isinstance(data, dict):
        raise ValueError('Connection registry must be a JSON object')
    return {validate_name(k): validate_definition(v) for k, v in data.items()}


@contextmanager
def registry_lock(path=None):
    path = registry_path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = path.with_name(path.name + '.lock')
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def add_connection(name, definition, path=None, replace=False):
    name = validate_name(name)
    definition = validate_definition(definition)
    path = registry_path(path)
    with registry_lock(path):
        if path.is_symlink():
            raise ValueError('Refusing to replace a symlinked registry')
        data = read_registry(path)
        if data.get(name) == definition:
            return False
        if name in data and not replace:
            raise ValueError(f'Connection {name} already exists; use --replace to update its registry definition')
        data[name] = definition
        fd, temporary = tempfile.mkstemp(prefix='.connections-', dir=path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(data, stream, indent=2, sort_keys=True)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return True


def resolve_connections(names, path=None):
    if not isinstance(names, list):
        raise ValueError('Agent connections must be a list of names')
    for name in names:
        validate_name(name)
    if len(names) != len(set(names)):
        raise ValueError('Connection names must be unique')
    if not names:
        return {}
    data = read_registry(path)
    missing = [name for name in names if name not in data]
    if missing:
        raise ValueError(f'Missing connection(s) {", ".join(missing)} in {registry_path(path)}; register them with connections add')
    return {name: data[name] for name in names}
