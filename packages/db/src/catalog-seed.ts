// Genera supabase/manual/seed_catalog.sql desde catalog/ y catalog_components/ (JSON de ficha).
// El SQL es un upsert idempotente: pegarlo varias veces en el SQL Editor deja el mismo estado,
// y refleja exactamente los JSON (variantes y documentos que ya no estén se borran).
// Regla: lo que falte en los JSON queda null. No se convierte texto a número ni se estima nada.
//   pnpm catalog:sql            regenera el archivo
//   pnpm catalog:sql --check    falla si el archivo no está al día
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

const ROOT = resolve(import.meta.dirname, '../../..');
export const CATALOG_DIR = resolve(ROOT, 'catalog');
export const COMPONENTS_DIR = resolve(ROOT, 'catalog_components');
export const SEED_PATH = resolve(ROOT, 'supabase/manual/seed_catalog.sql');

// ---------------------------------------------------------------------------
// Esquemas de entrada (laxos: los campos desconocidos se ignoran con advertencia)
// ---------------------------------------------------------------------------
const num = z.number().nullish();
const str = z.string().nullish();
const strList = z.array(z.string()).nullish();

const SourceRef = z.looseObject({ file: z.string(), page: num, section: str });

const Variant = z.looseObject({
  variant: z.string(),
  robot_id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  axes: z.union([z.number().int(), z.string()]).nullish(),
  reach_mm: num,
  workspace_diameter_mm: num,
  payload_kg: num,
  payload_note: str,
  armload_kg: num,
  robot_weight_kg: num,
  max_tcp_speed_m_s: num,
  mounting: strList,
  ip_rating: str,
  controller: str,
  repeatability: z.record(z.string(), z.unknown()).nullish(),
  axis_data: z
    .array(
      z.looseObject({
        axis: z.number().int(),
        range_min: num,
        range_max: num,
        range_unit: str,
        max_speed: num,
        speed_unit: str,
        note: str,
      }),
    )
    .nullish(),
  cycle_times: z.array(z.record(z.string(), z.unknown())).nullish(),
  sources: z.record(z.string(), SourceRef).nullish(),
  extra: z.record(z.string(), z.unknown()).nullish(),
});

const RobotSpecsFile = z.looseObject({
  robot_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  family: str,
  typical_application: str,
  product_page: str,
  extracted_from: strList,
  extracted_at: str,
  extraction_note: str,
  notes: strList,
  variants: z.array(Variant),
});

const DocFile = z.looseObject({
  path: z.string(),
  kind: z.string(),
  doc_id: str,
  revision: str,
  doc_date: str,
  title: str,
  url: str,
  library_page: str,
  accessed_at: str,
  sha256: str,
  size_bytes: num,
  license_terms: str,
  note: str,
});

const RobotSourceFile = z.looseObject({ robot_id: z.string(), files: z.array(DocFile) });

const Manifest = z.looseObject({
  robots: z.array(
    z.looseObject({
      robot_id: z.string(),
      name: z.string(),
      family: str,
      application: str,
      status: z.enum(['ok', 'partial']).nullish(),
      product_page: str,
      notes: strList,
    }),
  ),
});

const ComponentSpecsFile = z.looseObject({
  component_id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  manufacturer: str,
  model: z.string(),
  category: z.string(),
  type: str,
  extracted_from: z.union([z.string(), z.array(z.string())]).nullish(),
  extraction_note: str,
  specs: z.record(z.string(), z.unknown()),
  notes: strList,
});
const ComponentSourceFile = z.looseObject({ component_id: z.string(), files: z.array(DocFile) });

const Presets = z.looseObject({
  pallets: z.array(z.record(z.string(), z.unknown())).nullish(),
  containers_and_boxes: z.array(z.record(z.string(), z.unknown())).nullish(),
});

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------
type Doc = z.infer<typeof DocFile>;
// Referencia al documento; título, URL y términos de uso viven en robot_documents (por `file`).
type Source = {
  file: string;
  page: number | null;
  section: string | null;
  doc_id: string | null;
  revision: string | null;
};

