#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {build} from './compiler.js';
import {run} from './runtime.js';
import {inspectProfile,listProfiles} from './inspect.js';
import {loadProfile,unloadProfile,loadedProfiles} from './user-skills.js';
try {
  const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{
    'config-root':{type:'string',default:path.join(os.homedir(),'.config/orchestra')},
    harness:{type:'string'},workspace:{type:'string'},directory:{type:'string',default:process.cwd()},
    build:{type:'boolean'},exec:{type:'boolean'},message:{type:'string'},explain:{type:'boolean'},help:{type:'boolean',short:'h'}
  }});
  if (values.help) {
    console.log('Usage: orchestra run NAME [--workspace NAME] [--directory PATH] [--config-root PATH]\n                       [--message TEXT] [--build | --explain | --exec]\nInspect: orchestra profiles list [--config-root PATH]\n         orchestra inspect NAME [--workspace NAME] [--config-root PATH]\nUser skills: orchestra load NAME [--harness claude|codex] [--config-root PATH]\n             orchestra unload NAME [--harness claude|codex]\n             orchestra loaded\nOpens the native Claude Code or Codex TUI. Requires Node 22.15+ on macOS/Linux.');
  } else if (positionals[0]==='profiles' || positionals[0]==='inspect') {
    if (positionals.length!==2 || (positionals[0]==='profiles' && positionals[1]!=='list')) throw new Error('Use: orchestra profiles list or orchestra inspect NAME');
    if (values.harness || values.message!==undefined || values.build || values.exec || values.explain) throw new Error('Inspection does not accept launch options');
    const root=path.resolve(values['config-root']!);
    if (positionals[0]==='inspect') console.log(JSON.stringify(inspectProfile(root,positionals[1]!,values.workspace),null,2));
    else {
      if (values.workspace) throw new Error('Use inspect NAME --workspace NAME to inspect workspace connections');
      const profiles=listProfiles(root);
      console.log(profiles.length ? profiles.map(p=>`${p.profile} -> ${p.agent} | ${p.harness} | ${p.model.name} ${p.model.reasoning ?? 'default'} | ${p.model.speed}`).join('\n') : 'No launch profiles found.');
    }
  } else if (['load','unload','loaded'].includes(positionals[0] ?? '')) {
    const operation=positionals[0];
    if (positionals.length!==(operation==='loaded' ? 1 : 2)) throw new Error('Use: orchestra load NAME, unload NAME, or loaded');
    if (values.workspace || values.message!==undefined || values.build || values.exec || values.explain || process.argv.includes('--directory') || process.argv.some(a=>a.startsWith('--directory='))) throw new Error('User-skill commands do not accept launch options');
    if (operation==='loaded') {
      if (values.harness) throw new Error('orchestra loaded lists all harnesses');
      const entries=loadedProfiles();
      console.log(entries.length ? entries.map(p=>`${p.profile} (${p.harness}): ${p.skills.map(s=>path.basename(s.destination)).join(', ') || 'no skills'}`).join('\n') : 'No profiles loaded into user skills.');
    } else if (operation==='load') {
      const entry=loadProfile(path.resolve(values['config-root']!),positionals[1]!,{harness:values.harness});
      console.log(`Loaded ${entry.profile}: ${entry.skills.length} skills for ${entry.harness}. Skills only; start a fresh native session to verify discovery.`);
    } else {
      const entries=unloadProfile(positionals[1]!,{harness:values.harness});
      console.log(`Unloaded ${entries.map(p=>p.profile+' ('+p.harness+')').join(', ')}. Shared skills remain loaded. Start a fresh session to clear previously loaded context.`);
    }
  } else {
    if (values.harness) throw new Error('--harness is only supported by load/unload; run uses the profile harness');
    if (positionals.length!==2 || !['run','agent'].includes(positionals[0]!)) throw new Error('Use: orchestra run NAME (see --help)');
    if ([values.build,values.explain,values.exec].filter(Boolean).length>1) throw new Error('Choose only one of --build, --explain or --exec');
    const bundle=build(path.resolve(values['config-root']!),positionals[1]!,path.resolve(values.directory!),values.workspace);
    if (values.build) console.log(bundle);
    else {
      const args: string[]=[];
      if (values.exec) args.push('--exec');
      if (values.explain) args.push('--explain');
      if (values.message!==undefined) args.push('--message',values.message);
      run(bundle,'main',args);
    }
  }
} catch (error) { console.error('error:',error instanceof Error ? error.message : error); process.exitCode=1; }
