import * as m4 from './mat4.ts';
import type { Mat4, Vec3 } from './mat4.ts';
import { VISUAL_SIZE } from './validate.ts';
import type { JointDef, ModelKind, RobotModel } from './robot-model.ts';

// Capa de representación del robot (PLAN 24.1). La animación, la telemetría y el editor solo
// hablan con `RobotVisual`: valores de eje, pose de los eslabones y posición de la
// herramienta. Hoy la implementa la geometría simplificada; el CAD por eslabón implementará la
// misma interfaz con los orígenes de su URDF.

const DEG = Math.PI / 180;

/** Largo supuesto de la herramienta desde la brida hasta el punto de trabajo (TCP), en mm. */
export const TOOL_LENGTH_MM = VISUAL_SIZE.gripper.height_mm;

/** Qué mueve un eslabón respecto a su origen. */
export type LinkDrive =
  | { type: 'fixed' }
  | { type: 'revolute' | 'prismatic'; axis: Vec3; joint: number }
  /** Eslabón pasivo que gira la suma ponderada de otros ejes (paralelogramo). */
  | { type: 'mimic'; axis: Vec3; terms: [joint: number, factor: number][] };

export interface LinkSpec {
  name: string;
  parent: string | null;
  /** Origen del eje respecto al eslabón padre (mm y rad, como en URDF). */
  origin: { xyz: Vec3; rpy: Vec3 };
  drive: LinkDrive;
}

export interface LinkPose {
  name: string;
  /** Pose del eslabón en el marco de la base del robot (por columnas, mm). */
  matrix: Mat4;
}

export interface ToolPose {
  /** Punto de trabajo de la herramienta (TCP) en el marco de la base. */
  position: Vec3;
  /** Dirección en la que apunta la herramienta (unitaria). */
  approach: Vec3;
  /** Pose completa del TCP (para montar una cámara o la pieza). */
  matrix: Mat4;
}

export interface ToolTarget {
  position: Vec3;
  /** Dirección deseada de la herramienta; null = cualquiera. */
  approach?: Vec3 | null;
  /**
   * Eje X deseado de la herramienta (referencia de giro alrededor de `approach`); null =
   * cualquiera. Se acepta también el opuesto: la pieza es simétrica a media vuelta.
   */
  xAxis?: Vec3 | null;
}

export interface IkResult {
  reached: boolean;
  /** Valores de eje (unidad de la ficha). Si no se alcanza, la mejor aproximación. */
  joints: number[];
  error_mm: number;
  error_deg: number;
  reason: string | null;
  /** Se pidió `xAxis` y la cadena no puede orientarla: se resolvió sin ella. */
  xAxisIgnored?: boolean;
}

export interface RobotVisual {
  readonly kind: ModelKind;
  /** Ejes accionados con los rangos y velocidades de la ficha. */
  readonly joints: readonly JointDef[];
  /** Cadena de eslabones con el origen de cada eje. */
  readonly links: readonly LinkSpec[];
  /** Supuestos de la representación (proporciones, rangos no publicados). */
  readonly notes: readonly string[];
  /** Fija los valores de eje (unidad de la ficha); se recortan a los rangos. */
  setJointValues(values: readonly number[]): void;
  jointValues(): number[];
  linkPoses(): LinkPose[];
  toolPose(): ToolPose;
  /** Cinemática inversa sobre su propia cadena. No cambia los valores actuales. */
  solve(target: ToolTarget, seed?: readonly number[]): IkResult;
}

/** Un eje se puede mover solo si la ficha publica su rango (regla del lienzo). */
export const isMovable = (j: JointDef) => j.min != null && j.max != null;

export function clampTo(j: JointDef, v: number): number {
  if (!isMovable(j)) return j.home;
  return Math.min(j.max!, Math.max(j.min!, v));
}

const toInternal = (j: JointDef | undefined, v: number) => (j?.type === 'prismatic' ? v : v * DEG);

// ---------------------------------------------------------------------------
// Cadena serie genérica (simplificada hoy, CAD/URDF mañana)
// ---------------------------------------------------------------------------

export interface SerialChainSpec {
  kind: ModelKind;
  joints: JointDef[];
  links: LinkSpec[];
  /** Eslabón que lleva la herramienta y TCP en su marco; la herramienta apunta a `approach`. */
  tool: { link: string; offset: Vec3; approach: Vec3 };
  notes?: string[];
}