/** Los CAD y planos no son fuentes de datos: se registran en la fase 2b como assets. */
export const isDataDocument = (kind: string) => !/cad|step|drawing|dwg|dxf/i.test(kind);

// Qué claves de `sources` cubren cada campo. Una clave es una lista de grupos unidos por "_"
// (ej. "reach_payload_mounting_ip_controller"); "all" cubre todo.
const FIELD_TOKENS: Record<string, string[]> = {
  axes_count: ['axes', 'variants'],
  reach_mm: ['reach', 'variants'],
  workspace_diameter_mm: ['variants', 'workspace'],
  payload_kg: ['payload', 'variants'],
  armload_kg: ['armload'],
  weight_kg: ['weight'],
  repeatability: ['repeatability', 'performance'],
  mounting_allowed: ['mounting'],
  ip_rating: ['ip'],
  controller: ['controller'],
  axis_limits: ['axes'],
  published_cycle_times: ['cycle', 'performance'],
  max_tcp_speed_m_s: ['performance', 'speed'],
  extra: ['extra'],
};

export function resolveSources(
  field: string,
  sources: Record<string, z.infer<typeof SourceRef>> | null | undefined,
  docs: Doc[],
): Source[] | null {
  if (!sources) return null;
  const tokens = FIELD_TOKENS[field] ?? [field];
  const keys = Object.keys(sources);
  let hits = keys.filter((k) => k.split('_').some((t) => tokens.includes(t)));
  if (hits.length === 0) hits = keys.filter((k) => k === 'all');
  if (hits.length === 0) return null;
  return hits.map((k) => {
    const s = sources[k]!;
    const doc = docs.find((d) => d.path === s.file);
    return {
      file: s.file,
      page: s.page ?? null,
      section: s.section ?? null,
      doc_id: doc?.doc_id ?? null,
      revision: doc?.revision ?? null,
    };
  });
}

export function kinematicType(family: string | null | undefined) {
  if (!family) return null;
  if (/delta/i.test(family)) return 'delta';
  if (/scara/i.test(family)) return 'scara';
  if (/palleti/i.test(family)) return 'parallel_linkage';
  return 'serial';
}

const KNOWN_VARIANT_KEYS = new Set(Object.keys(Variant.shape));

export interface SeedData {
  robots: Record<string, unknown>[];
  variants: Record<string, unknown>[];
  robotDocuments: Record<string, unknown>[];
  components: Record<string, unknown>[];
  componentDocuments: Record<string, unknown>[];
  objectTypes: Record<string, unknown>[];
  warnings: string[];
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const dirs = (p: string) =>
  existsSync(p)
    ? readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'examples')
        .map((d) => d.name)
        .sort()
    : [];

