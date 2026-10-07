import type { RobotModel } from './robot-model.ts';
import type { Scene, SceneObject } from './scene.ts';

// Validaciones simples del layout. Sin física: alcance contra la envolvente de la ficha,
// carga nominal y colisiones por cajas delimitadoras alineadas a los ejes (AABB).

export interface SceneWarning {
  kind: 'reach' | 'payload' | 'collision' | 'safety' | 'data';
  level: 'warning' | 'info';
  objects: string[];
  message: string;
}

export type Vec3 = [number, number, number];
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Objetos con medidas a los que un robot puede dar servicio. */
export type WorkObject = Extract<SceneObject, { kind: 'pallet' | 'box' | 'table' | 'conveyor' }>;
export const isWorkObject = (o: SceneObject): o is WorkObject =>
  o.kind === 'pallet' || o.kind === 'box' || o.kind === 'table' || o.kind === 'conveyor';

/** Datos de un componente del catálogo usados en las validaciones. */
export interface ComponentInfo {
  name: string;
  /** Peso publicado en la ficha; null = no publicado. */
  weight_kg: number | null;
}

/** Tolerancia: objetos que solo se tocan (uno apoyado sobre otro) no colisionan. */
export const CONTACT_EPS_MM = 0.5;

/**
 * Tamaño de dibujo de gripper y sensor sueltos (supuesto visual: las fichas no publican
 * medidas en un formato utilizable).
 */
export const VISUAL_SIZE = {
  gripper: { length_mm: 160, width_mm: 120, height_mm: 120 },
  sensor: { length_mm: 60, width_mm: 60, height_mm: 60 },
} as const;

const rad = (deg: number) => (deg * Math.PI) / 180;
const fmtMm = (v: number) => `${Math.round(v).toLocaleString('es-MX')} mm`;

/** Medidas en planta y altura de un objeto (largo en su eje X local). null = no ocupa volumen. */
export function footprint(o: SceneObject): { l: number; w: number; h: number } | null {
  switch (o.kind) {
    case 'pallet':
    case 'box':
    case 'table':
    case 'conveyor':
      return { l: o.params.length_mm, w: o.params.width_mm, h: o.params.height_mm };
    case 'fence':
      return { l: o.params.length_mm, w: o.params.thickness_mm, h: o.params.height_mm };
    case 'gripper':
      // Montado en un robot se mueve con la brida: no entra en colisiones.
      return o.params.mounted_on
        ? null
        : {
            l: VISUAL_SIZE.gripper.length_mm,
            w: VISUAL_SIZE.gripper.width_mm,
            h: VISUAL_SIZE.gripper.height_mm,
          };
    case 'sensor':
      return {
        l: VISUAL_SIZE.sensor.length_mm,
        w: VISUAL_SIZE.sensor.width_mm,
        h: VISUAL_SIZE.sensor.height_mm,
      };
    case 'safety_zone':
    case 'robot':
      return null;
  }
}

/** AABB en coordenadas del mundo. Robots: solo la base. null = el objeto no colisiona. */
export function aabb(o: SceneObject, model?: RobotModel | null): Aabb | null {
  const [x, y] = o.position;
  if (o.kind === 'robot') {
    const r = model?.base.radius ?? 100;
    const h = model?.base.height ?? 200;
    const [z0, z1] = model?.inverted
      ? [o.elevation - h, o.elevation]
      : [o.elevation, o.elevation + h];
    return { min: [x - r, y - r, z0], max: [x + r, y + r, z1] };
  }
  const f = footprint(o);
  if (!f) return null;
  const c = Math.abs(Math.cos(rad(o.rotation_deg)));
  const s = Math.abs(Math.sin(rad(o.rotation_deg)));
  const hx = (c * f.l + s * f.w) / 2;
  const hy = (s * f.l + c * f.w) / 2;
  return { min: [x - hx, y - hy, o.elevation], max: [x + hx, y + hy, o.elevation + f.h] };
}

export function overlaps(a: Aabb, b: Aabb, eps = CONTACT_EPS_MM): boolean {
  return [0, 1, 2].every((i) => a.min[i]! < b.max[i]! - eps && b.min[i]! < a.max[i]! - eps);
}

/** Punto más cercano (en planta) a `p` dentro de un rectángulo girado. */
function nearestInRect(
  center: [number, number],
  rotationDeg: number,
  l: number,
  w: number,
  p: [number, number],
): [number, number] {
  const a = rad(rotationDeg);
  const dx = p[0] - center[0];
  const dy = p[1] - center[1];
  const lx = Math.cos(a) * dx + Math.sin(a) * dy;
  const ly = -Math.sin(a) * dx + Math.cos(a) * dy;
  const cx = Math.max(-l / 2, Math.min(l / 2, lx));
  const cy = Math.max(-w / 2, Math.min(w / 2, ly));
  return [
    center[0] + Math.cos(a) * cx - Math.sin(a) * cy,
    center[1] + Math.sin(a) * cx + Math.cos(a) * cy,
  ];
}

/** Punto de la cara superior del objeto más cercano (en planta) a `p`, respetando su giro. */
export function nearestTopPoint(o: WorkObject, p: [number, number]): Vec3 {
  const [x, y] = nearestInRect(
    o.position,
    o.rotation_deg,
    o.params.length_mm,
    o.params.width_mm,
    p,
  );
  return [x, y, o.elevation + o.params.height_mm];
}

/**
 * Cuánto excede el objeto la envolvente del robot (mm). 0 = alcanzable.
 * null = no se puede validar (alcance no publicado).
 */
