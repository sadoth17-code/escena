import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.argv[2] || 'www';
const version = (process.argv[3] || String(Date.now())).replace(/[^A-Za-z0-9._-]/g, '');

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const assets = walk(root)
  .map((file) => relative(root, file).split(sep).join('/'))
  .filter((file) => file !== 'sw.js')
  .sort();

const target = join(root, 'sw.js');
const original = readFileSync(target, 'utf8');
const stamped = original
  .replace(/^const VERSION = '[^']*';$/m, `const VERSION = '${version}';`)
  .replace(/^const ASSETS = \[[^\n]*\];$/m, `const ASSETS = ${JSON.stringify(['./', ...assets])};`);

if (stamped === original) {
  console.error('No se pudo preparar sw.js');
  process.exit(1);
}

writeFileSync(target, stamped);
console.log(`sw.js listo: versión ${version}, ${assets.length + 1} archivos`);