function parse<T>(schema: z.ZodType<T>, file: string): T {
  const r = schema.safeParse(readJson(file));
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${relative(ROOT, file)} no es válido: ${issues}`);
  }
  return r.data;
}

export function loadSeedData(catalogDir = CATALOG_DIR, componentsDir = COMPONENTS_DIR): SeedData {
  const warnings: string[] = [];
  const manifest = parse(Manifest, join(catalogDir, 'manifest.json'));
  const out: SeedData = {
    robots: [],
    variants: [],
    robotDocuments: [],
    components: [],
    componentDocuments: [],
    objectTypes: [],
    warnings,
  };

  for (const id of dirs(catalogDir)) {
    const specsPath = join(catalogDir, id, 'specs.json');
    const sourcePath = join(catalogDir, id, 'source.json');
    if (!existsSync(specsPath) || !existsSync(sourcePath)) {
      warnings.push(`catalog/${id}: falta specs.json o source.json; se omite`);
      continue;
    }
    const specs = parse(RobotSpecsFile, specsPath);
    const source = parse(RobotSourceFile, sourcePath);
    const m = manifest.robots.find((r) => r.robot_id === specs.robot_id);
    if (!m) warnings.push(`${specs.robot_id}: no está en manifest.json`);
    const docs = source.files.filter((f) => isDataDocument(f.kind));

    const notes = [...(specs.notes ?? [])];
    for (const n of m?.notes ?? []) if (!notes.includes(n)) notes.push(n);
    const family = m?.family ?? specs.family ?? null;
    out.robots.push({
      slug: specs.robot_id,
      manufacturer: 'ABB',
      model: specs.name,
      family,
      kinematic_type: kinematicType(family),
      application: m?.application ?? null,
      typical_application: specs.typical_application ?? null,
      product_page: specs.product_page ?? m?.product_page ?? null,
      data_status: m?.status ?? null,
      notes: notes.length ? notes : null,
    });

    for (const v of specs.variants) {
      for (const k of Object.keys(v)) {
        if (!KNOWN_VARIANT_KEYS.has(k)) warnings.push(`${v.robot_id}: campo desconocido "${k}"`);
      }
      const rep = v.repeatability ?? null;
      const repMm =
        typeof rep?.pose_repeatability_mm === 'number'
          ? rep.pose_repeatability_mm
          : typeof rep?.position_repeatability_mm === 'number'
            ? rep.position_repeatability_mm
            : null;
      const provenance: Record<string, unknown> = {
        _extraction: {
          extracted_from: specs.extracted_from ?? [],
          extracted_at: specs.extracted_at ?? null,
          note: specs.extraction_note ?? null,
        },
      };
      for (const field of Object.keys(FIELD_TOKENS)) {
        provenance[field] = resolveSources(field, v.sources, docs);
      }
      out.variants.push({
        robot_slug: specs.robot_id,
        slug: v.robot_id,
        variant_code: v.variant,
        axes_count: typeof v.axes === 'number' ? v.axes : null,
        axes_note: typeof v.axes === 'string' ? v.axes : null,
        reach_mm: v.reach_mm ?? null,
        workspace_diameter_mm: v.workspace_diameter_mm ?? null,
        payload_kg: v.payload_kg ?? null,
        payload_note: v.payload_note ?? null,
        armload_kg: v.armload_kg ?? null,
        weight_kg: v.robot_weight_kg ?? null,
        repeatability_mm: repMm,
        repeatability: rep,
        mounting_allowed: v.mounting ?? null,
        ip_rating: v.ip_rating ?? null,
        controller: v.controller ?? null,
        axis_limits: v.axis_data
          ? v.axis_data.map((a) => ({
              axis: a.axis,
              min: a.range_min ?? null,
              max: a.range_max ?? null,
              unit: a.range_unit ?? null,
              max_speed: a.max_speed ?? null,
              speed_unit: a.speed_unit ?? null,
              ...(a.note ? { note: a.note } : {}),
            }))
          : null,
        published_cycle_times: v.cycle_times?.length ? v.cycle_times : null,
        max_tcp_speed_m_s: v.max_tcp_speed_m_s ?? null,
        extra: v.extra ?? null,
        provenance,
      });
    }

    for (const d of docs) out.robotDocuments.push({ robot_slug: specs.robot_id, ...docRow(d) });
  }

  for (const category of dirs(componentsDir)) {
    for (const id of dirs(join(componentsDir, category))) {
      const specsPath = join(componentsDir, category, id, 'specs.json');
      const sourcePath = join(componentsDir, category, id, 'source.json');
      if (!existsSync(specsPath) || !existsSync(sourcePath)) continue;
      const c = parse(ComponentSpecsFile, specsPath);
      const s = parse(ComponentSourceFile, sourcePath);
      out.components.push({
        slug: c.component_id,
        manufacturer: c.manufacturer ?? null,
        model: c.model,
        category: c.category,
        type: c.type ?? null,
        notes: c.notes?.length ? c.notes : null,
        specs: c.specs,
        provenance: {
          _extraction: {
            extracted_from: [c.extracted_from ?? []].flat(),
            extracted_at: null,
            note: c.extraction_note ?? null,
          },
        },
      });
      for (const d of s.files.filter((f) => isDataDocument(f.kind))) {
        out.componentDocuments.push({ component_slug: c.component_id, ...docRow(d) });
      }
    }
  }

  const presetsPath = join(componentsDir, 'standards', 'presets.json');
  const presets = existsSync(presetsPath) ? parse(Presets, presetsPath) : null;
  out.objectTypes = [
    { key: 'pallet', name: 'Pallet', category: 'logistica', presets: presets?.pallets ?? [] },
    {
      key: 'box',
      name: 'Caja',
      category: 'logistica',
      presets: presets?.containers_and_boxes ?? [],
    },
    { key: 'table', name: 'Mesa', category: 'estaciones', presets: [] },
    { key: 'conveyor', name: 'Banda transportadora', category: 'transporte', presets: [] },
  ];
  return out;
}

function docRow(d: Doc) {
  return {
    path: d.path,
    kind: d.kind,
    doc_id: d.doc_id ?? null,
    revision: d.revision ?? null,
    doc_date: d.doc_date ?? null,
    title: d.title ?? null,
    url: d.url ?? null,
    library_page: d.library_page ?? null,
    accessed_at: d.accessed_at ?? null,
    sha256: d.sha256 ?? null,
    size_bytes: d.size_bytes ?? null,
    license_terms: d.license_terms ?? null,
    note: d.note ?? null,
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
const TAG = '$catalog_seed$';
const DO_TAG = '$catalog_seed_do$';

/** Texto de un arreglo jsonb: `array(...)` o null si el json no es arreglo. */
const textArray = (expr: string) =>
  `case when jsonb_typeof(${expr}) = 'array' then array(select jsonb_array_elements_text(${expr})) end`;
const nullableJson = (expr: string) => `case when jsonb_typeof(${expr}) <> 'null' then ${expr} end`;

export function buildCatalogSeed(data = loadSeedData()): string {
  // Un registro por línea: compacto y con diffs legibles al cambiar un JSON.
  const section = (name: string, rows: unknown[]) =>
    ` "${name}": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]`;
  const payload = `{\n${[
    section('robots', data.robots),
    section('variants', data.variants),
    section('robot_documents', data.robotDocuments),
    section('components', data.components),
    section('component_documents', data.componentDocuments),
    section('object_types', data.objectTypes),
  ].join(',\n')}\n}`;
  for (const tag of [TAG, DO_TAG]) {
    if (payload.includes(tag)) throw new Error(`Los datos contienen el delimitador ${tag}.`);
  }

  return `-- ============================================================================
