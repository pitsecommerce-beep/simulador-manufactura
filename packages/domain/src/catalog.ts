import { z } from 'zod';

// Catálogo de robots con datos de ficha técnica. Todo dato no publicado es null.

export const KINEMATIC_TYPES = ['serial', 'parallel_linkage', 'delta', 'scara'] as const;
export type KinematicType = (typeof KINEMATIC_TYPES)[number];

export interface AxisLimit {
  axis: number;
  min: number | null;
  max: number | null;
  unit: 'deg' | 'mm' | string | null;
  max_speed: number | null;
  speed_unit: string | null;
  note?: string | null;
}

export interface CycleTime {
  condition?: string | null;
  value_s?: number | null;
  table?: Record<string, (number | null)[]>;
  mapping_uncertain?: boolean;
}

/**
 * Documento y página de los que salió un dato. Título, URL y términos de uso están en
 * `RobotDocument` (se unen por `file` = `path`).
 */
export interface DataSource {
  file: string;
  page: number | null;
  section: string | null;
  doc_id?: string | null;
  revision?: string | null;
}

/** Procedencia por campo. null = la ficha no indica la fuente de ese dato. */
export type Provenance = Record<string, DataSource[] | null> & {
  _extraction?: { extracted_from: string[]; extracted_at: string | null; note: string | null };
};

/** Campos de ficha con procedencia propia (claves de `Provenance`). */
export const SPEC_FIELDS = [
  'axes_count',
  'reach_mm',
  'workspace_diameter_mm',
  'payload_kg',
  'armload_kg',
  'weight_kg',
  'repeatability',
  'mounting_allowed',
  'ip_rating',
  'controller',
  'axis_limits',
  'published_cycle_times',
  'max_tcp_speed_m_s',
  'extra',
] as const;
export type SpecField = (typeof SPEC_FIELDS)[number];

export interface RobotSpecs {
  axes_count: number | null;
  axes_note: string | null;
  reach_mm: number | null;
  workspace_diameter_mm: number | null;
  payload_kg: number | null;
  payload_note: string | null;
  armload_kg: number | null;
  weight_kg: number | null;
  repeatability_mm: number | null;
  repeatability: Record<string, unknown> | null;
  mounting_allowed: string[] | null;
  ip_rating: string | null;
  controller: string | null;
  axis_limits: AxisLimit[] | null;
  published_cycle_times: CycleTime[] | null;
  max_tcp_speed_m_s: number | null;
  extra: Record<string, unknown> | null;
  notes: string[] | null;
  provenance: Provenance;
}

export interface CatalogVariant {
  slug: string;
  variant_code: string;
  robot_slug: string;
  model: string;
  manufacturer: string;
  family: string | null;
  kinematic_type: KinematicType | null;
  application: string | null;
  axes_count: number | null;
  axes_note: string | null;
  reach_mm: number | null;
  workspace_diameter_mm: number | null;
  payload_kg: number | null;
}

export interface RobotDocument {
  path: string;
  kind: string;
  doc_id: string | null;
  revision: string | null;
  doc_date: string | null;
  title: string | null;
  url: string | null;
  library_page: string | null;
  accessed_at: string | null;
  license_terms: string | null;
}

export interface CatalogVariantDetail {
  variant: CatalogVariant;
  robot: {
    slug: string;
    model: string;
    manufacturer: string;
    family: string | null;
    application: string | null;
    typical_application: string | null;
    product_page: string | null;
    data_status: 'ok' | 'partial' | null;
    notes: string[] | null;
  };
  specs: RobotSpecs | null;
  documents: RobotDocument[];
  siblings: { slug: string; variant_code: string }[];
}

const optNumber = z.preprocess(
  (v) => (v === '' || v === undefined ? undefined : v),
  z.coerce.number().nonnegative().optional(),
);

export const CatalogQuery = z.object({
  q: z.string().trim().max(100).optional(),
  family: z.string().trim().max(100).optional(),
  application: z.string().trim().max(300).optional(),
  payload_min: optNumber,
  payload_max: optNumber,
  reach_min: optNumber,
  reach_max: optNumber,
});
export type CatalogQuery = z.infer<typeof CatalogQuery>;

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Alcance efectivo para filtros: alcance publicado o, en robots delta, radio de trabajo. */
export function effectiveReachMm(v: Pick<CatalogVariant, 'reach_mm' | 'workspace_diameter_mm'>) {
  if (v.reach_mm != null) return v.reach_mm;
  return v.workspace_diameter_mm != null ? v.workspace_diameter_mm / 2 : null;
}

/**
 * Filtra variantes. Los filtros numéricos excluyen las variantes cuyo dato no está publicado.
 */
export function filterVariants(list: CatalogVariant[], q: CatalogQuery): CatalogVariant[] {
  const text = q.q ? norm(q.q) : null;
  const inRange = (value: number | null, min?: number, max?: number) => {
    if (min === undefined && max === undefined) return true;
    if (value == null) return false;
    return (min === undefined || value >= min) && (max === undefined || value <= max);
  };
  return list.filter(
    (v) =>
      (!text || norm(`${v.model} ${v.variant_code} ${v.family ?? ''}`).includes(text)) &&
      (!q.family || v.family === q.family) &&
      (!q.application || v.application === q.application) &&
      inRange(v.payload_kg, q.payload_min, q.payload_max) &&
      inRange(effectiveReachMm(v), q.reach_min, q.reach_max),
  );
}

export interface CatalogFacets {
  families: string[];
  applications: string[];
  payload: { min: number | null; max: number | null };
  reach: { min: number | null; max: number | null };
}

export function catalogFacets(list: CatalogVariant[]): CatalogFacets {
  const uniq = (xs: (string | null)[]) =>
    [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, 'es'));
  const range = (xs: (number | null)[]) => {
    const n = xs.filter((x): x is number => x != null);
    return n.length ? { min: Math.min(...n), max: Math.max(...n) } : { min: null, max: null };
  };
  return {
    families: uniq(list.map((v) => v.family)),
    applications: uniq(list.map((v) => v.application)),
    payload: range(list.map((v) => v.payload_kg)),
    reach: range(list.map(effectiveReachMm)),
  };
}

/** Componente del catálogo (gripper, sensor, banda, valla...). `specs` va tal cual de la ficha. */
export interface CatalogComponent {
  slug: string;
  manufacturer: string | null;
  model: string;
  category: string;
  type: string | null;
  specs: Record<string, unknown>;
  notes: string[] | null;
}

/** Peso publicado de un componente, si su ficha lo trae como número. */
export function componentWeightKg(c: Pick<CatalogComponent, 'specs'>): number | null {
  const w = c.specs.weight_kg;
  return typeof w === 'number' && Number.isFinite(w) ? w : null;
}
