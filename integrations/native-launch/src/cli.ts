#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {build} from './compiler.js';
import {run} from './runtime.js';
try {
  const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{
    'config-root':{type:'string',default:path.join(os.homedir(),'.config/orchestra')},
    workspace:{type:'string'},directory:{type:'string',default:process.cwd()},
    build:{type:'boolean'},exec:{type:'boolean'},message:{type:'string'},explain:{type:'boolean'},help:{type:'boolean',short:'h'}
  }});
  if (values.help) {
    console.log('Usage: orchestra agent NAME [--workspace NAME] [--directory PATH] [--config-root PATH]\n                       [--message TEXT] [--build | --explain | --exec]\nOpens the native Claude Code or Codex TUI. Requires Node 22.15+ on macOS/Linux.');
  } else {
    if (positionals.length!==2 || positionals[0]!=='agent') throw new Error('Use: orchestra agent NAME (see --help)');
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
