# /// script
# requires-python = ">=3.11"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Bounded native-launch prototype; not the production Orchestra CLI."""
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
from urllib.parse import urlsplit
import yaml


def name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', value):
        raise ValueError('Expected a lowercase configuration name, not a path')
    return value


def read_yaml(path):
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f'Expected a YAML mapping: {path}')
    return data


def fields(data, allowed):
    extra = set(data) - set(allowed)
    if extra:
        raise ValueError('Unsupported prototype fields: ' + ', '.join(sorted(extra)))


def connections(data):
    if not isinstance(data, dict):
        raise ValueError('connections must be an inline map')
    for key, value in data.items():
        name(key)
        if not isinstance(value, dict):
            raise ValueError('Expected an MCP connection mapping')
        fields(value, ['type', 'url', 'auth'])
        if value.get('type') != 'mcp' or value.get('auth') not in ('native', 'none'):
            raise ValueError('Only HTTPS MCP with auth=native or none is supported')
        url = value.get('url', '')
        if not isinstance(url, str):
            raise ValueError('Expected an HTTPS endpoint')
        parts = urlsplit(url)
        if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or any(c.isspace() for c in url):
            raise ValueError('Use an HTTPS endpoint without embedded credentials or query parameters')
    return data


def merge_connections(base, extra):
    result = dict(base)
    for key, value in connections(extra).items():
        if key in result and result[key] != value:
            raise ValueError(f'Conflicting connection {key}')
        result[key] = value
    return result


def resolve(root, agent, workspace=None):
    defaults = {}
    if workspace:
        ws = read_yaml(root / 'workspaces' / (name(workspace) + '.yaml'))
        fields(ws, ['connections'])
        defaults = connections(ws.get('connections', {}))
    nodes = {}

    def visit(agent_name, trail, route):
        name(agent_name)
        if agent_name in trail:
            raise ValueError('Child-agent cycle: ' + ' -> '.join(trail + [agent_name]))
        data = read_yaml(root / 'agents' / (agent_name + '.yaml'))
        fields(data, ['harness', 'model', 'reasoning_effort', 'instructions', 'skills', 'connections', 'subagents'])
        if data.get('harness') not in ('claude', 'codex'):
            raise ValueError('harness must be claude or codex')
        if not isinstance(data.get('model'), str) or not data['model'].strip():
            raise ValueError('Every agent requires a model')
        if not isinstance(data.get('instructions', ''), str):
            raise ValueError('instructions must be text')
        skills = data.get('skills', [])
        if not isinstance(skills, list) or not all(isinstance(s, str) for s in skills) or len(skills) != len(set(skills)):
            raise ValueError('skills must be a unique list of local directory names')
        for skill in skills:
            name(skill)
            folder = root / 'skills' / skill
            if not (folder / 'SKILL.md').is_file():
                raise ValueError(f'Missing local skill: {skill}')
            if folder.is_symlink() or any(p.is_symlink() for p in folder.rglob('*')):
                raise ValueError('Prototype skills must be real directories; copy supporting files locally')
        children = data.get('subagents', {})
        if not isinstance(children, dict):
            raise ValueError('subagents must map aliases to agent names')
        node = dict(data, name=agent_name, connections=merge_connections(defaults, data.get('connections', {})), skills=skills, children={})
        nodes[route] = node
        for alias, child in children.items():
            name(alias);name(child)
            child_route = route + '/' + alias
            node['children'][alias] = child_route
            visit(child, trail + [agent_name], child_route)
    visit(agent, [], 'main')
    return nodes


def file_map(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file() and p != root / 'checksums.json'}


