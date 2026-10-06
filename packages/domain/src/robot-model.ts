import type { AxisLimit, KinematicType } from './catalog.ts';

// Robot paramétrico simplificado generado desde la ficha técnica.
// De la ficha salen SIEMPRE el alcance total y los rangos de cada eje. Las proporciones de
// los eslabones NO se publican: son un supuesto visual fijo por familia (ver PROPORTIONS).

export const SIMPLIFIED_NOTICE =
  'Representación simplificada generada desde la ficha técnica. No es el CAD real.';
export const PROPORTIONS_NOTICE =
  'Supuesto visual: las longitudes de los eslabones no se publican; se usan proporciones fijas por familia. El alcance total y los rangos de eje sí son de la ficha.';

export type ModelKind = 'serial6' | 'palletizer4' | 'delta' | 'scara' | 'block';

export interface RobotSpecInput {
  kinematic_type: KinematicType | null;
  axes_count: number | null;
  reach_mm: number | null;
  workspace_diameter_mm: number | null;
  payload_kg: number | null;
  axis_limits: AxisLimit[] | null;
}

export interface JointDef {
  axis: number;
  type: 'revolute' | 'prismatic';
  /** Rango de la ficha (grados o mm). null = no publicado: el eje no se puede mover. */
  min: number | null;
  max: number | null;
  unit: 'deg' | 'mm';
  /** Valor inicial: 0 si está dentro del rango; si no, el punto medio. */
  home: number;
}

export type Envelope =
  | { type: 'sphere'; center_z: number; radius: number }
  | { type: 'cylinder'; top_z: number; radius: number; height: number | null }
  | { type: 'annulus'; top_z: number; radius: number; height: number }
  | { type: 'none' };

export interface RobotModel {
  kind: ModelKind;
  /** Alcance horizontal o radio de trabajo de la ficha, en mm. null = no publicado. */
  reach_mm: number | null;
  payload_kg: number | null;
  /** Longitudes del modelo visual (mm). Supuesto visual salvo `reach`. */
  dims: Record<string, number>;
  joints: JointDef[];
  envelope: Envelope;
  /** Huella de la base (mm) para colisiones AABB. */
  base: { radius: number; height: number };
  /** Montaje en techo o estructura: la base cuelga a `elevation` del objeto. */
  inverted: boolean;
  notes: string[];
}

// Supuestos visuales (fracción del alcance R). Ajustados para que el alcance máximo sea R.
export const PROPORTIONS = {
  serial6: { shoulder: 0.35, upper: 0.45, fore: 0.42, wrist: 0.13, base_r: 0.12, base_h: 0.2 },
  palletizer4: { shoulder: 0.4, upper: 0.5, fore: 0.5, base_r: 0.16, base_h: 0.22 },
  scara: { arm1: 0.5, arm2: 0.5, drop: 0.35, base_r: 0.12 },
  delta: { base_r: 0.3, platform_r: 0.08, drop: 0.55 },
} as const;

/** Alcance usado si la ficha no lo publica, solo para dibujar (no para validar). */
const FALLBACK_DRAW_REACH = 1000;

export function modelKind(
  s: Pick<RobotSpecInput, 'kinematic_type' | 'axes_count' | 'axis_limits'>,
): ModelKind {
  if (s.kinematic_type === 'delta') return 'delta';
  if (s.kinematic_type === 'scara') return 'scara';
  if (s.kinematic_type === 'parallel_linkage') return 'palletizer4';
  if (s.axes_count == null && !s.axis_limits?.length) return 'block';
  if (s.axes_count === 4) return 'palletizer4';
  return 'serial6';
}

function joint(
  axis: number,
  limit: AxisLimit | undefined,
  fallbackType: JointDef['type'],
): JointDef {
  const unit =
    limit?.unit === 'mm'
      ? 'mm'
      : limit?.unit === 'deg'
        ? 'deg'
        : fallbackType === 'prismatic'
          ? 'mm'
          : 'deg';
  const min = limit?.min ?? null;
  const max = limit?.max ?? null;
  const home = min != null && max != null ? (min <= 0 && max >= 0 ? 0 : (min + max) / 2) : 0;
  return { axis, type: unit === 'mm' ? 'prismatic' : 'revolute', min, max, unit, home };
}

const jointsFor = (count: number, limits: AxisLimit[] | null, types: JointDef['type'][] = []) =>
  Array.from({ length: count }, (_, i) =>
    joint(
      i + 1,
      limits?.find((l) => l.axis === i + 1),
      types[i] ?? 'revolute',
    ),
  );

