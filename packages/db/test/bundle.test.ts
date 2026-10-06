import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildBundle, BUNDLE_PATH } from '../src/bundle.ts';
import { listMigrations, runMigrations } from '../src/migrate.ts';
import { createTestDatabase, type Db } from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ client: db, drop } = await createTestDatabase({ via: 'bundle' }));
});
afterAll(async () => {
  await drop?.();
});

const applied = async () =>
  (await db.query<{ name: string }>('select name from app_migrations.applied order by version'))
    .rows;

it('el archivo versionado está al día (pnpm db:sql)', () => {
  expect(readFileSync(BUNDLE_PATH, 'utf8')).toBe(buildBundle());
});

it('registra todas las migraciones', async () => {
  expect((await applied()).map((r) => r.name)).toEqual(listMigrations().map((m) => m.name));
});

it('es idempotente si se ejecuta dos veces', async () => {
  const before = await applied();
  await db.query(buildBundle());
  expect(await applied()).toEqual(before);
});

it('runMigrations reconoce lo aplicado por el script manual', async () => {
  const r = await runMigrations(db, undefined, () => {});
  expect(r.applied).toEqual([]);
  expect(r.skipped.length).toBe(listMigrations().length);
});

it('todas las tablas de public quedan con RLS', async () => {
  const { rows } = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
  );
  expect(rows).toEqual([]);
});

it('falla si una migración aplicada se modifica', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  writeFileSync(join(dir, '20990201000000_demo.sql'), 'create table public.bundle_a (id int);');
  await db.query(buildBundle(dir));
  writeFileSync(join(dir, '20990201000000_demo.sql'), 'create table public.bundle_b (id int);');
  await expect(db.query(buildBundle(dir))).rejects.toThrow(/fue modificada/);
});

it('rechaza una migración que contiene su delimitador', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  writeFileSync(
    join(dir, '20990202000000_bad.sql'),
    'select $mig_20990202000000$x$mig_20990202000000$;',
  );
  expect(() => buildBundle(dir)).toThrow(/delimitador/);
});
