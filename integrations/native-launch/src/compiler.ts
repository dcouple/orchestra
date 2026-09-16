import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { canonical, command, execute, files, fileMap, hash, verify, type Agent, type Connection, type Manifest } from './runtime.js';
export {command, execute};
function name(value: unknown): string {
  if (typeof value!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Expected a lowercase configuration name, not a path');
  return value;
}
function mapping(value: unknown): Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Expected a YAML mapping');
  return value as Record<string,unknown>;
}
function fields(data: Record<string,unknown>, allowed: string[]) {
  const extra=Object.keys(data).filter(k=>!allowed.includes(k));
  if (extra.length) throw new Error('Unsupported prototype fields: '+extra.join(', '));
}
function read(file: string) {
  const doc=parseDocument(fs.readFileSync(file,'utf8'),{uniqueKeys:true});
  if (doc.errors.length) throw new Error(`${file}: ${doc.errors.map(e=>e.message).join('; ')}`);
  return mapping(doc.toJS({maxAliasCount:100}));
}
function connections(value: unknown): Record<string,Connection> {
  const result: Record<string,Connection>=Object.create(null);
  for (const [key,input] of Object.entries(mapping(value))) {
    name(key); const item=mapping(input); fields(item,['type','url','auth']);
    if (item.type!=='mcp' || !['native','none'].includes(String(item.auth)) || typeof item.url!=='string') throw new Error('Only HTTPS MCP with auth=native or none is supported');
    const url=new URL(item.url);
    if (url.protocol!=='https:' || !url.hostname || url.username || url.password || url.search || url.hash || /\s/.test(item.url)) throw new Error('Use an HTTPS endpoint without credentials or query parameters');
    result[key]={type:'mcp',url:item.url,auth:item.auth as Connection['auth']};
  }
  return result;
}
export function resolve(root: string, agent: string, workspace?: string): Record<string,Agent> {
  let defaults: Record<string,Connection>={};
  if (workspace) {
    const ws=read(path.join(root,'workspaces',name(workspace)+'.yaml'));
    fields(ws,['connections']); defaults=connections(ws.connections ?? {});
  }
  const nodes: Record<string,Agent>=Object.create(null);
  function visit(agentName: string, trail: string[], route: string) {
    name(agentName); if (trail.includes(agentName)) throw new Error('Child-agent cycle: '+[...trail,agentName].join(' -> '));
    const data=read(path.join(root,'agents',agentName+'.yaml'));
    fields(data,['harness','model','reasoning_effort','instructions','skills','connections','subagents']);
    if (data.harness!=='claude' && data.harness!=='codex') throw new Error('harness must be claude or codex');
    if (typeof data.model!=='string' || !data.model.trim()) throw new Error('Every agent requires a model');
    for (const key of ['instructions','reasoning_effort']) if (data[key]!==undefined && typeof data[key]!=='string') throw new Error(`${key} must be text`);
    const skills=data.skills ?? [];
    if (!Array.isArray(skills) || skills.some(s=>typeof s!=='string') || new Set(skills).size!==skills.length) throw new Error('skills must be a unique list of local directory names');
    for (const skill of skills) {
      const folder=path.join(root,'skills',name(skill));
      if (!fs.existsSync(path.join(folder,'SKILL.md'))) throw new Error(`Missing local skill: ${skill}`);
      files(folder);
    }
    const merged={...defaults};
    for (const [key,value] of Object.entries(connections(data.connections ?? {}))) {
      if (merged[key] && canonical(merged[key])!==canonical(value)) throw new Error(`Conflicting connection ${key}`);
      merged[key]=value;
    }
    const node: Agent={name:agentName,harness:data.harness,model:data.model,instructions:data.instructions as string|undefined,reasoning_effort:data.reasoning_effort as string|undefined,skills,connections:merged,children:Object.create(null)};
    nodes[route]=node;
    for (const [alias,child] of Object.entries(mapping(data.subagents ?? {}))) {
      name(alias); name(child);
      const childRoute=route+'/children/'+alias;
      node.children[alias]=childRoute;
      visit(child as string,[...trail,agentName],childRoute);
    }
  }
  visit(agent,[],'main'); return nodes;
}
export function build(root: string, agent: string, target: string, workspace?: string): string {
  root=fs.realpathSync(root); target=fs.realpathSync(target);
  if (!fs.statSync(target).isDirectory()) throw new Error('Target must be a directory');
  const nodes=resolve(root,agent,workspace);
  const manifest: Manifest={nodes,directory:target,workspace};
  const sources=new Map<string,{content:Buffer;mode:number}>();
  for (const node of Object.values(nodes)) for (const skill of node.skills) for (const p of files(path.join(root,'skills',skill))) {
    sources.set(path.relative(path.join(root,'skills'),p),{content:fs.readFileSync(p),mode:fs.statSync(p).mode & 0o111});
  }
  const runtime=fs.readFileSync(fileURLToPath(new URL('./runtime.js',import.meta.url)));
  const digest=hash(canonical({manifest,compiler:hash(fs.readFileSync(fileURLToPath(import.meta.url))),runtime:hash(runtime),skills:[...sources].sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,hash(v.content),v.mode])}));
  const bundle=path.join(target,'.orchestra/generated',`${name(agent)}-${workspace ?? 'none'}-${digest.slice(0,20)}`);
  if (fs.existsSync(bundle)) { verify(bundle); return bundle; }
  fs.mkdirSync(path.dirname(bundle),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(bundle),'.building-'));
  function write(relative: string, data: string|Buffer, mode=0o644) {
    const p=path.join(staging,relative); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,data,{mode});
  }
  try {
    write('runtime.mjs',runtime);
    for (const [route,node] of Object.entries(nodes)) {
      for (const skill of node.skills) for (const [key,value] of sources) if (key.startsWith(skill+path.sep)) write(path.join(route,'skills',key),value.content,value.mode ? 0o755 : 0o644);
      write(path.join(route,'agent.json'),JSON.stringify(node,null,2));
      if (node.harness==='claude') {
        write(path.join(route,'.claude-plugin/plugin.json'),JSON.stringify({name:'orchestra-'+node.name,version:'0.1.0'}));
        write(path.join(route,'mcp.json'),JSON.stringify({mcpServers:Object.fromEntries(Object.entries(node.connections).map(([k,v])=>['orchestra_'+k,{type:'http',url:v.url}]))},null,2));
      }
      for (const [alias,childRoute] of Object.entries(node.children)) {
        write(path.join(route,'dispatch',alias),'#!/usr/bin/env node\nimport('+JSON.stringify(pathToFileURL(path.join(bundle,'runtime.mjs')).href)+').then(m=>m.run('+JSON.stringify(bundle)+','+JSON.stringify(childRoute)+',["--exec",...process.argv.slice(2)])).catch(e=>{console.error("error:",e.message);process.exitCode=1;});\n',0o755);
      }
    }
    write('manifest.json',JSON.stringify(manifest,null,2));
    write('checksums.json',JSON.stringify(fileMap(staging),null,2));
    try { fs.renameSync(staging,bundle); } catch (e) {
      if (!fs.existsSync(bundle)) throw e;
      verify(bundle);
      if (canonical(fileMap(bundle))!==canonical(fileMap(staging))) throw e;
    }
  } finally { fs.rmSync(staging,{recursive:true,force:true}); }
  return bundle;
}