export function buildRobotModel(s: RobotSpecInput): RobotModel {
  const kind = modelKind(s);
  const notes: string[] = [];
  const published =
    kind === 'delta'
      ? s.workspace_diameter_mm != null
        ? s.workspace_diameter_mm / 2
        : null
      : s.reach_mm;
  if (published == null)
    notes.push(
      'Alcance no publicado: el modelo usa un tamaño de dibujo y no se valida el alcance.',
    );
  const R = published ?? FALLBACK_DRAW_REACH;

  switch (kind) {
    case 'serial6': {
      const p = PROPORTIONS.serial6;
      const count = s.axis_limits?.length || s.axes_count || 6;
      return {
        kind,
        reach_mm: published,
        payload_kg: s.payload_kg,
        dims: {
          reach: R,
          shoulder: p.shoulder * R,
          upper: p.upper * R,
          fore: p.fore * R,
          wrist: p.wrist * R,
        },
        joints: jointsFor(count, s.axis_limits),
        envelope: { type: 'sphere', center_z: p.shoulder * R, radius: R },
        base: { radius: p.base_r * R, height: p.base_h * R },
        inverted: false,
        notes,
      };
    }
    case 'palletizer4': {
      const p = PROPORTIONS.palletizer4;
      return {
        kind,
        reach_mm: published,
        payload_kg: s.payload_kg,
        dims: { reach: R, shoulder: p.shoulder * R, upper: p.upper * R, fore: p.fore * R },
        joints: jointsFor(s.axis_limits?.length || 4, s.axis_limits),
        envelope: { type: 'sphere', center_z: p.shoulder * R, radius: R },
        base: { radius: p.base_r * R, height: p.base_h * R },
        inverted: false,
        notes: [...notes, 'Paralelogramo simplificado: la herramienta se mantiene vertical.'],
      };
    }
    case 'scara': {
      const p = PROPORTIONS.scara;
      const joints = jointsFor(s.axis_limits?.length || 4, s.axis_limits, [
        'revolute',
        'revolute',
        'prismatic',
        'revolute',
      ]);
      const stroke = joints.find((j) => j.type === 'prismatic');
      const strokeLen = stroke?.min != null && stroke.max != null ? stroke.max - stroke.min : 0;
      return {
        kind,
        reach_mm: published,
        payload_kg: s.payload_kg,
        dims: { reach: R, arm1: p.arm1 * R, arm2: p.arm2 * R, drop: p.drop * R, stroke: strokeLen },
        joints,
        envelope: { type: 'annulus', top_z: -p.drop * R, radius: R, height: strokeLen },
        base: { radius: p.base_r * R, height: p.drop * R },
        inverted: true,
        notes: [...notes, 'Montaje invertido: la elevación es la altura de la base.'],
      };
    }
    case 'delta': {
      const p = PROPORTIONS.delta;
      return {
        kind,
        reach_mm: published,
        payload_kg: s.payload_kg,
        dims: { reach: R, base_r: p.base_r * R, platform_r: p.platform_r * R, drop: p.drop * R },
        // Los delta no publican rangos de eje: sus ejes no se pueden mover en el lienzo.
        joints: s.axis_limits?.length ? jointsFor(s.axis_limits.length, s.axis_limits) : [],
        envelope: { type: 'cylinder', top_z: -p.drop * R, radius: R, height: null },
        base: { radius: p.base_r * R * 1.3, height: 0.1 * R },
        inverted: true,
        notes: [
          ...notes,
          'Rangos de eje no publicados: los brazos no se mueven.',
          'Altura del volumen de trabajo no publicada: se dibuja solo el diámetro.',
        ],
      };
    }
    case 'block':
      return {
        kind,
        reach_mm: published,
        payload_kg: s.payload_kg,
        dims: { reach: R },
        joints: [],
        envelope:
          published != null ? { type: 'sphere', center_z: 0.35 * R, radius: R } : { type: 'none' },
        base: { radius: 0.15 * R, height: 0.6 * R },
        inverted: false,
        notes: [...notes, 'Ejes no publicados: se dibuja un bloque sin ejes móviles.'],
      };
  }
}

/** Limita un valor de eje a su rango publicado. Ejes sin rango no se mueven (valor inicial). */
export function clampJoint(j: JointDef, value: number): number {
  if (j.min == null || j.max == null) return j.home;
  return Math.min(j.max, Math.max(j.min, value));
}

/** Valores de eje de la escena, completados y limitados al rango de la ficha. */
export function resolveJoints(model: RobotModel, values: number[]): number[] {
  return model.joints.map((j, i) => clampJoint(j, values[i] ?? j.home));
}
