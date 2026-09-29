import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { STEP_SIGNATURE, checkContent, checkFile, checkPath } from './lib.mjs';

test('bloquea extensiones CAD sin importar mayúsculas ni compresión', () => {
  for (const p of ['a.step', 'b/C.STP', 'x.SLDPRT', 'robot.glb', 'm.igs', 'm.step.gz', 'r.urdf']) {
    assert.ok(checkPath(p), p);
  }
});

test('permite código y documentación', () => {
  for (const p of [
    'src/index.ts',
    'README.md',
    'catalog/README.md',
    'catalog/examples/specs.json',
  ]) {
    assert.equal(checkPath(p), null, p);
  }
});

test('bloquea datasheets y planos dentro de las carpetas de catálogo', () => {
  assert.ok(checkPath('catalog/irb-1200/datasheet.pdf'));
  assert.ok(checkPath('catalog_components/sensores/x/drawing.png'));
  assert.equal(checkPath('docs/diagrama.png'), null);
});

test('detecta STEP por contenido aunque se renombre', () => {
  const step = Buffer.from(STEP_SIGNATURE + ";\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n");
  assert.match(checkContent(step), /STEP/);
});

test('detecta STEP comprimido con gzip', () => {
  const gz = gzipSync(Buffer.from(STEP_SIGNATURE + ';\nHEADER;\n'));
  assert.match(checkContent(gz), /gzip/);
});

test('detecta GLB por cabecera binaria', () => {
  const glb = Buffer.alloc(12);
  glb.write('glTF', 0, 'latin1');
  assert.match(checkContent(glb), /GLB/);
});

test('detecta glTF JSON y STL ASCII', () => {
  assert.ok(checkContent(Buffer.from('{"asset":{"version":"2.0"},"nodes":[]}')));
  assert.ok(checkContent(Buffer.from('solid part\n  facet normal 0 0 1\n')));
});

test('no marca texto normal', () => {
  assert.equal(checkContent(Buffer.from('export const x = 1;\n')), null);
});

test('checkFile combina nombre y contenido', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cad-'));
  const disguised = join(dir, 'notas.txt');
  writeFileSync(disguised, STEP_SIGNATURE + ';\n');
  assert.equal(checkFile(disguised).length, 1);
  const clean = join(dir, 'ok.ts');
  writeFileSync(clean, 'const a = 1;\n');
  assert.deepEqual(checkFile(clean), []);
});

test('no marca documentación que menciona la firma STEP', () => {
  assert.equal(
    checkContent(Buffer.from(`La cabecera ${STEP_SIGNATURE} identifica un STEP.`)),
    null,
  );
});
