import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { runMigrations } from '../src/migrate.ts';

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

const STUB = readFileSync(
  resolve(import.meta.dirname, '../../../supabase/tests/supabase-stub.sql'),
  'utf8',
);

/** Crea una base de datos desechable con el stub de Supabase y todas las migraciones. */
export async function createTestDatabase() {
  const dbName = `sim_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `No hay Postgres de pruebas en ${ADMIN_URL}. Arráncalo con "docker compose up -d db-test" ` +
        `o define TEST_DATABASE_URL. (${(err as Error).message})`,
    );
  }
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(STUB);
  await runMigrations(client, undefined, () => {});

  return {
    client,
    async drop() {
      await client.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
}

export type Db = pg.Client;

/**
 * Ejecuta `fn` como un usuario autenticado (rol `authenticated` + claims JWT),
 * dentro de una transacción que siempre se revierte.
 */
export async function asRole<T>(
  db: Db,
  role: 'authenticated' | 'anon' | 'service_role',
  sub: string | null,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  await db.query('begin');
  try {
    await db.query(
      `select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)`,
      [JSON.stringify(sub ? { sub, role } : { role }), role],
    );
    return await fn(db);
  } finally {
    await db.query('rollback');
  }
}

export const asUser = <T>(db: Db, sub: string, fn: (db: Db) => Promise<T>) =>
  asRole(db, 'authenticated', sub, fn);

/** Ejecuta `fn` como superusuario dentro de una transacción que siempre se revierte. */
export async function inRollback<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    return await fn(db);
  } finally {
    await db.query('rollback');
  }
}

/** Espera que la consulta falle (dentro de una transacción); usa un savepoint para poder seguir en la transacción. */
export async function expectError(db: Db, sql: string, params: unknown[] = []): Promise<string> {
  await db.query('savepoint expect_error');
  try {
    await db.query(sql, params);
  } catch (err) {
    await db.query('rollback to savepoint expect_error');
    return (err as Error).message;
  }
  await db.query('release savepoint expect_error');
  throw new Error(`Se esperaba un error y la consulta tuvo éxito: ${sql}`);
}