export function reachExcess(
  robot: Extract<SceneObject, { kind: 'robot' }>,
  model: RobotModel,
  target: WorkObject,
): number | null {
  if (model.reach_mm == null) return null;
  const R = model.reach_mm;
  const [rx, ry] = robot.position;
  const p = nearestTopPoint(target, [rx, ry]);
  const horizontal = Math.hypot(p[0] - rx, p[1] - ry);
  if (model.envelope.type === 'sphere') {
    const cz = robot.elevation + model.envelope.center_z;
    return Math.max(0, Math.hypot(horizontal, p[2] - cz) - R);
  }
  // Delta y SCARA invertidos: alcance horizontal; el objeto debe quedar debajo de la base.
  const above = Math.max(0, p[2] - robot.elevation);
  return Math.max(0, horizontal - R) + above;
}

export function validateScene(
  scene: Scene,
  modelFor: (variantSlug: string) => RobotModel | null | undefined,
  componentFor: (slug: string) => ComponentInfo | null | undefined = () => undefined,
): SceneWarning[] {
  const warnings: SceneWarning[] = [];
  const byId = new Map(scene.objects.map((o) => [o.id, o]));
  const modelOf = (o: SceneObject) => (o.kind === 'robot' ? modelFor(o.params.variant_slug) : null);
  const grippers = scene.objects.filter(
    (o): o is Extract<SceneObject, { kind: 'gripper' }> => o.kind === 'gripper',
  );

  for (const g of grippers) {
    const m = g.params.mounted_on;
    if (m && byId.get(m)?.kind !== 'robot') {
      warnings.push({
        kind: 'data',
        level: 'warning',
        objects: [g.id],
        message: `${g.name} está montado en un robot que ya no existe.`,
      });
    }
  }

  for (const o of scene.objects) {
    if (!isWorkObject(o) || !o.served_by) continue;
    const robot = byId.get(o.served_by);
    if (robot?.kind !== 'robot') continue;
    const model = modelOf(robot);
    if (!model) continue;

    const excess = reachExcess(robot, model, o);
    if (excess == null) {
      warnings.push({
        kind: 'reach',
        level: 'info',
        objects: [o.id, robot.id],
        message: `No se puede validar el alcance de ${robot.name} hacia ${o.name}: alcance no publicado.`,
      });
    } else if (excess > 0) {
      warnings.push({
        kind: 'reach',
        level: 'warning',
        objects: [o.id, robot.id],
        message: `${o.name} está fuera del alcance de ${robot.name} (excede ${fmtMm(excess)}).`,
      });
    }

    if (o.kind !== 'box') continue;
    const ids = [o.id, robot.id];
    if (o.params.mass_kg == null) {
      warnings.push({
        kind: 'payload',
        level: 'info',
        objects: ids,
        message: `${o.name} no tiene masa: no se valida la carga de ${robot.name}.`,
      });
      continue;
    }
    if (model.payload_kg == null) {
      warnings.push({
        kind: 'payload',
        level: 'info',
        objects: ids,
        message: `${robot.name} no publica carga útil: no se valida ${o.name}.`,
      });
      continue;
    }
    // Herramienta: el peso del gripper montado se suma solo si su ficha lo publica.
    const tool = grippers.find((g) => g.params.mounted_on === robot.id);
    const info = tool?.params.component_slug ? componentFor(tool.params.component_slug) : undefined;
    let total = o.params.mass_kg;
    let note = ' No incluye la herramienta.';
    if (tool) {
      if (info?.weight_kg != null) {
        total += info.weight_kg;
        note = ` Incluye ${tool.name} (${info.weight_kg} kg publicados).`;
      } else {
        note = ` No incluye ${tool.name}: su peso no está publicado.`;
        warnings.push({
          kind: 'payload',
          level: 'info',
          objects: [tool.id, robot.id],
          message: `El peso de ${tool.name} no está publicado: la carga de ${robot.name} se valida sin la herramienta.`,
        });
      }
    }
    if (total > model.payload_kg) {
      warnings.push({
        kind: 'payload',
        level: 'warning',
        objects: tool ? [...ids, tool.id] : ids,
        message: `${o.name} (${Math.round(total * 100) / 100} kg) excede la carga útil nominal de ${robot.name} (${model.payload_kg} kg).${note}`,
      });
    }
  }

  // Zonas de seguridad invadidas por la envolvente de alcance de un robot.
  for (const z of scene.objects) {
    if (z.kind !== 'safety_zone') continue;
    for (const r of scene.objects) {
      if (r.kind !== 'robot') continue;
      const m = modelOf(r);
      if (m?.reach_mm == null) continue;
      const p = nearestInRect(
        z.position,
        z.rotation_deg,
        z.params.length_mm,
        z.params.width_mm,
        r.position,
      );
      if (Math.hypot(p[0] - r.position[0], p[1] - r.position[1]) < m.reach_mm) {
        warnings.push({
          kind: 'safety',
          level: 'warning',
          objects: [z.id, r.id],
          message: `La envolvente de alcance de ${r.name} invade ${z.name}.`,
        });
      }
    }
  }

  const boxes = scene.objects
    .map((o) => ({ o, box: aabb(o, modelOf(o)) }))
    .filter((x): x is { o: SceneObject; box: Aabb } => x.box != null);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (overlaps(a.box, b.box)) {
        warnings.push({
          kind: 'collision',
          level: 'warning',
          objects: [a.o.id, b.o.id],
          message: `Colisión entre ${a.o.name} y ${b.o.name} (cajas delimitadoras).`,
        });
      }
    }
  }
  return warnings;
}
