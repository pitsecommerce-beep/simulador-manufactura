import { z } from 'zod';
import { ProcessModel, emptyProcess } from './process.ts';

// Escena del lienzo 3D (layouts.scene). Unidades: milímetros y grados. Eje Z hacia arriba.

export const OBJECT_KINDS = [
  'robot',
  'pallet',
  'box',
  'table',
  'conveyor',
  'gripper',
  'sensor',
  'fence',
  'safety_zone',
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export const MAX_SCENE_OBJECTS = 500;
const mm = z.number().finite().min(-100_000).max(100_000);
const size = z.number().finite().positive().max(50_000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const Base = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  position: z.tuple([mm, mm]),
  elevation: z.number().finite().min(0).max(20_000).default(0),
  rotation_deg: z.number().finite().min(-360).max(360).default(0),
  color,
  /** Robot que atiende el objeto (para validar alcance y carga). */
  served_by: z.string().max(64).nullable().default(null),
});

const Dims = z.object({ length_mm: size, width_mm: size, height_mm: size });
const ComponentSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]*$/)
  .max(120)
  .nullable()
  .default(null);

export const PALLET_PRESETS = ['eur', 'gma', '1200x1000', 'custom'] as const;
export type PalletPreset = (typeof PALLET_PRESETS)[number];

export const SceneObject = z.discriminatedUnion('kind', [
  Base.extend({
    kind: z.literal('robot'),
    params: z.object({
      variant_slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]*$/)
        .max(120),
      /** Valor por eje en la unidad de la ficha (grados o mm). */
      joints: z.array(z.number().finite()).max(12).default([]),
      show_envelope: z.boolean().default(false),
    }),
  }),
  Base.extend({
    kind: z.literal('pallet'),
    // La altura es obligatoria: solo el EUR la publica. No se guarda ningún valor por defecto.
    params: Dims.extend({ preset: z.enum(PALLET_PRESETS) }),
  }),
  Base.extend({
    kind: z.literal('box'),
    params: Dims.extend({ mass_kg: z.number().finite().nonnegative().max(10_000).nullable() }),
  }),
  Base.extend({ kind: z.literal('table'), params: Dims }),
  Base.extend({ kind: z.literal('conveyor'), params: Dims }),
  Base.extend({
    kind: z.literal('gripper'),
    params: z.object({
      component_slug: ComponentSlug,
      /** Robot en cuya brida va montado; null = suelto en el piso. */
      mounted_on: z.string().max(64).nullable().default(null),
    }),
  }),
  Base.extend({ kind: z.literal('sensor'), params: z.object({ component_slug: ComponentSlug }) }),
  Base.extend({
    kind: z.literal('fence'),
    params: z.object({
      length_mm: size,
      height_mm: size,
      thickness_mm: size,
      component_slug: ComponentSlug,
    }),
  }),
  // Zona en el piso: no colisiona; se avisa si la envolvente de un robot la invade.
  Base.extend({
    kind: z.literal('safety_zone'),
    params: z.object({ length_mm: size, width_mm: size }),
  }),
]);
export type SceneObject = z.infer<typeof SceneObject>;
export type RobotObject = Extract<SceneObject, { kind: 'robot' }>;

const SceneV2 = z
  .object({
    schema: z.literal(2),
    objects: z.array(SceneObject).max(MAX_SCENE_OBJECTS),
    process: ProcessModel.default(emptyProcess()),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    for (const [i, o] of s.objects.entries()) {
      if (ids.has(o.id))
        ctx.addIssue({ code: 'custom', path: ['objects', i, 'id'], message: 'id repetido' });
      ids.add(o.id);
    }
  });

/** Convierte escenas antiguas: `{}` y `schema: 1` (sin proceso) pasan a `schema: 2`. */
export function upgradeScene(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length === 0) return { schema: 2, objects: [], process: emptyProcess() };
  if (r.schema === 1) return { ...r, schema: 2, process: emptyProcess() };
  return raw;
}

export const Scene = z.preprocess(upgradeScene, SceneV2);
export type Scene = z.infer<typeof SceneV2>;

export const emptyScene = (): Scene => ({ schema: 2, objects: [], process: emptyProcess() });

/** Escena guardada: tolera layouts antiguos (`{}` o `schema: 1`). */
export function parseStoredScene(raw: unknown): Scene {
  return Scene.parse(raw);
}

export const SaveLayout = z.object({
  scene: Scene,
  /** Versión que el cliente cargó; null si aún no existe layout. */
  version: z.number().int().positive().nullable(),
});
export type SaveLayout = z.infer<typeof SaveLayout>;

export interface LayoutDoc {
  version: number | null;
  scene: Scene;
  updated_at: string | null;
}

/**
 * Medidas de pallet de catalog_components/standards/presets.json.
 * `height_mm` null = no publicada: el usuario debe capturarla (no hay valor por defecto).
 */
export const PALLET_SIZES: Record<
  Exclude<PalletPreset, 'custom'>,
  { label: string; length_mm: number; width_mm: number; height_mm: number | null; source: string }
> = {
  eur: {
    label: 'EUR / EPAL 1200 × 800',
    length_mm: 1200,
    width_mm: 800,
    height_mm: 144,
    source: 'EPAL / ISO 6780',
  },
  gma: {
    label: 'GMA 1219 × 1016 (48 × 40 in)',
    length_mm: 1219,
    width_mm: 1016,
    height_mm: null,
    source: 'ISO 6780',
  },
  '1200x1000': {
    label: '1200 × 1000 (EUR 2 / ISO)',
    length_mm: 1200,
    width_mm: 1000,
    height_mm: null,
    source: 'ISO 6780',
  },
};