/** RobotVisual de una cadena serie cualquiera, con cinemática inversa numérica. */
export function serialChainVisual(spec: SerialChainSpec): RobotVisual {
  const joints = spec.joints;
  let q = joints.map((j) => j.home);
  const order = spec.links;

  function poses(values: readonly number[]): Map<string, Mat4> {
    const out = new Map<string, Mat4>();
    for (const l of order) {
      const parent = l.parent ? out.get(l.parent) : undefined;
      let m = m4.multiply(parent ?? m4.identity(), m4.fromOrigin(l.origin.xyz, l.origin.rpy));
      const d = l.drive;
      if (d.type === 'revolute')
        m = m4.multiply(m, m4.rotation(d.axis, toInternal(joints[d.joint], values[d.joint] ?? 0)));
      else if (d.type === 'prismatic')
        m = m4.multiply(m, m4.translation(m4.scale(d.axis, values[d.joint] ?? 0)));
      else if (d.type === 'mimic') {
        const a = d.terms.reduce((s, [i, f]) => s + f * toInternal(joints[i], values[i] ?? 0), 0);
        m = m4.multiply(m, m4.rotation(d.axis, a));
      }
      out.set(l.name, m);
    }
    return out;
  }

  function tool(values: readonly number[]): ToolPose {
    const p = poses(values).get(spec.tool.link)!;
    const matrix = m4.multiply(p, m4.translation(spec.tool.offset));
    return {
      position: m4.origin(matrix),
      approach: m4.normalize(m4.transformDir(p, spec.tool.approach)),
      matrix,
    };
  }

  const visual: RobotVisual = {
    kind: spec.kind,
    joints,
    links: order,
    notes: spec.notes ?? [],
    setJointValues(values) {
      q = joints.map((j, i) => clampTo(j, values[i] ?? j.home));
    },
    jointValues: () => [...q],
    linkPoses: () => [...poses(q)].map(([name, matrix]) => ({ name, matrix })),
    toolPose: () => tool(q),
    solve: (target, seed) => solveNumeric(joints, (v) => tool(v), target, seed ?? q),
  };
  return visual;
}

// ---------------------------------------------------------------------------
// Cinemática inversa numérica (mínimos cuadrados amortiguados)
// ---------------------------------------------------------------------------

/** Peso de la orientación: 1 unidad del vector de dirección ≈ 300 mm de error. */
const ORI_WEIGHT = 300;
export const IK_TOL_MM = 1;
export const IK_TOL_DEG = 1;

function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/**
 * Cinemática inversa genérica: solo necesita evaluar la pose de la herramienta para unos
 * valores de eje. Respeta los rangos de la ficha (los ejes sin rango no se mueven).
 */
export function solveNumeric(
  joints: readonly JointDef[],
  toolAt: (values: readonly number[]) => ToolPose,
  target: ToolTarget,
  seed: readonly number[],
): IkResult {
  if (target.xAxis) {
    // Primero con el giro completo; si la cadena no puede orientar la pieza (por ejemplo,
    // un eje de muñeca sin rango publicado), se resuelve solo con la dirección.
    const full = solveOnce(joints, toolAt, target, seed);
    if (full.reached) return full;
    const loose = solveOnce(joints, toolAt, { ...target, xAxis: null }, seed);
    return loose.reached ? { ...loose, xAxisIgnored: true } : full;
  }
  return solveOnce(joints, toolAt, target, seed);
}

const angleBetween = (a: Vec3, b: Vec3) =>
  Math.acos(Math.max(-1, Math.min(1, m4.dot(m4.normalize(a), m4.normalize(b)))));

