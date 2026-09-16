"""Standard-library runtime copied into each static proof bundle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


def link(source, destination):
    if not source.exists():
        return
    if destination.is_symlink():
        if destination.resolve() != source.resolve():
            raise ValueError(f'Conflicting runtime link: {destination}')
    elif destination.exists():
        raise ValueError(f'Runtime path is not the expected link: {destination}')
    else:
        destination.symlink_to(source)


def codex_home(bundle, route, env):
    original = Path(env.get('ORCHESTRA_NATIVE_CODEX_HOME', env.get('CODEX_HOME', str(Path.home()/'.codex')))).expanduser().resolve()
    key = hashlib.sha256((str(bundle) + route).encode()).hexdigest()[:24]
    home = Path.home()/'.cache/orchestra/native-proof'/key
    home.mkdir(parents=True,exist_ok=True,mode=0o700)
    for item in ('config.toml','auth.json','.credentials.json','AGENTS.md','AGENTS.override.md','rules','plugins','mcp-oauth-locks'):
        link(original/item,home/item)
    skills=home/'skills';skills.mkdir(exist_ok=True)
    selected=bundle/route/'skills'
    selected_names={p.name for p in selected.iterdir()} if selected.exists() else set()
    if (original/'skills').exists():
        for source in (original/'skills').iterdir():
            if source.name not in selected_names:link(source,skills/source.name)
    if selected.exists():
        for source in selected.iterdir():link(source,skills/source.name)
    env['CODEX_HOME']=str(home);env['ORCHESTRA_NATIVE_CODEX_HOME']=str(original)
    return home


def command(bundle, route, headless=False, message=None, prepare=True):
    manifest=json.loads((bundle/'manifest.json').read_text())
    if route not in manifest['nodes']:
        raise ValueError('Unknown bundled child')
    node=manifest['nodes'][route];directory=bundle/route
    env=os.environ.copy()
    instructions=node.get('instructions','')
    if node['children']:
        instructions+='\nBundled child launchers (pass --message with the assigned task; do not regenerate config):\n'
        instructions+='\n'.join(f'{alias}: {directory / "dispatch" / alias}' for alias in node['children'])
    if node['harness']=='claude':
        argv=['claude','--model',node['model'],'--plugin-dir',str(directory),'--mcp-config',str(directory/'mcp.json'),'--strict-mcp-config']
        if instructions:argv+=['--append-system-prompt',instructions]
        if headless:argv+=['--print','--output-format','json']
        if message is not None:argv+=['--',message]
    else:
        if prepare:codex_home(bundle,route,env)
        argv=['codex']+(['exec','--skip-git-repo-check','--json'] if headless else [])
        argv+=['--cd',manifest['directory'],'--model',node['model']]
        if instructions:argv+=['-c','developer_instructions='+json.dumps(instructions)]
        if node.get('reasoning_effort'):argv+=['-c','model_reasoning_effort='+json.dumps(node['reasoning_effort'])]
        for key,value in node['connections'].items():
            argv+=['-c','mcp_servers.orchestra_'+key+'.url='+json.dumps(value['url'])]
        if message is not None:argv+=['--',message]
    return argv,env,manifest['directory']


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('bundle',type=Path);p.add_argument('route')
    p.add_argument('--exec',dest='headless',action='store_true');p.add_argument('--message');p.add_argument('--explain',action='store_true')
    args=p.parse_args();bundle=args.bundle.resolve()
    try:
        checks=json.loads((bundle/'checksums.json').read_text())
        actual={str(f.relative_to(bundle)):hashlib.sha256(f.read_bytes()).hexdigest() for f in bundle.rglob('*') if f.is_file() and f != bundle/'checksums.json'}
        if actual!=checks:raise ValueError('Bundle integrity check failed')
        argv,env,cwd=command(bundle,args.route,args.headless,args.message,not args.explain)
        if args.explain:
            print(json.dumps({'argv':argv,'cwd':cwd,'bundle':str(bundle),'codex_auth_reuse':'prototype; separate runtime home, native file references'},indent=2));return
        if not shutil.which(argv[0]):raise ValueError('Missing native harness: '+argv[0])
        os.chdir(cwd)
        os.execvpe(argv[0],argv,env)
    except (ValueError,OSError) as e:p.exit(1,f'error: {e}\n')

if __name__=='__main__':main()