def build(root, agent, target, workspace=None):
    root = root.expanduser().resolve(); target = target.expanduser().resolve()
    if not target.is_dir():
        raise ValueError('Target directory must already exist')
    nodes = resolve(root, agent, workspace)
    inputs = {'nodes': nodes, 'directory': str(target), 'workspace': workspace}
    digest = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode())
    digest.update(Path(__file__).read_bytes())
    runtime = Path(__file__).with_name('runtime.py')
    digest.update(runtime.read_bytes())
    skill_files = {}
    for node in nodes.values():
        for skill in node['skills']:
            for path in sorted((root / 'skills' / skill).rglob('*')):
                if path.is_file():
                    key = str(path.relative_to(root / 'skills'))
                    skill_files[key] = (path.read_bytes(), path.stat().st_mode & 0o111)
    for key, (data, mode) in sorted(skill_files.items()):
        digest.update(json.dumps([key, mode, len(data)]).encode());digest.update(data)
    bundle = target / '.orchestra/generated' / f'{name(agent)}-{workspace or "none"}-{digest.hexdigest()[:20]}'
    if bundle.exists():
        expected = json.loads((bundle / 'checksums.json').read_text())
        if file_map(bundle) != expected:
            raise ValueError('Generated bundle was modified; refusing silent reuse')
        return bundle
    bundle.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.building-', dir=bundle.parent))
    try:
        shutil.copyfile(runtime, staging / 'runtime.py')
        for route, node in nodes.items():
            directory = staging / route
            directory.mkdir(parents=True, exist_ok=True)
            for skill in node['skills']:
                for key, (data, mode) in skill_files.items():
                    if key.startswith(skill + '/'):
                        p = directory / 'skills' / key;p.parent.mkdir(parents=True, exist_ok=True)
                        p.write_bytes(data);p.chmod(0o755 if mode else 0o644)
            (directory / 'agent.json').write_text(json.dumps(node, indent=2))
            if node['harness'] == 'claude':
                manifest = directory / '.claude-plugin/plugin.json';manifest.parent.mkdir()
                manifest.write_text(json.dumps({'name':'orchestra-' + node['name'], 'version':'0.1.0'}))
                mcp = {'mcpServers': {'orchestra_' + k: {'type':'http','url':v['url']} for k,v in node['connections'].items()}}
                (directory / 'mcp.json').write_text(json.dumps(mcp, indent=2))
            for alias, child_route in node['children'].items():
                script = directory / 'dispatch' / alias;script.parent.mkdir(exist_ok=True)
                script.write_text('#!/usr/bin/env python3\nimport os, sys\nos.execv(sys.executable, [sys.executable, '+repr(str(bundle/'runtime.py'))+', '+repr(str(bundle))+', '+repr(child_route)+', "--exec", *sys.argv[1:]])\n')
                script.chmod(0o755)
        (staging/'manifest.json').write_text(json.dumps(inputs, indent=2))
        (staging/'checksums.json').write_text(json.dumps(file_map(staging), indent=2))
        try:
            staging.rename(bundle)
        except OSError:
            if not bundle.is_dir() or file_map(bundle) != json.loads((staging/'checksums.json').read_text()):
                raise
    finally:
        if staging.exists():shutil.rmtree(staging)
    return bundle


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('agent');p.add_argument('--config-root',type=Path,default=Path.home()/'.config/orchestra')
    p.add_argument('--workspace');p.add_argument('--directory',type=Path,default=Path.cwd())
    p.add_argument('--build',action='store_true');p.add_argument('--exec',action='store_true',dest='headless')
    p.add_argument('--message');p.add_argument('--explain',action='store_true')
    args=p.parse_args()
    try:
        bundle=build(args.config_root,args.agent,args.directory,args.workspace)
        if args.build:print(bundle);return
        argv=[sys.executable,str(bundle/'runtime.py'),str(bundle),'main']
        if args.headless:argv.append('--exec')
        if args.message is not None:argv+=['--message',args.message]
        if args.explain:argv.append('--explain')
        os.execv(sys.executable,argv)
    except (ValueError,OSError,yaml.YAMLError) as e:
        p.exit(1,f'error: {e}\n')

if __name__=='__main__':main()