function solveOnce(
  joints: readonly JointDef[],
  toolAt: (values: readonly number[]) => ToolPose,
  target: ToolTarget,
  seed: readonly number[],
): IkResult {
  const movable = joints.map((j, i) => (isMovable(j) ? i : -1)).filter((i) => i >= 0);
  const clampAll = (v: readonly number[]) => joints.map((j, i) => clampTo(j, v[i] ?? j.home));
  // El eje X de referencia se toma con el signo más cercano al de la semilla (la pieza es
  // simétrica a media vuelta), así la muñeca no gira 180° sin motivo.
  let xRef: Vec3 | null = target.xAxis ? m4.normalize(target.xAxis) : null;
  if (xRef && m4.dot(xRef, m4.axisX(toolAt(clampAll(seed)).matrix)) < 0) xRef = m4.scale(xRef, -1);
  const errorOf = (v: readonly number[]) => {
    const t = toolAt(v);
    const e = m4.sub(target.position, t.position);
    const pos = m4.norm(e);
    let ang = 0;
    const out = [...e];
    if (target.approach) {
      const d = m4.sub(m4.normalize(target.approach), t.approach);
      ang = angleBetween(target.approach, t.approach);
      out.push(...m4.scale(d, ORI_WEIGHT));
    }
    if (xRef) {
      const x = m4.normalize(m4.axisX(t.matrix));
      ang = Math.max(ang, angleBetween(xRef, x));
      out.push(...m4.scale(m4.sub(xRef, x), ORI_WEIGHT));
    }
    return { out, pos, ang: ang / DEG };
  };
  if (movable.length === 0) {
    const e = errorOf(clampAll(seed));
    return {
      reached: e.pos < IK_TOL_MM && e.ang < IK_TOL_DEG,
      joints: clampAll(seed),
      error_mm: e.pos,
      error_deg: e.ang,
      reason: 'La ficha no publica rangos de eje: el robot no se puede mover.',
    };
  }

  // Semillas deterministas: la actual, el reposo, el centro del rango y algunas intermedias.
  const seeds: number[][] = [clampAll(seed), clampAll(joints.map((j) => j.home))];
  const mid = joints.map((j) => (isMovable(j) ? (j.min! + j.max!) / 2 : j.home));
  seeds.push(mid);
  for (const f of [0.25, 0.75]) {
    seeds.push(joints.map((j) => (isMovable(j) ? j.min! + (j.max! - j.min!) * f : j.home)));
  }
  // Variantes con el eje 1 apuntando al objetivo (ayuda a robots serie).
  const yaw = Math.atan2(target.position[1], target.position[0]) / DEG;
  for (const s of [...seeds]) {
    if (joints[0] && isMovable(joints[0])) seeds.push(clampAll([yaw, ...s.slice(1)]));
  }

  let best: { v: number[]; pos: number; ang: number } | null = null;
  for (const s0 of seeds) {
    let v = [...s0];
    let lambda = 10;
    let e = errorOf(v);
    for (let it = 0; it < 150; it++) {
      if (e.pos < IK_TOL_MM * 0.2 && e.ang < IK_TOL_DEG * 0.2) break;
      // Jacobiana por diferencias finitas sobre los ejes que se pueden mover.
      const h = 1e-3;
      const cols = movable.map((i) => {
        const w = [...v];
        w[i] = w[i]! + h;
        const ew = errorOf(w).out;
        return e.out.map((x, k) => (x - ew[k]!) / h); // d(tool)/dq
      });
      const m = e.out.length;
      const jjt = Array.from({ length: m }, (_, r) =>
        Array.from({ length: m }, (_, c) =>
          cols.reduce((s, col) => s + col[r]! * col[c]!, r === c ? lambda * lambda : 0),
        ),
      );
      const y = solveLinear(jjt, e.out);
      if (!y) break;
      const next = [...v];
      let stepMax = 0;
      movable.forEach((i, k) => {
        const dq = cols[k]!.reduce((s, x, r) => s + x * y[r]!, 0);
        stepMax = Math.max(stepMax, Math.abs(dq));
        next[i] = next[i]! + dq;
      });
      const limit = 15; // ° o mm por iteración
      if (stepMax > limit)
        movable.forEach((i) => (next[i] = v[i]! + ((next[i]! - v[i]!) * limit) / stepMax));
      const clamped = clampAll(next);
      const ne = errorOf(clamped);
      const cost = (x: typeof e) => x.out.reduce((s, k) => s + k * k, 0);
      if (cost(ne) < cost(e)) {
        v = clamped;
        e = ne;
        lambda = Math.max(0.5, lambda * 0.6);
      } else {
        lambda *= 3;
        if (lambda > 1e5) break;
      }
    }
    if (!best || e.pos + e.ang * 5 < best.pos + best.ang * 5) best = { v, pos: e.pos, ang: e.ang };
    if (e.pos < IK_TOL_MM && e.ang < IK_TOL_DEG) break;
  }
  const reached = best!.pos < IK_TOL_MM && best!.ang < IK_TOL_DEG;
  return {
    reached,
    joints: best!.v,
    error_mm: best!.pos,
    error_deg: best!.ang,
    reason: reached ? null : 'El punto queda fuera del alcance con los rangos de eje de la ficha.',
  };
}

