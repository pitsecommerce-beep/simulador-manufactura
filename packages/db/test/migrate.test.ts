import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listMigrations, runMigrations } from '../src/migrate.ts';
import { createTestDatabase, type Db } from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ client: db, drop } = await createTestDatabase());
});
afterAll(async () => {
  await drop?.();
});

it('las migraciones son idempotentes', async () => {
  const r = await runMigrations(db, undefined, () => {});
  expect(r.applied).toEqual([]);
  expect(r.skipped.length).toBe(listMigrations().length);
});

it('falla si una migración aplicada se modifica', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  writeFileSync(join(dir, '20990101000000_demo.sql'), 'create table public.demo_a (id int);');
  await runMigrations(db, dir, () => {});
  writeFileSync(join(dir, '20990101000000_demo.sql'), 'create table public.demo_b (id int);');
  await expect(runMigrations(db, dir, () => {})).rejects.toThrow(/fue modificada/);
});

it('revierte una migración que falla a mitad', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  writeFileSync(join(dir, '20990102000000_bad.sql'), 'create table public.half (id int); select 1/0;');
  await expect(runMigrations(db, dir, () => {})).rejects.toThrow(/Falló/);
  const { rowCount } = await db.query(`select 1 from pg_tables where tablename = 'half'`);
  expect(rowCount).toBe(0);
});
