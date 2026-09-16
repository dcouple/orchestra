import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadProfile,unloadProfile,loadedProfiles} from '../dist/user-skills.js';
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orchestra-user-skills-')));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'config'),home=path.join(base,'home');fs.mkdirSync(home);
 const put=(file,text)=>{const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
 for(const name of ['shared','one','two']){put(`skills/${name}/SKILL.md`,name);put(`skills/${name}/references/proof.md`,'support');}
 put('agents/first.yaml','harness: codex\nmodel: test\nskills: [shared, one]\n');
 put('agents/second.yaml','harness: codex\nmodel: test\nskills: [shared, two]\n');
 const options={home,env:{}};
 return {root,home,put,options,skill:n=>path.join(home,'.codex/skills',n)};
}
test('load links complete skills; repeated loads are idempotent and shared skills survive unload',t=>{
 const f=fixture(t);loadProfile(f.root,'first',f.options);loadProfile(f.root,'first',f.options);loadProfile(f.root,'second',f.options);
 assert.equal(loadedProfiles(f.options).length,2);
 assert.ok(fs.lstatSync(f.skill('one')).isSymbolicLink());assert.equal(fs.readFileSync(path.join(f.skill('one'),'references/proof.md'),'utf8'),'support');
 unloadProfile('first',f.options);assert.ok(fs.existsSync(f.skill('shared')));assert.equal(fs.existsSync(f.skill('one')),false);
 unloadProfile('second',f.options);assert.equal(fs.existsSync(f.skill('shared')),false);assert.equal(loadedProfiles(f.options).length,0);
 assert.ok(fs.existsSync(path.join(f.root,'skills/shared/SKILL.md')));
});
test('an existing skill prevents the entire load without overwriting or adopting it',t=>{
 const f=fixture(t);fs.mkdirSync(f.skill('one'),{recursive:true});fs.writeFileSync(path.join(f.skill('one'),'SKILL.md'),'personal');
 assert.throws(()=>loadProfile(f.root,'first',f.options),/not be overwritten/);
 assert.equal(fs.existsSync(f.skill('shared')),false);assert.equal(loadedProfiles(f.options).length,0);
 assert.equal(fs.readFileSync(path.join(f.skill('one'),'SKILL.md'),'utf8'),'personal');
});
test('unload preserves replaced skills and preflights the full removal',t=>{
 const f=fixture(t);loadProfile(f.root,'first',f.options);fs.unlinkSync(f.skill('one'));fs.mkdirSync(f.skill('one'));fs.writeFileSync(path.join(f.skill('one'),'SKILL.md'),'replacement');
 assert.throws(()=>unloadProfile('first',f.options),/preserving/);assert.ok(fs.existsSync(f.skill('shared')));assert.equal(loadedProfiles(f.options).length,1);
});
test('unload does not require the source profile or skills to still exist',t=>{
 const f=fixture(t);loadProfile(f.root,'first',f.options);fs.rmSync(f.root,{recursive:true});
 unloadProfile('first',f.options);assert.equal(fs.readdirSync(path.dirname(f.skill('one'))).length,0);
});
test('changed profile requires unload and harness override keeps installations independent',t=>{
 const f=fixture(t);loadProfile(f.root,'first',f.options);loadProfile(f.root,'first',{...f.options,harness:'claude'});
 f.put('agents/first.yaml','harness: codex\nmodel: test\nskills: [two]\n');assert.throws(()=>loadProfile(f.root,'first',f.options),/selection changed/);
 unloadProfile('first',{...f.options,harness:'codex'});assert.ok(fs.existsSync(path.join(f.home,'.claude/skills/one')));
 unloadProfile('first',f.options);assert.equal(loadedProfiles(f.options).length,0);
});
test('Codex uses the original native home rather than a generated launch home',t=>{
 const f=fixture(t),original=path.join(f.home,'native'),generated=path.join(f.home,'generated');
 loadProfile(f.root,'first',{...f.options,env:{CODEX_HOME:generated,ORCHESTRA_NATIVE_CODEX_HOME:original}});
 assert.ok(fs.existsSync(path.join(original,'skills/one')));assert.equal(fs.existsSync(generated),false);
});
test('CLI loads, lists, and unloads in an isolated user home',t=>{
 const f=fixture(t),env={...process.env,HOME:f.home,CODEX_HOME:path.join(f.home,'.codex'),ORCHESTRA_NATIVE_CODEX_HOME:path.join(f.home,'.codex')};
 for(const args of [['load','first','--config-root',f.root],['loaded'],['unload','first']]){
  const r=spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/first/);
 }
 assert.equal(fs.existsSync(f.skill('one')),false);
});
