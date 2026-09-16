import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

export interface Connection { type: 'mcp'; url: string; auth: 'native' | 'none' }
export interface Agent {
  name: string; description?: string; mode?: 'native' | 'process'; harness: 'claude' | 'codex'; model: string;
  speed?: 'fast' | 'standard'; reasoning_effort?: string; instructions?: string; skills: string[];
  connections: Record<string, Connection>; children: Record<string, string>;
}
export interface Manifest { directory: string; workspace?: string; nodes: Record<string, Agent> }
export const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function files(root: string): string[] {
  const result: string[] = [];
  function visit(folder: string) {
    for (const entry of fs.readdirSync(folder, {withFileTypes: true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const p = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported in bundle inputs: ${p}`);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile()) result.push(p);
      else throw new Error(`Unsupported file type: ${p}`);
    }
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Symlink directory: ${root}`);
  visit(root); return result;
}
export function fileMap(root: string): Record<string,string> {
  return Object.fromEntries(files(root).filter(p=>p!==path.join(root,'checksums.json')).map(p=>[path.relative(root,p),hash(fs.readFileSync(p))]));
}
export function verify(bundle: string): void {
  const expected = JSON.parse(fs.readFileSync(path.join(bundle,'checksums.json'),'utf8'));
  if (canonical(fileMap(bundle)) !== canonical(expected)) throw new Error('Bundle integrity check failed; refusing modified bundle');
}
function link(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  let current: fs.Stats | undefined;
  try { current = fs.lstatSync(destination); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (current) {
    if (!current.isSymbolicLink() || fs.realpathSync(destination) !== fs.realpathSync(source)) throw new Error(`Conflicting runtime path: ${destination}`);
  } else fs.symlinkSync(source,destination);
}
export function codexHome(bundle: string, route: string, env: NodeJS.ProcessEnv, home = os.homedir()): string {
  const original = fs.realpathSync(env.ORCHESTRA_NATIVE_CODEX_HOME ?? env.CODEX_HOME ?? path.join(home,'.codex'));
  const runtime = path.join(home,'.cache/orchestra/native-proof',hash(bundle+route).slice(0,24));
  fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  for (const item of ['config.toml','auth.json','.credentials.json','AGENTS.md','AGENTS.override.md','rules','plugins','mcp-oauth-locks']) link(path.join(original,item),path.join(runtime,item));
  const skills = path.join(runtime,'skills'); fs.mkdirSync(skills,{recursive:true});
  const selected = path.join(bundle,route,'skills');
  const names = fs.existsSync(selected) ? fs.readdirSync(selected) : [];
  if (fs.existsSync(path.join(original,'skills'))) for (const name of fs.readdirSync(path.join(original,'skills'))) {
    if (!names.includes(name)) link(path.join(original,'skills',name),path.join(skills,name));
  }
  for (const name of names) link(path.join(selected,name),path.join(skills,name));
  env.CODEX_HOME=runtime; env.ORCHESTRA_NATIVE_CODEX_HOME=original; return runtime;
}
export interface LaunchOptions { headless?: boolean; message?: string; prepare?: boolean; env?: NodeJS.ProcessEnv; home?: string }
export function command(bundle: string, route: string, options: LaunchOptions = {}) {
  const manifest: Manifest=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json'),'utf8'));
  const agent=manifest.nodes[route]; if (!agent) throw new Error('Unknown bundled child');
  const directory=path.join(bundle,route); const env={...(options.env ?? process.env)};
  let instructions=agent.instructions ?? '';
  if (Object.keys(agent.children).length) {
    instructions+='\nBundled children (use native delegation for native roles; process launchers accept --message; do not regenerate config):\n';
    instructions+=Object.entries(agent.children).map(([alias,childRoute])=>manifest.nodes[childRoute]!.mode==='native' ? `${alias}: native subagent (${manifest.nodes[childRoute]!.description ?? alias}). Use native delegation and follow-up tools.` : `${alias}: ${path.join(directory,'dispatch',alias)}`).join('\n');
  }
  let argv: string[];
  if (agent.harness==='claude') {
    argv=['claude','--model',agent.model,'--plugin-dir',directory,'--mcp-config',path.join(directory,'mcp.json'),'--strict-mcp-config'];
    const native=Object.fromEntries(Object.entries(agent.children).filter(([,r])=>manifest.nodes[r]!.mode==='native').map(([alias])=>[alias,JSON.parse(fs.readFileSync(path.join(directory,'native-agents',alias+'.json'),'utf8'))]));
    if (Object.keys(native).length) argv.push('--agents',JSON.stringify(native));
    if (agent.reasoning_effort) argv.push('--effort',agent.reasoning_effort);
    if (instructions) argv.push('--append-system-prompt',instructions);
    if (options.headless) argv.push('--print','--output-format','json');
  } else {
    if (options.prepare!==false) codexHome(bundle,route,env,options.home);
    argv=['codex',...(options.headless ? ['exec','--skip-git-repo-check','--json'] : []),'--cd',manifest.directory,'--model',agent.model];
    if (instructions) argv.push('-c','developer_instructions='+JSON.stringify(instructions));
    if (agent.reasoning_effort) argv.push('-c','model_reasoning_effort='+JSON.stringify(agent.reasoning_effort));
    for (const [alias,childRoute] of Object.entries(agent.children)) if (manifest.nodes[childRoute]!.mode==='native') {
      argv.push('-c',`agents.${alias}.description=${JSON.stringify(manifest.nodes[childRoute]!.description ?? alias)}`,'-c',`agents.${alias}.config_file=${JSON.stringify(path.join(directory,'native-agents',alias+'.toml'))}`);
    }
    if (agent.speed) argv.push('-c','service_tier='+JSON.stringify(agent.speed==='fast' ? 'fast' : 'default'));
    for (const [key,value] of Object.entries(agent.connections)) argv.push('-c',`mcp_servers.orchestra_${key}.url=${JSON.stringify(value.url)}`);
  }
  if (options.message!==undefined) argv.push('--',options.message);
  return {argv,env,cwd:manifest.directory};
}
export function execute(argv: string[], cwd: string, environment: NodeJS.ProcessEnv): never {
  if (process.platform==='win32' || !process.execve) throw new Error('Native launch requires Node 22.15+ on macOS or Linux');
  const name=argv[0]!;
  const executable=(environment.PATH ?? '').split(path.delimiter).map(p=>path.resolve(p,name)).find(p=>{
    try { fs.accessSync(p,fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error(`Missing native harness: ${name}`);
  const env=Object.fromEntries(Object.entries(environment).filter((pair): pair is [string,string]=>pair[1]!==undefined));
  process.chdir(cwd);
  // Replace this process: native terminal, signals, and exit status pass through.
  process.execve(executable,argv,env);
  throw new Error('Native exec unexpectedly returned');
}
export function run(bundle: string, route: string, args: string[]): void {
  const {values}=parseArgs({args,options:{exec:{type:'boolean'},message:{type:'string'},explain:{type:'boolean'}},strict:true});
  verify(bundle);
  const launch=command(bundle,route,{headless:values.exec,message:values.message,prepare:!values.explain});
  if (values.explain) console.log(JSON.stringify({argv:launch.argv,cwd:launch.cwd,bundle},null,2));
  else execute(launch.argv,launch.cwd,launch.env);
}
