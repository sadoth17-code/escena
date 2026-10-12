import { readdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const root = process.argv[2] || 'www';

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    if (name.startsWith('.')) continue;
    const full = join(directory, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`No se puede incluir un enlace simbólico en la aplicación: ${full}`);
    if (stat.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

// Las guías de voz en inglés, portugués y francés (unos 7 MB) no se precargan: se descargan la
// primera vez que se elige el idioma y el Service Worker las conserva (ver sw.js, GUIDES).
const EXTRA_GUIDES = /^audio\/guias\/(en|pt|fr)\.(wav|json)$/;

const assets = walk(root)
  .map((file) => relative(root, file).split(sep).join('/'))
  .filter((file) => file !== 'sw.js' && !EXTRA_GUIDES.test(file))
  .sort();

const target = join(root, 'sw.js');
const original = readFileSync(target, 'utf8');
if (!/^const VERSION = '[^']*';$/m.test(original) || !/^const ASSETS = \[[^\n]*\];$/m.test(original)) throw new Error('sw.js no tiene los campos VERSION y ASSETS esperados');
// Sin versión explícita, el contenido determina la revisión: ejecutar dos veces es seguro
// y cualquier archivo nuevo (por ejemplo un banco de pads) se incluye automáticamente.
const digest = createHash('sha256');
digest.update(original.replace(/^const VERSION = '[^']*';$/m, '').replace(/^const ASSETS = \[[^\n]*\];$/m, ''));
for (const file of assets) digest.update(file).update(readFileSync(join(root, file)));
const version = (process.argv[3] || `escena-${digest.digest('hex').slice(0, 16)}`).replace(/[^A-Za-z0-9._-]/g, '');
if (!version) throw new Error('La versión debe contener letras o números');
const stamped = original
  .replace(/^const VERSION = '[^']*';$/m, `const VERSION = '${version}';`)
  .replace(/^const ASSETS = \[[^\n]*\];$/m, `const ASSETS = ${JSON.stringify(['./', ...assets])};`);

if (stamped !== original) writeFileSync(target, stamped);
console.log(`sw.js listo: versión ${version}, ${assets.length + 1} archivos`);