// ---------------------------------------------------------------------------
// Robots simplificados por familia
// ---------------------------------------------------------------------------

const fixedJoint = (name: string, parent: string, xyz: Vec3, rpy: Vec3 = [0, 0, 0]): LinkSpec => ({
  name,
  parent,
  origin: { xyz, rpy },
  drive: { type: 'fixed' },
});
const axisLink = (
  name: string,
  parent: string | null,
  xyz: Vec3,
  axis: Vec3,
  joint: number,
  type: 'revolute' | 'prismatic' = 'revolute',
): LinkSpec => ({ name, parent, origin: { xyz, rpy: [0, 0, 0] }, drive: { type, axis, joint } });

const BASE: LinkSpec = {
  name: 'base',
  parent: null,
  origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
  drive: { type: 'fixed' },
};
const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];
const DOWN: Vec3 = [0, 0, -1];

/** Grosor de los eslabones dibujados (supuesto visual). */
export const linkThickness = (model: RobotModel) =>
  Math.max(20, (model.dims.reach ?? 1000) * 0.045);

/**
 * RobotVisual con la geometría simplificada de `buildRobotModel`. Los orígenes reproducen el
 * dibujo del lienzo, así que la pose estática y la animación coinciden.
 */
export function simplifiedVisual(model: RobotModel): RobotVisual {
  const d = model.dims;
  const link = linkThickness(model);
  const notes = [...model.notes];
  switch (model.kind) {
    case 'serial6':
      return serialChainVisual({
        kind: model.kind,
        joints: model.joints,
        links: [
          BASE,
          axisLink('eje1', 'base', [0, 0, 0], Z, 0),
          axisLink('eje2', 'eje1', [0, 0, d.shoulder!], Y, 1),
          axisLink('eje3', 'eje2', [0, 0, d.upper!], Y, 2),
          axisLink('eje4', 'eje3', [d.fore!, 0, 0], X, 3),
          axisLink('eje5', 'eje4', [0, 0, 0], Y, 4),
          axisLink('eje6', 'eje5', [d.wrist!, 0, 0], X, 5),
          // La brida mira hacia +X del eje 6; la herramienta cuelga hacia -Z de la brida.
          fixedJoint('brida', 'eje6', [link * 0.6, 0, 0], [0, -Math.PI / 2, 0]),
        ],
        tool: { link: 'brida', offset: [0, 0, -TOOL_LENGTH_MM], approach: DOWN },
        notes,
      });
    case 'palletizer4':
      return serialChainVisual({
        kind: model.kind,
        joints: model.joints,
        links: [
          BASE,
          axisLink('eje1', 'base', [0, 0, 0], Z, 0),
          axisLink('eje2', 'eje1', [0, 0, d.shoulder!], Y, 1),
          axisLink('eje3', 'eje2', [0, 0, d.upper!], Y, 2),
          {
            name: 'muñeca',
            parent: 'eje3',
            origin: { xyz: [d.fore!, 0, 0], rpy: [0, 0, 0] },
            drive: {
              type: 'mimic',
              axis: Y,
              terms: [
                [1, -1],
                [2, -1],
              ],
            },
          },
          axisLink('eje4', 'muñeca', [0, 0, -link * 2.5], Z, 3),
          fixedJoint('brida', 'eje4', [0, 0, -link * 0.4]),
        ],
        tool: { link: 'brida', offset: [0, 0, -TOOL_LENGTH_MM], approach: DOWN },
        notes,
      });
    case 'scara': {
      const rod = Math.max(d.stroke ?? 0, link * 2) + link * 2.6;
      return serialChainVisual({
        kind: model.kind,
        joints: model.joints,
        links: [
          BASE,
          axisLink('eje1', 'base', [0, 0, -d.drop!], Z, 0),
          axisLink('eje2', 'eje1', [d.arm1!, 0, 0], Z, 1),
          axisLink('eje3', 'eje2', [d.arm2!, 0, 0], Z, 2, 'prismatic'),
          axisLink('eje4', 'eje3', [0, 0, 0], Z, 3),
          fixedJoint('brida', 'eje4', [0, 0, -rod]),
        ],
        tool: { link: 'brida', offset: [0, 0, -TOOL_LENGTH_MM], approach: DOWN },
        notes,
      });
    }
    case 'delta':
      return deltaVisual(model);
    case 'block':
      return serialChainVisual({
        kind: model.kind,
        joints: [],
        links: [BASE],
        tool: { link: 'base', offset: [0, 0, model.base.height], approach: DOWN },
        notes,
      });
  }
}

