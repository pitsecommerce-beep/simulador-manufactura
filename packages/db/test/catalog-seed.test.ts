import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCatalogSeed,
  CATALOG_DIR,
  COMPONENTS_DIR,
  loadSeedData,
  resolveSources,
  SEED_PATH,
} from '../src/catalog-seed.ts';
import { createTestDatabase, type Db } from './helpers.ts';

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ client: db, drop } = await createTestDatabase({ via: 'bundle' }));
  await db.query(buildCatalogSeed());
});
afterAll(async () => {
  await drop?.();
});

/** Estado completo del catálogo, sin ids ni marcas de tiempo, para comparar entre corridas. */
async function snapshot() {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    robots: await q(
      `select slug, model, family, kinematic_type, application, data_status, notes from public.robots order by slug`,
    ),
    specs:
      await q(`select rv.slug, rv.variant_code, s.axes_count, s.axes_note, s.reach_mm, s.payload_kg,
                      s.armload_kg, s.axis_limits, s.provenance
                    from public.robot_specs s join public.robot_variants rv on rv.id = s.variant_id
                    order by rv.slug`),
    docs: await q(
      `select path, kind, doc_id, license_terms from public.robot_documents order by robot_id, path`,
    ),
    components: await q(`select c.slug, cs.specs from public.components c
                         join public.component_specs cs on cs.component_id = c.id order by c.slug`),
    objectTypes: await q(`select key, presets from public.object_types order by key`),
  };
}

const spec = async (slug: string) =>
  (
    await db.query(
      `select s.* from public.robot_specs s join public.robot_variants rv on rv.id = s.variant_id
       where rv.slug = $1`,
      [slug],
    )
  ).rows[0];

describe('seed del catálogo', () => {
  it('el archivo versionado está al día (pnpm catalog:sql)', () => {
    expect(readFileSync(SEED_PATH, 'utf8')).toBe(buildCatalogSeed());
  });

  it('carga todos los robots, variantes, componentes y presets', async () => {
    const data = loadSeedData();
    const count = async (t: string) =>
      Number((await db.query(`select count(*) from public.${t}`)).rows[0].count);
    expect(await count('robots')).toBe(data.robots.length);
    expect(await count('robot_variants')).toBe(data.variants.length);
    expect(await count('robot_specs')).toBe(data.variants.length);
    expect(await count('components')).toBe(data.components.length);
    expect(data.robots.length).toBeGreaterThan(0);
    const { rows } = await db.query(`select presets from public.object_types where key = 'pallet'`);
    expect(rows[0].presets.map((p: { id: string }) => p.id)).toContain('eur-epal-1');
  });

  it('es idempotente: aplicarlo dos veces deja el mismo estado', async () => {
    const before = await snapshot();
    await db.query(buildCatalogSeed());
    expect(await snapshot()).toEqual(before);
  });

  it('lo no publicado queda null, sin inventar valores', async () => {
    const delta = await spec('irb-360-1-1130');
    expect(delta.reach_mm).toBeNull();
    expect(delta.axes_count).toBeNull();
    expect(delta.axes_note).toBe('3 o 4');
    expect(Number(delta.workspace_diameter_mm)).toBe(1130);
    expect(delta.axis_limits).toBeNull();

    const paint = await spec('irb-5500-25-elevated-rail');
    expect(paint.axes_count).toBeNull();
    expect(paint.axis_limits).toBeNull();
    expect(paint.controller).toBeNull();

    const scara = await spec('irb-910inv-3-0-35');
    expect(scara.axis_limits[2]).toMatchObject({ axis: 3, unit: 'mm', speed_unit: 'm/s' });
  });

  it('cada dato lleva su documento, página y términos de uso', async () => {
    const s = await spec('irb-1010-1-5-0-37');
    expect(Number(s.reach_mm)).toBe(370);
    expect(s.provenance.reach_mm[0]).toMatchObject({
      file: 'datasheet.pdf',
      page: 2,
      doc_id: '9AKK108467A3570',
    });
    const doc = await db.query(
      `select license_terms, url from public.robot_documents where path = $1 and doc_id = $2`,
      ['datasheet.pdf', '9AKK108467A3570'],
    );
    expect(doc.rows[0].license_terms).toMatch(/ABB/);
    expect(doc.rows[0].url).toMatch(/^https:\/\/search\.abb\.com/);
    expect(s.provenance._extraction.extracted_from).toContain('datasheet.pdf');
    const { rows } = await db.query(
      `select kind from public.robot_documents d join public.robots r on r.id = d.robot_id
       where r.slug = 'irb-1010' order by kind`,
    );
    // Solo documentos de datos: los CAD y planos no se registran aquí.
    expect(rows.map((r) => r.kind)).toEqual(['datasheet', 'product_specification']);
  });

  it('refleja los JSON: una variante eliminada se borra al volver a aplicar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
    cpSync(CATALOG_DIR, dir, { recursive: true });
    const file = join(dir, 'irb-1100', 'specs.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.variants = json.variants.slice(0, 1);
    json.variants[0].reach_mm = null;
    writeFileSync(file, JSON.stringify(json));
    const irb1100 = `select rv.slug, s.reach_mm from public.robot_variants rv
      join public.robots r on r.id = rv.robot_id join public.robot_specs s on s.variant_id = rv.id
      where r.slug = 'irb-1100' order by rv.slug`;
    await db.query(buildCatalogSeed(loadSeedData(dir, COMPONENTS_DIR)));
    expect((await db.query(irb1100)).rows).toEqual([
      { slug: json.variants[0].robot_id, reach_mm: null },
    ]);
    // Al volver a aplicar el seed real, el estado se restaura.
    await db.query(buildCatalogSeed());
    expect((await db.query(irb1100)).rows).toHaveLength(2);
  });
});

describe('procedencia por campo', () => {
  const sources = {
    reach_payload_mounting_ip_controller: { file: 'datasheet.pdf', page: 2, section: 'Spec' },
    axes_range: { file: 'ps.pdf', page: 40, section: 'Range' },
    axes_speed: { file: 'ps.pdf', page: 41, section: 'Speed' },
  };
  it('asocia cada campo a las claves que lo cubren', () => {
    expect(resolveSources('reach_mm', sources, [])?.map((s) => s.page)).toEqual([2]);
    expect(resolveSources('axis_limits', sources, [])?.map((s) => s.page)).toEqual([40, 41]);
  });
  it('devuelve null si ninguna clave lo cubre y usa "all" como respaldo', () => {
    expect(resolveSources('armload_kg', sources, [])).toBeNull();
    const all = { all: { file: 'd.pdf', page: 1, section: null } };
    expect(resolveSources('armload_kg', all, [])?.[0]?.file).toBe('d.pdf');
  });
});
