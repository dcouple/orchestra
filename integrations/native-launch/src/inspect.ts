import fs from 'node:fs';
import path from 'node:path';
import {resolve} from './compiler.js';

export function inspectProfile(root: string, profile: string, workspace?: string) {
  root=fs.realpathSync(root);
  const nodes=resolve(root,profile,workspace);
  const profileFile=path.join(root,'profiles',profile+'.yaml');
  return {profile,profile_file:fs.existsSync(profileFile) ? profileFile : undefined,
    workspace,workspace_file:workspace ? path.join(root,'workspaces',workspace+'.yaml') : undefined,
    agents:Object.fromEntries(Object.entries(nodes).map(([route,agent])=>[route,{
      agent:agent.name,source_file:agent.source_file,harness:agent.harness,
      model:{name:agent.model,reasoning:agent.reasoning_effort,speed:agent.speed ?? 'native default'},
      mode:route==='main' ? 'entry point' : agent.mode,description:agent.description,
      skills:agent.skills.map(name=>({name,source_file:path.join(root,'skills',name,'SKILL.md')})),
      connections:agent.connections,subagents:agent.children
    }]))};
}
export function listProfiles(root: string) {
  const directory=path.join(root,'profiles');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name=>name.endsWith('.yaml')).sort().map(file=>{
    const profile=file.slice(0,-5),info=inspectProfile(root,profile),agent=info.agents.main!;
    return {profile,agent:agent.agent,harness:agent.harness,model:agent.model,source_file:info.profile_file};
  });
}