// ---------------------------------------------------------------------------
// Delta (cadena cerrada): cinemática inversa y directa analíticas
// ---------------------------------------------------------------------------

/** Proporciones supuestas del delta (fracción del radio de trabajo R publicado). */
export const DELTA = { upper: 0.8, lower: 1.2, stroke: 0.3, minDeg: -60, maxDeg: 95 } as const;

function deltaVisual(model: RobotModel): RobotVisual {
  const R = model.dims.reach!;
  const published = model.reach_mm;
  const br = model.dims.base_r!;
  const pr = model.dims.platform_r!;
  const drop = model.dims.drop!;
  const rf = DELTA.upper * R;
  const re = DELTA.lower * R;
  const link = linkThickness(model);
  const flange = link * 0.6;
  const zTop = -drop;
  const zBottom = -drop - DELTA.stroke * R;
  const arms = [0, 120, 240].map((a) => a * DEG);
  const notes = [
    ...model.notes.filter((n) => !n.startsWith('Rangos de eje no publicados')),
    `Delta: la ficha no publica rangos de eje ni la altura del volumen de trabajo. Se supone una carrera vertical de ${Math.round(DELTA.stroke * R)} mm bajo la posición de reposo y brazos de ${DELTA.minDeg}° a ${DELTA.maxDeg}°.`,
  ];
  const joints: JointDef[] = [1, 2, 3].map((axis) => ({
    axis,
    type: 'revolute',
    min: DELTA.minDeg,
    max: DELTA.maxDeg,
    unit: 'deg',
    home: 0,
    max_speed: null,
  }));

  /** Ángulo (°) del brazo `i` para que la plataforma (centro de muñecas) quede en `p`. */
  function armAngle(i: number, p: Vec3): number | null {
    const phi = arms[i]!;
    const x = p[0] * Math.cos(phi) + p[1] * Math.sin(phi);
    const y = -p[0] * Math.sin(phi) + p[1] * Math.cos(phi);
    const z = p[2];
    const a = x + pr - br;
    const A = -2 * a * rf;
    const B = 2 * z * rf;
    const K = re * re - a * a - y * y - z * z - rf * rf;
    const r = Math.hypot(A, B);
    if (r < 1e-9 || Math.abs(K / r) > 1) return null;
    const base = Math.atan2(B, A);
    const off = Math.acos(K / r);
    // Codo hacia afuera: de las dos soluciones, la de coseno mayor.
    const cands = [base + off, base - off].map((t) => Math.atan2(Math.sin(t), Math.cos(t)));
    const t = cands.sort((u, v) => Math.cos(v) - Math.cos(u))[0]!;
    return t / DEG;
  }

  const elbow = (i: number, deg: number): Vec3 => {
    const phi = arms[i]!;
    const t = deg * DEG;
    const r = br + rf * Math.cos(t);
    return [r * Math.cos(phi), r * Math.sin(phi), -rf * Math.sin(t)];
  };
  const shoulder = (i: number): Vec3 => [br * Math.cos(arms[i]!), br * Math.sin(arms[i]!), 0];
  const wristOffset = (i: number): Vec3 => [pr * Math.cos(arms[i]!), pr * Math.sin(arms[i]!), 0];

  /** Cinemática directa: intersección de las tres esferas (la solución de abajo). */
  function platformFor(q: readonly number[]): Vec3 | null {
    const c = [0, 1, 2].map((i) => m4.sub(elbow(i, q[i]!), wristOffset(i)));
    const [p1, p2, p3] = c as [Vec3, Vec3, Vec3];
    const ex = m4.normalize(m4.sub(p2, p1));
    const i = m4.dot(ex, m4.sub(p3, p1));
    const ey = m4.normalize(m4.sub(m4.sub(p3, p1), m4.scale(ex, i)));
    const ez = m4.cross(ex, ey);
    const dd = m4.norm(m4.sub(p2, p1));
    const j = m4.dot(ey, m4.sub(p3, p1));
    const x = dd / 2;
    const y = (i * i + j * j) / (2 * j) - (i / j) * x;
    const z2 = re * re - x * x - y * y;
    if (z2 < 0) return null;
    const base = m4.add(p1, m4.add(m4.scale(ex, x), m4.scale(ey, y)));
    const a = m4.add(base, m4.scale(ez, Math.sqrt(z2)));
    const b = m4.sub(base, m4.scale(ez, Math.sqrt(z2)));
    return a[2] < b[2] ? a : b;
  }

  const homeP: Vec3 = [0, 0, zTop];
  const homeQ = [0, 1, 2].map((i) => armAngle(i, homeP) ?? 0);
  joints.forEach((j, i) => (j.home = Math.round(homeQ[i]! * 1000) / 1000));
  let q = [...homeQ];
  let platform: Vec3 = platformFor(q) ?? homeP;

  const toolOf = (p: Vec3): ToolPose => {
    const matrix = m4.translation([p[0], p[1], p[2] - flange - TOOL_LENGTH_MM]);
    return { position: m4.origin(matrix), approach: DOWN, matrix };
  };

  const links: LinkSpec[] = [
    BASE,
    ...[0, 1, 2].map((i): LinkSpec => ({
      name: `brazo${i + 1}`,
      parent: 'base',
      origin: { xyz: shoulder(i), rpy: [0, 0, arms[i]!] },
      drive: { type: 'revolute', axis: [0, -1, 0], joint: i },
    })),
    ...[0, 1, 2].map((i): LinkSpec => ({
      name: `antebrazo${i + 1}`,
      parent: `brazo${i + 1}`,
      origin: { xyz: [rf, 0, 0], rpy: [0, 0, 0] },
      drive: { type: 'fixed' }, // pasivo: su pose sale de la cadena cerrada
    })),
    {
      name: 'plataforma',
      parent: null,
      origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
      drive: { type: 'fixed' },
    },
    fixedJoint('brida', 'plataforma', [0, 0, -flange]),
  ];

  return {
    kind: 'delta',
    joints,
    links,
    notes,
    setJointValues(values) {
      const next = joints.map((j, i) => clampTo(j, values[i] ?? j.home));
      const p = platformFor(next);
      if (p) {
        q = next;
        platform = p;
      }
    },
    jointValues: () => [...q],
    linkPoses() {
      const out: LinkPose[] = [{ name: 'base', matrix: m4.identity() }];
      for (let i = 0; i < 3; i++)
        out.push({ name: `brazo${i + 1}`, matrix: m4.lookAlong(shoulder(i), elbow(i, q[i]!)) });
      for (let i = 0; i < 3; i++)
        out.push({
          name: `antebrazo${i + 1}`,
          matrix: m4.lookAlong(elbow(i, q[i]!), m4.add(platform, wristOffset(i))),
        });
      out.push({ name: 'plataforma', matrix: m4.translation(platform) });
      out.push({
        name: 'brida',
        matrix: m4.translation([platform[0], platform[1], platform[2] - flange]),
      });
      return out;
    },
    toolPose: () => toolOf(platform),
    solve(target) {
      const p: Vec3 = [
        target.position[0],
        target.position[1],
        target.position[2] + flange + TOOL_LENGTH_MM,
      ];
      const fail = (reason: string): IkResult => ({
        reached: false,
        joints: [...q],
        error_mm: m4.norm(m4.sub(target.position, toolOf(platform).position)),
        error_deg: 0,
        reason,
      });
      if (published != null && Math.hypot(p[0], p[1]) > published + 1e-6)
        return fail('El punto queda fuera del diámetro de trabajo publicado.');
      if (p[2] > zTop + 1e-6 || p[2] < zBottom - 1e-6)
        return fail('El punto queda fuera de la carrera vertical supuesta del delta.');
      const sol = [0, 1, 2].map((i) => armAngle(i, p));
      if (sol.some((x) => x == null)) return fail('Los brazos no llegan a ese punto.');
      const qs = sol as number[];
      if (qs.some((x, i) => x < joints[i]!.min! - 1e-6 || x > joints[i]!.max! + 1e-6))
        return fail('El punto pide un ángulo de brazo fuera del rango supuesto.');
      return { reached: true, joints: qs, error_mm: 0, error_deg: 0, reason: null };
    },
  };
}
