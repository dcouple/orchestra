import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {resolve} from './compiler.js';

type Harness = 'claude' | 'codex';
interface Entry { source: string; destination: string }
interface Loaded { profile: string; harness: Harness; root: string; skills: Entry[] }
interface State { version: 1; profiles: Record<string,Loaded> }
export interface UserSkillOptions { home?: string; env?: NodeJS.ProcessEnv; harness?: string }
function harness(value: string): Harness {
  if (value!=='claude' && value!=='codex') throw new Error('harness must be claude or codex');
  return value;
}
function stat(file: string) {
  try { return fs.lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw e; }
}
function owned(entry: Entry): boolean {
  return !!stat(entry.destination)?.isSymbolicLink() && path.resolve(path.dirname(entry.destination),fs.readlinkSync(entry.destination))===entry.source;
}
function withState<T>(options: UserSkillOptions, action: (state: State, save: ()=>void)=>T): T {
  const dir=path.join(options.home ?? os.homedir(),'.local/state/orchestra/user-skills');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=path.join(dir,'lock');
  try { fs.mkdirSync(lock); } catch (e) {
    if ((e as NodeJS.ErrnoException).code==='EEXIST') throw new Error(`Another skill operation is active (or left a stale lock): ${lock}`);
    throw e;
  }
  const file=path.join(dir,'state.json');
  try {
    const state: State=fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {version:1,profiles:{}};
    if (state.version!==1 || !state.profiles || typeof state.profiles!=='object' || Array.isArray(state.profiles)) throw new Error('Invalid user-skill ownership registry');
    return action(state,()=>{
      const temp=path.join(dir,'state.tmp');
      fs.writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600});
      fs.renameSync(temp,file);
    });
  } finally { fs.rmdirSync(lock); }
}
export function loadedProfiles(options: UserSkillOptions={}): Loaded[] {
  return withState(options,state=>Object.values(state.profiles));
}
export function loadProfile(root: string, profile: string, options: UserSkillOptions={}): Loaded {
  root=fs.realpathSync(root);
  const agent=resolve(root,profile).main!;
  const selected=harness(options.harness ?? agent.harness);
  const home=options.home ?? os.homedir(),env=options.env ?? process.env;
  const nativeHome=selected==='codex' ? env.ORCHESTRA_NATIVE_CODEX_HOME ?? env.CODEX_HOME ?? path.join(home,'.codex') : env.CLAUDE_CONFIG_DIR ?? path.join(home,'.claude');
  const directory=path.resolve(nativeHome,'skills');
  return withState(options,(state,save)=>{
    fs.mkdirSync(directory,{recursive:true});
    const target=fs.realpathSync(directory);
    const item: Loaded={profile,harness:selected,root,skills:agent.skills.map(skill=>({source:fs.realpathSync(path.join(root,'skills',skill)),destination:path.join(target,skill)}))};
    const key=selected+':'+profile,previous=state.profiles[key];
    if (previous) {
      if (JSON.stringify(previous)!==JSON.stringify(item)) throw new Error('Profile selection changed; unload the existing profile before loading it again');
      for (const entry of previous.skills) if (!owned(entry)) throw new Error(`Managed skill changed or disappeared; preserving it: ${entry.destination}`);
      return previous;
    }
    const tracked=Object.values(state.profiles).flatMap(p=>p.skills);
    for (const entry of item.skills) {
      const shared=tracked.find(e=>e.destination===entry.destination);
      if (shared && (shared.source!==entry.source || !owned(shared))) throw new Error(`Conflicting managed skill: ${entry.destination}`);
      if (!shared && stat(entry.destination)) throw new Error(`Existing user skill will not be overwritten: ${entry.destination}`);
    }
    const created: Entry[]=[];
    try {
      for (const entry of item.skills) if (!tracked.some(e=>e.destination===entry.destination)) {
        fs.symlinkSync(entry.source,entry.destination); created.push(entry);
      }
      state.profiles[key]=item;save();
    } catch (e) {
      for (const entry of created.reverse()) if (owned(entry)) fs.unlinkSync(entry.destination);
      throw e;
    }
    return item;
  });
}
export function unloadProfile(profile: string, options: UserSkillOptions={}): Loaded[] {
  if (options.harness) harness(options.harness);
  return withState(options,(state,save)=>{
    const matches=Object.entries(state.profiles).filter(([,p])=>p.profile===profile && (!options.harness || p.harness===options.harness));
    if (!matches.length) throw new Error(`Profile is not loaded: ${profile}`);
    const remaining=Object.entries(state.profiles).filter(([key])=>!matches.some(([remove])=>remove===key));
    const retained=new Set(remaining.flatMap(([,p])=>p.skills.map(s=>s.destination)));
    const removals=[...new Map(matches.flatMap(([,p])=>p.skills).filter(s=>!retained.has(s.destination)).map(s=>[s.destination,s])).values()];
    // Preflight everything before removing anything. Missing links are already unloaded.
    for (const entry of removals) if (stat(entry.destination) && !owned(entry)) throw new Error(`Managed skill was replaced; preserving it: ${entry.destination}`);
    const removed: Entry[]=[];
    try {
      for (const entry of removals) if (owned(entry)) { fs.unlinkSync(entry.destination); removed.push(entry); }
      for (const [key] of matches) delete state.profiles[key];
      save();
    } catch (e) {
      for (const entry of removed) if (!stat(entry.destination)) fs.symlinkSync(entry.source,entry.destination);
      throw e;
    }
    return matches.map(([,p])=>p);
  });
}
