import fs from 'node:fs';
import path from 'node:path';
import {files,hash} from './runtime.js';

/** Authoring names are independent of the harness's on-disk skill convention. */
export function skillFiles(folder: string, harness: 'claude'|'codex'): {relative:string;source:string}[] {
  const inputs=files(folder).map(source=>({relative:path.relative(folder,source),source}));
  const metadata=path.join('metadata','codex.yaml'),native=path.join('agents','openai.yaml');
  if (inputs.some(f=>f.relative===metadata) && inputs.some(f=>f.relative===native)) throw new Error(`Ambiguous Codex skill metadata: ${folder}`);
  return inputs.flatMap(file=>file.relative===metadata ? (harness==='codex' ? [{...file,relative:native}] : []) : [file]);
}

/** Global loads retain live source links while exposing the native directory layout. */
export function userSkillSource(folder: string, harness: 'claude'|'codex', home: string): string {
  const entries=skillFiles(folder,harness);
  if (!fs.existsSync(path.join(folder,'metadata/codex.yaml'))) return folder;
  const cache=path.join(home,'.cache/orchestra/user-skill-layouts');
  const destination=path.join(cache,hash(JSON.stringify({version:1,folder,harness,entries})).slice(0,24));
  if (fs.existsSync(destination)) {
    const actual: string[]=[];
    function inspect(dir: string) {
      for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
        const file=path.join(dir,item.name);
        if (item.isDirectory()) inspect(file); else actual.push(path.relative(destination,file));
      }
    }
    inspect(destination);
    if (JSON.stringify(actual.sort())!==JSON.stringify(entries.map(e=>e.relative).sort())) throw new Error(`Modified generated user skill layout: ${destination}`);
    for (const entry of entries) {
      const file=path.join(destination,entry.relative);
      if (!fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file)!==entry.source) throw new Error(`Modified generated user skill link: ${file}`);
    }
    return destination;
  }
  fs.mkdirSync(cache,{recursive:true,mode:0o700});
  const temporary=fs.mkdtempSync(path.join(cache,'.building-'));
  try {
    for (const entry of entries) {
      const file=path.join(temporary,entry.relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.symlinkSync(entry.source,file);
    }
    fs.renameSync(temporary,destination);
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
  return destination;
}
