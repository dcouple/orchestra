#!/usr/bin/env node
// Read-only convergence check. Run as the service user, including in dry runs.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const [checkout, root] = process.argv.slice(2);
try {
  const {validatePlugin} = await import(pathToFileURL(path.join(checkout, 'dist/plugins.js')));
  const {info, checksums} = validatePlugin(path.join(checkout, 'plugins/dcouple'));
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.plugins/dcouple.json'), 'utf8'));
  const sorted = value => JSON.stringify(Object.entries(value).sort());
  if (receipt.name !== info.name || receipt.version !== info.version || sorted(receipt.checksums) !== sorted(checksums)) {
    throw new Error('Plugin receipt differs from pinned source');
  }
  if (fs.existsSync(path.join(root, '.plugins/install.lock'))) throw new Error('Plugin install lock exists');
  for (const [relative, expected] of Object.entries(checksums)) {
    let cursor = root;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink destination: ${cursor}`);
    }
    const digest = createHash('sha256').update(fs.readFileSync(cursor)).digest('hex');
    if (digest !== expected) throw new Error(`Installed plugin file differs: ${cursor}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
