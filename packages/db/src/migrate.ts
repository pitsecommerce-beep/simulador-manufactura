// Aplica supabase/migrations/*.sql en orden, una vez cada una, dentro de una transacción.
// Se ejecuta como pre-deploy del servicio api en Railway: `pnpm db:migrate`.
// Las migraciones aplicadas son inmutables: si el contenido cambia, falla.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../supabase/migrations');
const LOCK_ID = 72_110_931; // clave arbitraria del advisory lock

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function listMigrations(
  dir = MIGRATIONS_DIR,
): { version: string; name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: f.slice(0, 14),
      name: f,
      sql: readFileSync(join(dir, f), 'utf8'),
    }));
}

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

export async function runMigrations(
  client: pg.ClientBase,
  dir = MIGRATIONS_DIR,
  log: (msg: string) => void = console.log,
): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], skipped: [] };
  await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
  try {
    await client.query(`
      create schema if not exists app_migrations;
      create table if not exists app_migrations.applied (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      );`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'select version, checksum from app_migrations.applied',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const m of listMigrations(dir)) {
      const sum = checksum(m.sql);
      const prev = done.get(m.version);
      if (prev) {
        if (prev !== sum) {
          throw new Error(
            `La migración ${m.name} ya aplicada fue modificada. Crea una migración nueva.`,
          );
        }
        result.skipped.push(m.name);
        continue;
      }
      log(`→ aplicando ${m.name}`);
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query(
          'insert into app_migrations.applied (version, name, checksum) values ($1, $2, $3)',
          [m.version, m.name, sum],
        );
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Falló ${m.name}: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(m.name);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]);
  }
  return result;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL no está definida.');
    process.exit(1);
  }
  const client = new pg.Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const r = await runMigrations(client);
    console.log(`✔ migraciones: ${r.applied.length} aplicadas, ${r.skipped.length} ya estaban.`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