-- ARCHIVO GENERADO por packages/db/src/catalog-seed.ts (pnpm catalog:sql). No lo edites a mano.
-- Origen: catalog/*/specs.json, catalog/*/source.json, catalog/manifest.json y catalog_components/.
-- Requiere la migración 20261006000100_catalog_sheet_data (supabase/manual/apply_all.sql).
-- Pégalo completo en Supabase > SQL Editor y pulsa Run. Es idempotente y refleja exactamente
-- los JSON: los datos no publicados quedan NULL. Todo va en un solo bloque DO (atómico y sin
-- tablas temporales, que el SQL Editor no conserva entre instrucciones).
-- Resumen: ${data.robots.length} robots, ${data.variants.length} variantes, ${data.robotDocuments.length} documentos de robot, ${data.components.length} componentes.
-- ============================================================================

do ${DO_TAG}
declare
  seed constant jsonb := ${TAG}
${payload}
${TAG};
begin

-- Robots -------------------------------------------------------------------
insert into public.robots (slug, manufacturer, model, family, kinematic_type, application,
                           typical_application, product_page, data_status, notes)
select r->>'slug', r->>'manufacturer', r->>'model', r->>'family', r->>'kinematic_type',
       r->>'application', r->>'typical_application', r->>'product_page', r->>'data_status',
       ${textArray("r->'notes'")}
