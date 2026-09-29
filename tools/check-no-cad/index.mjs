#!/usr/bin/env node
// Uso:
//   node tools/check-no-cad/index.mjs            revisa todos los archivos versionados (CI)
//   node tools/check-no-cad/index.mjs --staged   revisa solo los archivos en stage (pre-commit)
//   node tools/check-no-cad/index.mjs <rutas...> revisa rutas concretas
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { checkFile } from './lib.mjs';

function gitList(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function loadAllowlist() {
  if (!existsSync('.cad-allowlist')) return new Set();
  return new Set(
    readFileSync('.cad-allowlist', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

const args = process.argv.slice(2);
let files;
if (args[0] === '--staged') {
  files = gitList(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
} else if (args.length > 0) {
  files = args;
} else {
  files = gitList(['ls-files', '-z']);
}

const allow = loadAllowlist();
const violations = [];
for (const f of files) {
  if (allow.has(f)) continue;
  const reasons = checkFile(f);
  if (reasons.length) violations.push({ f, reasons });
}

if (violations.length) {
  console.error(
    '\n✖ Se detectaron archivos CAD/3D o de fabricante. No pueden subirse al repositorio:\n',
  );
  for (const v of violations) console.error(`  ${v.f}\n      ${v.reasons.join('; ')}`);
  console.error(
    '\nLos CAD originales van al bucket privado de Supabase mediante el script de ingesta (ver README).\n',
  );
  process.exit(1);
}
console.log(`✔ check-no-cad: ${files.length} archivos revisados, ninguno es CAD.`);
