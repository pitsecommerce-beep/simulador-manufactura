// Genera supabase/manual/apply_all.sql: todas las migraciones en un solo script para pegar
// en Supabase > SQL Editor. Cada migración se ejecuta solo si no está en app_migrations.applied,
// así que el script es idempotente y compatible con runMigrations (mismo checksum).
//   pnpm db:sql            regenera el archivo
//   pnpm db:sql --check    falla si el archivo no está al día
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { checksum, listMigrations, LOCK_ID, MIGRATIONS_DIR } from './migrate.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
export const BUNDLE_PATH = resolve(ROOT, 'supabase/manual/apply_all.sql');

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function buildBundle(dir = MIGRATIONS_DIR): string {
  const blocks = listMigrations(dir).map((m) => {
    const body = `$mig_${m.version}$`;
    const block = `$do_${m.version}$`;
    for (const tag of [body, block]) {
      if (m.sql.includes(tag)) {
        throw new Error(`La migración ${m.name} contiene el delimitador reservado ${tag}.`);
      }
    }
    const sum = checksum(m.sql);
    return `-- ${m.name}
do ${block}
declare
  prev text;
begin
  perform pg_advisory_xact_lock(${LOCK_ID});
  select checksum into prev from app_migrations.applied where version = ${literal(m.version)};
  if prev is null then
    execute ${body}
${m.sql}${m.sql.endsWith('\n') ? '' : '\n'}${body};
    insert into app_migrations.applied (version, name, checksum)
      values (${literal(m.version)}, ${literal(m.name)}, ${literal(sum)});
    raise notice 'aplicada %', ${literal(m.name)};
  elsif prev <> ${literal(sum)} then
    raise exception 'La migración % ya aplicada fue modificada. Crea una migración nueva.', ${literal(m.name)};
  else
    raise notice 'ya estaba %', ${literal(m.name)};
  end if;
end
${block};
`;
  });

  return `-- ============================================================================
-- ARCHIVO GENERADO por packages/db/src/bundle.ts (pnpm db:sql). No lo edites a mano.
-- Pégalo completo en Supabase > SQL Editor y pulsa Run. Es idempotente: solo aplica
-- las migraciones que falten y deja constancia en app_migrations.applied.
-- ============================================================================

create schema if not exists app_migrations;
create table if not exists app_migrations.applied (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);

${blocks.join('\n')}
select version, name, applied_at from app_migrations.applied order by version;
`;
}

function main() {
  const sql = buildBundle();
  const rel = relative(ROOT, BUNDLE_PATH);
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(BUNDLE_PATH, 'utf8');
    } catch {
      // no existe: se trata como desactualizado
    }
    if (current !== sql) {
      console.error(`${rel} no está al día. Ejecuta: pnpm db:sql`);
      process.exit(1);
    }
    console.log(`✔ ${rel} está al día.`);
    return;
  }
  writeFileSync(BUNDLE_PATH, sql);
  console.log(`✔ ${rel} generado (${listMigrations().length} migraciones).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