from jsonb_array_elements(seed->'robots') r
on conflict (slug) do update set
  manufacturer = excluded.manufacturer, model = excluded.model, family = excluded.family,
  kinematic_type = excluded.kinematic_type, application = excluded.application,
  typical_application = excluded.typical_application, product_page = excluded.product_page,
  data_status = excluded.data_status, notes = excluded.notes;

-- Variantes que ya no están en los JSON (solo de robots del seed) --------------------
delete from public.robot_variants rv
using public.robots r
where rv.robot_id = r.id
  and r.slug in (select x->>'slug' from jsonb_array_elements(seed->'robots') x)
  and rv.slug not in (select x->>'slug' from jsonb_array_elements(seed->'variants') x);

insert into public.robot_variants (robot_id, slug, variant_code, reach_mm, payload_kg)
select r.id, v->>'slug', v->>'variant_code', (v->>'reach_mm')::numeric, (v->>'payload_kg')::numeric
from jsonb_array_elements(seed->'variants') v
join public.robots r on r.slug = v->>'robot_slug'
on conflict (slug) do update set
  robot_id = excluded.robot_id, variant_code = excluded.variant_code,
  reach_mm = excluded.reach_mm, payload_kg = excluded.payload_kg;

insert into public.robot_specs (variant_id, axes_count, axes_note, reach_mm, workspace_diameter_mm,
  payload_kg, payload_note, armload_kg, weight_kg, repeatability_mm, repeatability,
  mounting_allowed, ip_rating, controller, axis_limits, published_cycle_times,
  max_tcp_speed_m_s, extra, provenance)
select rv.id, (v->>'axes_count')::int, v->>'axes_note', (v->>'reach_mm')::numeric,
       (v->>'workspace_diameter_mm')::numeric, (v->>'payload_kg')::numeric, v->>'payload_note',
       (v->>'armload_kg')::numeric, (v->>'weight_kg')::numeric, (v->>'repeatability_mm')::numeric,
       ${nullableJson("v->'repeatability'")}, ${textArray("v->'mounting_allowed'")},
       v->>'ip_rating', v->>'controller', ${nullableJson("v->'axis_limits'")},
       ${nullableJson("v->'published_cycle_times'")}, (v->>'max_tcp_speed_m_s')::numeric,
       ${nullableJson("v->'extra'")}, v->'provenance'
from jsonb_array_elements(seed->'variants') v
join public.robot_variants rv on rv.slug = v->>'slug'
on conflict (variant_id) do update set
  axes_count = excluded.axes_count, axes_note = excluded.axes_note, reach_mm = excluded.reach_mm,
  workspace_diameter_mm = excluded.workspace_diameter_mm, payload_kg = excluded.payload_kg,
  payload_note = excluded.payload_note, armload_kg = excluded.armload_kg,
  weight_kg = excluded.weight_kg, repeatability_mm = excluded.repeatability_mm,
  repeatability = excluded.repeatability, mounting_allowed = excluded.mounting_allowed,
  ip_rating = excluded.ip_rating, controller = excluded.controller,
  axis_limits = excluded.axis_limits, published_cycle_times = excluded.published_cycle_times,
  max_tcp_speed_m_s = excluded.max_tcp_speed_m_s, extra = excluded.extra,
  provenance = excluded.provenance;

-- Documentos de robot (fuente y términos de uso) -----------------------------------------
delete from public.robot_documents rd
using public.robots r
where rd.robot_id = r.id
  and r.slug in (select x->>'slug' from jsonb_array_elements(seed->'robots') x)
  and not exists (select 1 from jsonb_array_elements(seed->'robot_documents') x
                  where x->>'robot_slug' = r.slug and x->>'path' = rd.path);

insert into public.robot_documents (robot_id, path, kind, doc_id, revision, doc_date, title, url,
  library_page, accessed_at, sha256, size_bytes, license_terms)
select r.id, x->>'path', x->>'kind', x->>'doc_id', x->>'revision', (x->>'doc_date')::date,
       x->>'title', x->>'url', x->>'library_page', (x->>'accessed_at')::timestamptz,
       x->>'sha256', (x->>'size_bytes')::bigint, x->>'license_terms'
