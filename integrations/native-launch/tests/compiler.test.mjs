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
