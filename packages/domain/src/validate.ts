import type { RobotModel } from './robot-model.ts';
import type { Scene, SceneObject } from './scene.ts';

// Validaciones simples del layout. Sin física: alcance contra la envolvente de la ficha,
// carga nominal y colisiones por cajas delimitadoras alineadas a los ejes (AABB).

export interface SceneWarning {
  kind: 'reach' | 'payload' | 'collision' | 'data';
  level: 'warning' | 'info';
  objects: string[];
  message: string;
}

export type Vec3 = [number, number, number];
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Tolerancia: objetos que solo se tocan (uno apoyado sobre otro) no colisionan. */
export const CONTACT_EPS_MM = 0.5;

const rad = (deg: number) => (deg * Math.PI) / 180;
const fmtMm = (v: number) => `${Math.round(v).toLocaleString('es-MX')} mm`;

/** AABB en coordenadas del mundo. Para robots se usa solo la base. */
export function aabb(o: SceneObject, model?: RobotModel | null): Aabb {
  const [x, y] = o.position;
  if (o.kind === 'robot') {
    const r = model?.base.radius ?? 100;
    const h = model?.base.height ?? 200;
    const [z0, z1] = model?.inverted
      ? [o.elevation - h, o.elevation]
      : [o.elevation, o.elevation + h];
    return { min: [x - r, y - r, z0], max: [x + r, y + r, z1] };
  }
  const { length_mm: l, width_mm: w, height_mm: h } = o.params;
  const c = Math.abs(Math.cos(rad(o.rotation_deg)));
  const s = Math.abs(Math.sin(rad(o.rotation_deg)));
  const hx = (c * l + s * w) / 2;
  const hy = (s * l + c * w) / 2;
  return { min: [x - hx, y - hy, o.elevation], max: [x + hx, y + hy, o.elevation + h] };
}

export function overlaps(a: Aabb, b: Aabb, eps = CONTACT_EPS_MM): boolean {
  return [0, 1, 2].every((i) => a.min[i]! < b.max[i]! - eps && b.min[i]! < a.max[i]! - eps);
}

/** Punto de la cara superior del objeto más cercano (en planta) a `p`, respetando su giro. */
export function nearestTopPoint(
  o: Exclude<SceneObject, { kind: 'robot' }>,
  p: [number, number],
): Vec3 {
  const a = rad(o.rotation_deg);
  const dx = p[0] - o.position[0];
  const dy = p[1] - o.position[1];
  // Al marco local del objeto, se limita al rectángulo y se vuelve al mundo.
  const lx = Math.cos(a) * dx + Math.sin(a) * dy;
  const ly = -Math.sin(a) * dx + Math.cos(a) * dy;
  const cx = Math.max(-o.params.length_mm / 2, Math.min(o.params.length_mm / 2, lx));
  const cy = Math.max(-o.params.width_mm / 2, Math.min(o.params.width_mm / 2, ly));
  return [
    o.position[0] + Math.cos(a) * cx - Math.sin(a) * cy,
    o.position[1] + Math.sin(a) * cx + Math.cos(a) * cy,
    o.elevation + o.params.height_mm,
  ];
}

/**
 * Cuánto excede el objeto la envolvente del robot (mm). 0 = alcanzable.
 * null = no se puede validar (alcance no publicado).
 */
export function reachExcess(
  robot: Extract<SceneObject, { kind: 'robot' }>,
  model: RobotModel,
  target: Exclude<SceneObject, { kind: 'robot' }>,
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
): SceneWarning[] {
  const warnings: SceneWarning[] = [];
  const byId = new Map(scene.objects.map((o) => [o.id, o]));
  const modelOf = (o: SceneObject) => (o.kind === 'robot' ? modelFor(o.params.variant_slug) : null);

  for (const o of scene.objects) {
    if (o.kind === 'robot' || !o.served_by) continue;
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

    if (o.kind === 'box') {
      if (o.params.mass_kg == null) {
        warnings.push({
          kind: 'payload',
          level: 'info',
          objects: [o.id, robot.id],
          message: `${o.name} no tiene masa: no se valida la carga de ${robot.name}.`,
        });
      } else if (model.payload_kg == null) {
        warnings.push({
          kind: 'payload',
          level: 'info',
          objects: [o.id, robot.id],
          message: `${robot.name} no publica carga útil: no se valida ${o.name}.`,
        });
      } else if (o.params.mass_kg > model.payload_kg) {
        warnings.push({
          kind: 'payload',
          level: 'warning',
          objects: [o.id, robot.id],
          message: `${o.name} (${o.params.mass_kg} kg) excede la carga útil nominal de ${robot.name} (${model.payload_kg} kg). No incluye la herramienta.`,
        });
      }
    }
  }

  const boxes = scene.objects.map((o) => ({ o, box: aabb(o, modelOf(o)) }));
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