from jsonb_array_elements(seed->'robot_documents') x
join public.robots r on r.slug = x->>'robot_slug'
on conflict (robot_id, path) do update set
  kind = excluded.kind, doc_id = excluded.doc_id, revision = excluded.revision,
  doc_date = excluded.doc_date, title = excluded.title, url = excluded.url,
  library_page = excluded.library_page, accessed_at = excluded.accessed_at,
  sha256 = excluded.sha256, size_bytes = excluded.size_bytes, license_terms = excluded.license_terms;

-- Componentes -----------------------------------------------------------------------------
insert into public.components (slug, manufacturer, model, category, type, notes)
select c->>'slug', c->>'manufacturer', c->>'model', c->>'category', c->>'type', ${textArray("c->'notes'")}
from jsonb_array_elements(seed->'components') c
on conflict (slug) do update set
  manufacturer = excluded.manufacturer, model = excluded.model, category = excluded.category,
  type = excluded.type, notes = excluded.notes;

insert into public.component_specs (component_id, specs, provenance)
select co.id, c->'specs', c->'provenance'
from jsonb_array_elements(seed->'components') c
join public.components co on co.slug = c->>'slug'
on conflict (component_id) do update set specs = excluded.specs, provenance = excluded.provenance;

delete from public.component_documents cd
using public.components co
where cd.component_id = co.id
  and co.slug in (select x->>'slug' from jsonb_array_elements(seed->'components') x)
  and not exists (select 1 from jsonb_array_elements(seed->'component_documents') x
                  where x->>'component_slug' = co.slug and x->>'path' = cd.path);

insert into public.component_documents (component_id, path, kind, title, url, accessed_at, sha256,
  size_bytes, license_terms, note)
select co.id, x->>'path', x->>'kind', x->>'title', x->>'url', (x->>'accessed_at')::timestamptz,
       x->>'sha256', (x->>'size_bytes')::bigint, x->>'license_terms', x->>'note'
from jsonb_array_elements(seed->'component_documents') x
join public.components co on co.slug = x->>'component_slug'
on conflict (component_id, path) do update set
  kind = excluded.kind, title = excluded.title, url = excluded.url,
  accessed_at = excluded.accessed_at, sha256 = excluded.sha256,
  size_bytes = excluded.size_bytes, license_terms = excluded.license_terms, note = excluded.note;

-- Tipos de objeto paramétricos y sus presets (catalog_components/standards/presets.json) ----
insert into public.object_types (key, name, category, presets)
select o->>'key', o->>'name', o->>'category', o->'presets'
from jsonb_array_elements(seed->'object_types') o
on conflict (key) do update set
  name = excluded.name, category = excluded.category, presets = excluded.presets;

raise notice 'catálogo aplicado';
end
${DO_TAG};

select
  (select count(*) from public.robots) as robots,
  (select count(*) from public.robot_variants) as variantes,
  (select count(*) from public.robot_specs) as specs,
  (select count(*) from public.robot_documents) as documentos,
  (select count(*) from public.components) as componentes,
  (select count(*) from public.object_types) as tipos_de_objeto;
`;
}

function main() {
  const data = loadSeedData();
  for (const w of [...new Set(data.warnings)]) console.warn(`⚠ ${w}`);
  const sql = buildCatalogSeed(data);
  const rel = relative(ROOT, SEED_PATH);
  if (process.argv.includes('--check')) {
    const current = existsSync(SEED_PATH) ? readFileSync(SEED_PATH, 'utf8') : '';
    if (current !== sql) {
      console.error(`${rel} no está al día. Ejecuta: pnpm catalog:sql`);
      process.exit(1);
    }
    console.log(`✔ ${rel} está al día.`);
    return;
  }
  writeFileSync(SEED_PATH, sql);
  console.log(
    `✔ ${rel} generado: ${data.robots.length} robots, ${data.variants.length} variantes, ` +
      `${data.robotDocuments.length} documentos, ${data.components.length} componentes.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
