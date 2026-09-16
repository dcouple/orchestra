import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {build} from '../dist/compiler.js';
import {command,fileMap,verify} from '../dist/runtime.js';
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
function fixture(t) {
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orchestra-ts-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'config'),target=path.join(base,'repo with spaces');fs.mkdirSync(target);
 const put=(p,s)=>{const f=path.join(root,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
 put('agents/planner.yaml','harness: claude\nmodel: sonnet\nskills: [proof]\nsubagents: {worker: worker}\n');
 put('agents/worker.yaml','harness: codex\nmodel: gpt-6-astra\nskills: [proof]\n');
 put('skills/proof/SKILL.md','---\nname: proof\ndescription: Test\n---\nPROOF\n');put('skills/proof/helper.txt','SUPPORT');
 put('workspaces/test.yaml','connections:\n  docs:\n    type: mcp\n    auth: none\n    url: https://example.com/mcp\n');
 return {base,root,target,put,build:()=>build(root,'planner',target,'test')};
}
test('complete child/support bundle reuses inputs',t=>{
 const f=fixture(t),b=f.build();assert.equal(f.build(),b);
 assert.equal(fs.readFileSync(path.join(b,'main/children/worker/skills/proof/helper.txt'),'utf8'),'SUPPORT');
 const m=JSON.parse(fs.readFileSync(path.join(b,'manifest.json')));
 assert.deepEqual(m.nodes.main.connections,m.nodes['main/children/worker'].connections);
 assert.equal(m.directory,f.target);verify(b);
});
test('changed skills coexist with unchanged old bundle',t=>{
 const f=fixture(t),b=f.build(),before=fileMap(b);f.put('skills/proof/helper.txt','NEW');
 assert.notEqual(f.build(),b);assert.deepEqual(fileMap(b),before);
});
test('modified or unexpected files fail integrity',t=>{
 const f=fixture(t),b=f.build();fs.writeFileSync(path.join(b,'extra.txt'),'oops');
 assert.throws(()=>f.build(),/integrity/);assert.throws(()=>verify(b),/integrity/);
});
test('nested checksum support files are protected',t=>{
 const f=fixture(t);f.put('skills/proof/checksums.json','{}');const b=f.build();
 fs.writeFileSync(path.join(b,'main/skills/proof/checksums.json'),'changed');assert.throws(()=>verify(b),/integrity/);
});
test('cycles and unsupported fields fail before generation',t=>{
 const f=fixture(t);f.put('agents/worker.yaml','harness: codex\nmodel: test\nsubagents: {parent: planner}\n');assert.throws(f.build,/cycle/);
 f.put('agents/worker.yaml','harness: codex\nmodel: test\nmax_calls: 2\n');assert.throws(f.build,/Unsupported/);
 assert.equal(fs.existsSync(path.join(f.target,'.orchestra')),false);
});
test('malformed and duplicate YAML entries fail',t=>{
 const f=fixture(t);f.put('agents/planner.yaml','harness: claude\nmodel: test\nskills: [{source: remote}]\n');assert.throws(f.build,/unique list/);
 f.put('agents/planner.yaml','harness: claude\nmodel: one\nmodel: two\n');assert.throws(f.build,/unique/);
});
test('conflicting endpoints and secret URLs fail',t=>{
 const f=fixture(t);f.put('agents/planner.yaml','harness: claude\nmodel: test\nconnections:\n  docs:\n    type: mcp\n    auth: none\n    url: https://different.example/mcp\n');assert.throws(f.build,/Conflicting/);
 f.put('workspaces/test.yaml','connections:\n  docs:\n    type: mcp\n    auth: native\n    url: https://example.com/mcp?token=secret\n');assert.throws(f.build,/credentials/);
});
test('symlink skill inputs fail',t=>{
 const f=fixture(t);fs.symlinkSync(path.join(f.root,'skills/proof/helper.txt'),path.join(f.root,'skills/proof/link'));assert.throws(f.build,/Symlink/);
});
test('Claude command preserves cwd and literal starter',t=>{
 const f=fixture(t),b=f.build(),r=command(b,'main',{message:'$(not-a-command)',prepare:false});
 assert.equal(r.cwd,f.target);assert.deepEqual(r.argv.slice(-2),['--','$(not-a-command)']);assert.ok(r.argv.includes('--plugin-dir'));
 assert.ok(r.argv.some(s=>s.includes(path.join(b,'main/dispatch/worker'))));
});
test('Codex references native auth without copying payloads',t=>{
 const f=fixture(t),b=f.build(),home=path.join(f.base,'home'),original=path.join(home,'.codex');fs.mkdirSync(original,{recursive:true});
 fs.writeFileSync(path.join(original,'auth.json'),'SECRET-FIXTURE');fs.writeFileSync(path.join(original,'config.toml'),'');
 const r=command(b,'main/children/worker',{home,env:{CODEX_HOME:original}});
 assert.equal(fs.realpathSync(path.join(r.env.CODEX_HOME,'auth.json')),path.join(original,'auth.json'));
 assert.ok(fs.lstatSync(path.join(r.env.CODEX_HOME,'auth.json')).isSymbolicLink());
 for (const p of Object.keys(fileMap(b))) assert.equal(fs.readFileSync(path.join(b,p),'utf8').includes('SECRET-FIXTURE'),false);
});
test('profiles coexist without changing repo instructions',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.target,'AGENTS.md'),'ORIGINAL');const b=f.build();
 assert.notEqual(build(f.root,'worker',f.target,'test'),b);assert.equal(fs.readFileSync(path.join(f.target,'AGENTS.md'),'utf8'),'ORIGINAL');
});
test('child aliases cannot collide with bundle support directories',t=>{
 const f=fixture(t);f.put('agents/planner.yaml','harness: claude\nmodel: test\nskills: [proof]\nsubagents: {skills: worker, dispatch: worker}\n');
 const b=f.build();verify(b);assert.ok(fs.existsSync(path.join(b,'main/children/skills/agent.json')));
});
test('native exec preserves args, cwd, environment and exit status; dispatch runs standalone',t=>{
 const f=fixture(t),bin=path.join(f.base,'bin'),home=path.join(f.base,'home');fs.mkdirSync(bin);fs.mkdirSync(path.join(home,'.codex'),{recursive:true});
 const out=path.join(f.base,'record.json');
 const script=`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.RECORD,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.CODEX_HOME}));process.exit(7);\n`;
 for(const harness of ['claude','codex'])fs.writeFileSync(path.join(bin,harness),script,{mode:0o755});
 const env={...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),ORCHESTRA_NATIVE_CODEX_HOME:path.join(home,'.codex'),PATH:bin+path.delimiter+process.env.PATH,RECORD:out};
 const message='$(touch NEVER) `echo no`\nquoted "text"';
 const run=spawnSync(process.execPath,[cli,'agent','planner','--config-root',f.root,'--directory',f.target,'--message',message],{env,encoding:'utf8'});
 assert.equal(run.status,7,run.stderr);let result=JSON.parse(fs.readFileSync(out));assert.equal(result.cwd,f.target);assert.deepEqual(result.args.slice(-2),['--',message]);
 const b=f.build();const child=spawnSync(path.join(b,'main/dispatch/worker'),['--message',message],{env,encoding:'utf8'});
 assert.equal(child.status,7,child.stderr);result=JSON.parse(fs.readFileSync(out));assert.equal(result.cwd,f.target);assert.equal(result.args[0],'exec');assert.deepEqual(result.args.slice(-2),['--',message]);
 assert.ok(result.home.includes('.cache/orchestra/native-proof'));assert.equal(fs.existsSync(path.join(f.target,'NEVER')),false);verify(b);
});
test('profile model settings reach both native harnesses and override legacy entrypoints',t=>{
 const f=fixture(t);
 f.put('agents/planner.yaml','harness: claude\nmodel: {name: claude-fable-5-1, reasoning: high}\nskills: [proof]\n');
 let b=f.build(),r=command(b,'main',{prepare:false});
 assert.equal(r.argv[r.argv.indexOf('--model')+1],'claude-fable-5-1');
 assert.equal(r.argv[r.argv.indexOf('--effort')+1],'high');
 f.put('agents/planner.yaml','harness: codex\nmodel: {name: gpt-6-astra, reasoning: medium, speed: fast}\nskills: [proof]\n');
 b=f.build();r=command(b,'main',{prepare:false});
 assert.ok(r.argv.includes('model_reasoning_effort="medium"'));
 assert.ok(r.argv.includes('service_tier="fast"'));
 const result=spawnSync(process.execPath,[cli,'run','planner','--config-root',f.root,'--directory',f.target,'--explain'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.ok(JSON.parse(result.stdout).argv.includes('service_tier="fast"'));
});
test('invalid model settings fail rather than silently dropping options',t=>{
 const f=fixture(t);
 for(const model of ['{name: test, reasoning: typo}','{name: test, speed: fast}','{name: test, typo: high}']) {
  f.put('agents/planner.yaml',`harness: claude\nmodel: ${model}\n`);
  assert.throws(f.build,/Unsupported|model.speed/);
 }
 f.put('agents/planner.yaml','harness: codex\nmodel: {name: test, reasoning: high}\nreasoning_effort: medium\n');
 assert.throws(f.build,/model.reasoning/);
});
test('profiles select agents and reject behavior overrides',t=>{
 const f=fixture(t);
 f.put('agents/base.md','---\nharness: codex\nmodel: {name: first, reasoning: medium, speed: fast}\nskills: [proof]\n---\nBase intent.\n');
 f.put('profiles/entry.yaml','agent: base\n');
 const b=build(f.root,'entry',f.target),m=JSON.parse(fs.readFileSync(path.join(b,'manifest.json')));
 assert.equal(m.nodes.main.name,'base');assert.equal(m.nodes.main.speed,'fast');
 assert.equal(m.nodes.main.instructions,'Base intent.');
 for(const extra of ['model: second','instructions: Extra','subagents: {}','harness: claude','skills: []']){
  f.put('profiles/entry.yaml',`agent: base\n${extra}\n`);assert.throws(()=>build(f.root,'entry',f.target),/Unsupported/);
 }
 f.put('profiles/entry.yaml','agent: missing\n');assert.throws(()=>build(f.root,'entry',f.target),/ENOENT/);
});
test('native Codex roles retain child model and skill paths and inherit parent connections',t=>{
 const f=fixture(t);
 f.put('agents/planner.yaml','harness: codex\nmodel: {name: parent, reasoning: medium, speed: fast}\nsubagents:\n  proof-worker:\n    agent: worker\n    mode: native\n    model: {name: child, reasoning: max}\n    description: Check the proof.\nconnections:\n  extra:\n    type: mcp\n    auth: native\n    url: https://extra.example/mcp\n');
 const b=f.build(),r=command(b,'main',{prepare:false});
 const file=path.join(b,'main/native-agents/proof-worker.toml'),s=fs.readFileSync(file,'utf8');
 assert.ok(r.argv.includes('agents.proof-worker.config_file='+JSON.stringify(file)));
 assert.match(s,/model = "child"/);assert.match(s,/model_reasoning_effort = "max"/);
 assert.match(s,/service_tier = "default"/);assert.match(s,/extra.example/);assert.match(s,/example.com/);
 assert.ok(s.includes(path.join(b,'main/children/proof-worker/skills/proof/SKILL.md')));
 assert.equal(fs.existsSync(path.join(b,'main/dispatch/proof-worker')),false);
});
test('native Claude definitions use configured model effort and child prompt',t=>{
 const f=fixture(t);
 f.put('agents/planner.yaml','harness: claude\nmodel: test\nsubagents:\n  worker:\n    agent: worker\n    mode: native\n    harness: claude\n    model: {name: claude-fable-5-1, reasoning: high}\n');
 const b=f.build(),r=command(b,'main',{prepare:false});
 const roles=JSON.parse(r.argv[r.argv.indexOf('--agents')+1]);
 assert.equal(roles.worker.model,'claude-fable-5-1');assert.equal(roles.worker.effort,'high');
 assert.ok(roles.worker.prompt.includes('/skills/proof/SKILL.md'));
});
test('unsupported native delegation cannot silently become a process',t=>{
 const f=fixture(t);
 f.put('agents/planner.yaml','harness: claude\nmodel: test\nsubagents: {worker: {agent: worker, mode: native}}\n');
 assert.throws(f.build,/parent harness/);
 f.put('agents/planner.yaml','harness: codex\nmodel: test\nsubagents: {worker: {agent: worker, mode: unknown}}\n');
 assert.throws(f.build,/mode/);
});
test('directory agents compose Markdown and invalidate bundles',t=>{
 const f=fixture(t);
 f.put('agents/writer/agent.yaml','harness: codex\nmodel: test\ninstructions_files: [../../instructions/shared.md, instructions.md]\n');
 f.put('instructions/shared.md','Shared guidance.');f.put('agents/writer/instructions.md','Role guidance.');
 f.put('profiles/writer.yaml','agent: writer\n');
 const b=build(f.root,'writer',f.target);
 assert.equal(fs.readFileSync(path.join(b,'main/instructions.md'),'utf8'),'Shared guidance.\n\nRole guidance.');
 f.put('instructions/shared.md','Updated guidance.');assert.notEqual(build(f.root,'writer',f.target),b);verify(b);
});
test('instruction files fail on missing files, escapes, and ambiguous sources',t=>{
 const f=fixture(t);
 const run=()=>build(f.root,'writer',f.target);
 f.put('agents/writer/agent.yaml','harness: codex\nmodel: test\ninstructions_file: missing.md\n');assert.throws(run,/ENOENT/);
 fs.writeFileSync(path.join(f.base,'outside.md'),'outside');
 f.put('agents/writer/agent.yaml','harness: codex\nmodel: test\ninstructions_file: ../../../outside.md\n');assert.throws(run,/configuration root/);
 f.put('agents/writer/agent.yaml','harness: codex\nmodel: test\ninstructions_file: instructions.md\ninstructions: inline\n');assert.throws(run,/one instructions source/);
 f.put('agents/writer.yaml','harness: codex\nmodel: test\n');assert.throws(run,/Ambiguous/);
});
test('shipped Astra profiles package all declared workflow roles and their own skills',t=>{
 const f=fixture(t),source=fileURLToPath(new URL('..',import.meta.url));
 fs.cpSync(path.join(source,'agents'),path.join(f.root,'agents'),{recursive:true});
 fs.cpSync(path.join(source,'profiles'),path.join(f.root,'profiles'),{recursive:true});
 // Fixture skill contents isolate graph correctness from a machine's installed skill repository.
 const skills=['create-ticket','explain-visually','astra-ticket','simple-plan','create-plan','prepare-pr','pr-test-automation','review','cold-read','excalidraw-pr-diagrams','implementer','implementation-reviewer','plan-reviewer','codebase-explorer','researcher','research-web','investigate'];
 for(const skill of skills)f.put(`skills/${skill}/SKILL.md`,skill);
 // Remove legacy fixture planner so the new directory definition is unambiguous.
 fs.unlinkSync(path.join(f.root,'agents/planner.yaml'));fs.unlinkSync(path.join(f.root,'agents/worker.yaml'));
 const b=build(f.root,'implementer',f.target,'test'),m=JSON.parse(fs.readFileSync(path.join(b,'manifest.json')));
 assert.deepEqual(Object.keys(m.nodes.main.children).sort(),['socrates','worker','implementation-reviewer','plan-reviewer','codebase-explorer','researcher','pr-preparer','pr-reviewer','qa','cold-reader'].sort());
 for(const [alias,route] of Object.entries(m.nodes.main.children)){
  const child=m.nodes[route];assert.equal(child.model,alias==='qa'?'gpt-5.6-sol':'gpt-5.6-luna');assert.equal(child.reasoning_effort,alias==='qa'?'medium':'max');
  assert.ok(fs.existsSync(path.join(b,'main/native-agents',alias+'.toml')));
  for(const skill of child.skills)assert.ok(fs.existsSync(path.join(b,route,'skills',skill,'SKILL.md')));
 }
 assert.deepEqual(m.nodes['main/children/qa'].skills,['pr-test-automation']);
 assert.deepEqual(m.nodes['main/children/cold-reader'].skills,['cold-read']);
 const p=build(f.root,'astra-planner',f.target),pm=JSON.parse(fs.readFileSync(path.join(p,'manifest.json')));
 assert.deepEqual(Object.keys(pm.nodes.main.children),['socrates']);
});

test('Markdown agents compose shared instructions and reject malformed frontmatter',t=>{
 const f=fixture(t);
 f.put('agents/writer.md','---\nharness: codex\nmodel: test\ninstructions_files: [../instructions/shared.md]\n---\n\nRole body.\n');
 f.put('instructions/shared.md','Shared.');
 const run=()=>build(f.root,'writer',f.target),b=run();
 assert.equal(fs.readFileSync(path.join(b,'main/instructions.md'),'utf8'),'Shared.\n\nRole body.');
 f.put('agents/writer.md','No frontmatter');assert.throws(run,/frontmatter/);
 f.put('agents/writer.md','---\nharness: codex\nmodel: one\nmodel: two\n---\nBody');assert.throws(run,/unique/);
 f.put('agents/writer.md','---\nharness: codex\nmodel: test\ninstructions: wrong\n---\nBody');assert.throws(run,/Markdown body/);
});
test('skill metadata is translated only for Codex while support files remain intact',t=>{
 const f=fixture(t),metadata='interface:\n  display_name: Proof\npolicy:\n  allow_implicit_invocation: false\n';
 f.put('skills/proof/metadata/codex.yaml',metadata);
 const b=f.build();
 assert.equal(fs.readFileSync(path.join(b,'main/children/worker/skills/proof/agents/openai.yaml'),'utf8'),metadata);
 assert.equal(fs.existsSync(path.join(b,'main/skills/proof/metadata/codex.yaml')),false);
 assert.equal(fs.existsSync(path.join(b,'main/skills/proof/agents/openai.yaml')),false);
 assert.equal(fs.readFileSync(path.join(b,'main/children/worker/skills/proof/helper.txt'),'utf8'),'SUPPORT');
 f.put('skills/proof/metadata/codex.yaml',metadata.replace('false','true'));assert.notEqual(f.build(),b);verify(b);
 f.put('skills/proof/agents/openai.yaml',metadata);assert.throws(f.build,/Ambiguous Codex skill metadata/);
});
