import {
  dropPoint,
  dropYaw,
  pickPoint,
  pickYaw,
  slotFor,
  unitSize,
  type LineTimeline,
  type RobotHandling,
} from './playback.ts';
import type { JointDef } from './robot-model.ts';
import type { IkResult, RobotVisual } from './robot-visual.ts';
import type { SceneObject } from './scene.ts';
import type { Vec3 } from './validate.ts';

// Plan de movimiento del robot (PLAN 24.2): un tomar y dejar por cada ciclo de la estación,
// con la duración del ciclo de esa unidad en la réplica. Solo usa la interfaz RobotVisual
// (cinemática inversa y valores de eje), así que funciona igual con el CAD.

/** Fracciones del ciclo D (confirmadas en PLAN 24.13). */
export const CYCLE_SPLIT = {
  down: 0.12,
  up: 0.12,
  move: 0.34,
  lower: 0.12,
  /** Soltar, subir y regresar ocupan el 30 % restante. */
  release_up: 0.1,
  back: 0.2,
} as const;

/** Altura de paso sobre los puntos de recogida y entrega (mm, supuesto visual). */
export const CLEARANCE_MM = 150;

/** Puntos intermedios de los tramos verticales (el TCP va en línea recta). */
export const VERTICAL_STEPS = 10;

/**
 * Cambio de configuración entre dos soluciones encadenadas: el eje 1 gira más de 90° o, en
 * robots serie de 6 ejes, el eje 3 o el eje 5 cambia de signo (fuera de una banda de ±5°
 * alrededor de cero, para no rechazar soluciones que pasan cerca del cero).
 */
export const CONFIG_LIMITS = { baseJumpDeg: 90, signDeadbandDeg: 5 } as const;

/** Paso al buscar la solución de un punto lejano siguiendo un camino (° del eje 1 y mm). */
const WALK_STEP_DEG = 5;
const WALK_STEP_MM = 50;

export type MotionPhase =
  | 'reposo'
  | 'bajando a recoger'
  | 'subiendo'
  | 'trasladando'
  | 'bajando a entregar'
  | 'esperando destino'
  | 'regresando'
  | 'sin alcance';

export interface MotionSegment {
  t0: number;
  t1: number;
  from: number[];
  to: number[];
  /**
   * Puntos intermedios en ejes, de `from` a `to` inclusive (tramos verticales: el TCP en
   * línea recta). Sin ellos se interpola directo en el espacio de ejes.
   */
  path?: number[][];
  phase: MotionPhase;
  /** Unidad que lleva la herramienta durante el tramo (null = vacía). */
  carrying: number | null;
  /** Unidad del ciclo al que pertenece el tramo. */
  unit?: number;
}

/** Tramo más corto de lo que permiten las velocidades de la ficha (no se acelera). */
export interface SegmentOverspeed {
  unit: number;
  phase: MotionPhase;
  t0: number;
  duration_s: number;
  /** Duración mínima con las velocidades publicadas. */
  min_s: number;
  /** Eje que más limita (número de la ficha) y su porcentaje de la velocidad publicada. */
  axis: number;
  percent: number;
}

export interface GripEvent {
  t: number;
  command: 'close' | 'open';
  unit: number;
}

export interface CycleInfo {
  unit: number;
  t0: number;
  tGrip: number;
  tRelease: number;
  tEnd: number;
  pick: Vec3;
  drop: Vec3;
  /** Giro de la unidad en la recogida y en la entrega (rad, mundo). */
  pickYaw: number;
  dropYaw: number;
  /** Altura de la unidad: cuelga de la herramienta por debajo del TCP. */
  unitHeight: number;
}

export interface MotionPlan {
  robotId: string;
  robot: SceneObject;
  visual: RobotVisual;
  /** Pose de reposo (sobre el punto de recogida). */
  rest: number[];
  segments: MotionSegment[];
  grips: GripEvent[];
  cycles: CycleInfo[];
  /** Ciclos sin animación (punto fuera de alcance, cambio de configuración o simultáneos). */
  skipped: number[];
  /** Tramos más rápidos que la ficha. */
  overspeed: SegmentOverspeed[];
  warnings: string[];
}

export interface RobotPose {
  /** Valores ejecutados (interpolados) en la unidad de la ficha. */
  joints: number[];
  /** Valores comandados: el objetivo del tramo actual. */
  commanded: number[];
  /** Velocidad de cada eje (°/s o mm/s). */
  velocity: number[];
  phase: MotionPhase;
  gripper: 'open' | 'closed';
  carrying: number | null;
}

/** Base del robot en el mundo: posición, giro y elevación del objeto. */
function toBase(robot: SceneObject, p: Vec3): Vec3 {
  const yaw = (robot.rotation_deg * Math.PI) / 180;
  const dx = p[0] - robot.position[0];
  const dy = p[1] - robot.position[1];
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  return [c * dx - s * dy, s * dx + c * dy, p[2] - robot.elevation];
}

export function toWorld(robot: SceneObject, p: Vec3): Vec3 {
  const yaw = (robot.rotation_deg * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [
    robot.position[0] + c * p[0] - s * p[1],
    robot.position[1] + s * p[0] + c * p[1],
    p[2] + robot.elevation,
  ];
}

const DOWN: Vec3 = [0, 0, -1];
const DEG = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Giro (rad) del eje X de una pose 4×4 alrededor de Z. */
const yawOf = (m: readonly number[]) => Math.atan2(m[1]!, m[0]!);

/** Dos soluciones encadenadas tienen la misma configuración (ver CONFIG_LIMITS). */
export function sameConfiguration(
  visual: Pick<RobotVisual, 'kind' | 'joints'>,
  a: readonly number[],
  b: readonly number[],
): boolean {
  if (
    visual.joints[0]?.type === 'revolute' &&
    Math.abs((a[0] ?? 0) - (b[0] ?? 0)) > CONFIG_LIMITS.baseJumpDeg
  )
    return false;
  if (visual.kind === 'serial6') {
    const dead = CONFIG_LIMITS.signDeadbandDeg;
    for (const k of [2, 4]) {
      const x = a[k] ?? 0;
      const y = b[k] ?? 0;
      if (Math.abs(x) > dead && Math.abs(y) > dead && Math.sign(x) !== Math.sign(y)) return false;
    }
  }
  return true;
}

/** Velocidad pico de cada eje en el tramo con el perfil suavizado (1.5 × cambio ÷ duración). */
export function segmentPeakSpeed(seg: MotionSegment): number[] {
  const pts = seg.path ?? [seg.from, seg.to];
  const n = pts.length - 1;
  const span = seg.t1 - seg.t0;
  return seg.from.map((_, k) => {
    let step = 0;
    for (let i = 0; i < n; i++) step = Math.max(step, Math.abs(pts[i + 1]![k]! - pts[i]![k]!));
    return span > 0 ? (1.5 * n * step) / span : 0;
  });
}

/** Duración mínima del tramo con las velocidades publicadas y el eje que la fija. */
export function segmentMinDuration(
  seg: MotionSegment,
  joints: readonly JointDef[],
): { min_s: number; axis: number | null; percent: number } {
  const span = seg.t1 - seg.t0;
  const peak = segmentPeakSpeed(seg);
  let worst = { min_s: 0, axis: null as number | null, percent: 0 };
  joints.forEach((j, k) => {
    if (j.max_speed == null || j.max_speed <= 0) return;
    const pct = (peak[k]! / j.max_speed) * 100;
    if (pct > worst.percent) worst = { min_s: (span * pct) / 100, axis: j.axis, percent: pct };
  });
  return worst;
}

type Reach =
  | { ok: true; path: number[][] }
  | { ok: false; reason: 'reach' | 'config'; detail: IkResult | null };

export function buildMotionPlan(
  tl: LineTimeline,
  robotId: string,
  visual: RobotVisual,
): MotionPlan {
  const robot = tl.objects.get(robotId)!;
  const visits = tl.visitsByNode.get(robotId) ?? [];
  const restSeed = visual.jointValues();
  const robotYaw = robot.rotation_deg * DEG;
  // Caché de la cinemática inversa: el punto, el eje X pedido y la semilla. Los ciclos que
  // repiten recogida y entrega desde la misma pose la reutilizan.
  const cache = new Map<string, IkResult>();
  const solve = (local: Vec3, xAxis: Vec3 | null, seed: readonly number[]) => {
    const key = [
      ...local.map((x) => Math.round(x * 10)),
      ...(xAxis ?? []).map((x) => Math.round(x * 1000)),
      '|',
      ...seed.map((x) => Math.round(x * 100)),
    ].join(',');
    let r = cache.get(key);
    if (!r) {
      r = visual.solve({ position: local, approach: DOWN, xAxis }, seed);
      cache.set(key, r);
    }
    return r;
  };
  const toolOf = (q: readonly number[]) => {
    visual.setJointValues(q);
    return visual.toolPose();
  };
  /** Eje X de la herramienta en la base para un giro de la pieza en el mundo. */
  const xFor = (worldYaw: number): Vec3 => [
    Math.cos(worldYaw - robotYaw),
    Math.sin(worldYaw - robotYaw),
    0,
  ];

  /** Encadena soluciones por puntos del TCP; cada una toma la anterior como semilla. */
  const follow = (q0: number[], points: { p: Vec3; x: Vec3 | null }[]): Reach => {
    const path = [q0];
    for (const { p, x } of points) {
      const prev = path[path.length - 1]!;
      const r = solve(p, x, prev);
      if (!r.reached) return { ok: false, reason: 'reach', detail: r };
      if (!sameConfiguration(visual, prev, r.joints))
        return { ok: false, reason: 'config', detail: r };
      path.push(r.joints);
    }
    return { ok: true, path };
  };

  /** Bajada o subida vertical: el TCP en línea recta de a a b. */
  const straight = (q0: number[], a: Vec3, b: Vec3, x: Vec3 | null) =>
    follow(
      q0,
      Array.from({ length: VERTICAL_STEPS }, (_, i) => {
        const f = (i + 1) / VERTICAL_STEPS;
        return {
          p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f],
          x,
        };
      }),
    );

  /**
   * Solución de un punto lejano en la misma configuración que q0: recorre un camino en
   * coordenadas cilíndricas alrededor de la base (y gira el eje X de la herramienta poco a
   * poco). Si el camino no se puede seguir, prueba directo desde q0.
   */
  const travel = (q0: number[], target: Vec3, x: Vec3 | null): Reach => {
    const from = toolOf(q0);
    const a = from.position;
    const a0 = Math.atan2(a[1], a[0]);
    let da = wrap(Math.atan2(target[1], target[0]) - a0);
    // Se gira hacia el lado corto salvo que el eje 1 se salga de su rango: entonces se rodea
    // por el otro lado, como lo haría el robot.
    const j1 = visual.joints[0];
    if (j1?.type === 'revolute' && j1.min != null && j1.max != null) {
      const end = (q0[0] ?? 0) + da / DEG;
      if (end > j1.max) da -= 2 * Math.PI;
      else if (end < j1.min) da += 2 * Math.PI;
    }
    const r0 = Math.hypot(a[0], a[1]);
    const r1 = Math.hypot(target[0], target[1]);
    const x0 = yawOf(from.matrix);
    // La pieza es simétrica a media vuelta: se gira hacia el lado más corto.
    let dx = x ? wrap(Math.atan2(x[1], x[0]) - x0) : 0;
    if (dx > Math.PI / 2) dx -= Math.PI;
    if (dx < -Math.PI / 2) dx += Math.PI;
    const dist = Math.hypot(r1 - r0, target[2] - a[2]);
    const steps = Math.max(
      1,
      Math.ceil(Math.abs(da) / (WALK_STEP_DEG * DEG)),
      Math.ceil(Math.abs(dx) / (WALK_STEP_DEG * DEG)),
      Math.ceil(dist / WALK_STEP_MM),
    );
    const points = Array.from({ length: steps }, (_, i) => {
      const f = (i + 1) / steps;
      if (i === steps - 1) return { p: target, x };
      const ang = a0 + da * f;
      const r = r0 + (r1 - r0) * f;
      const xi = x ? x0 + dx * f : null;
      return {
        p: [r * Math.cos(ang), r * Math.sin(ang), a[2] + (target[2] - a[2]) * f] as Vec3,
        x: xi == null ? null : ([Math.cos(xi), Math.sin(xi), 0] as Vec3),
      };
    });
    const walked = follow(q0, points);
    if (walked.ok) return { ok: true, path: [q0, walked.path[walked.path.length - 1]!] };
    const direct = solve(target, x, q0);
    if (!direct.reached) return { ok: false, reason: 'reach', detail: direct };
    if (!sameConfiguration(visual, q0, direct.joints))
      return { ok: false, reason: 'config', detail: direct };
    return { ok: true, path: [q0, direct.joints] };
  };
  const last = (r: Reach & { ok: true }) => r.path[r.path.length - 1]!;

  const warnings = new Set<string>();
  const segments: MotionSegment[] = [];
  const grips: GripEvent[] = [];
  const cycles: CycleInfo[] = [];
  const skipped: number[] = [];
  let rest: number[] | null = null;
  let current: number[] = restSeed;
  let busyUntil = -Infinity;
  let atAbovePick = true;
  const name = (id: string | null) => (id ? (tl.objects.get(id)?.name ?? id) : '');

  const push = (seg: MotionSegment) => {
    if (seg.t1 > seg.t0 + 1e-9) segments.push(seg);
    current = seg.to;
  };
  const reverse = (path: number[][]) => [...path].reverse();

  visits.forEach((v, i) => {
    const size = unitSize(tl, v.unit);
    const pick = v.prev ? pickPoint(tl, v.prev, size) : null;
    const drop = v.next ? dropPoint(tl, v.next, size, slotFor(tl, v.unit, v.next)) : null;
    if (!pick || !drop) {
      skipped.push(v.unit);
      return;
    }
    if (v.tAt < busyUntil) {
      // Capacidad mayor que 1: se anima un ciclo a la vez.
      skipped.push(v.unit);
      warnings.add(
        `${robot.name}: ciclos simultáneos (capacidad mayor que 1); se anima uno a la vez y las demás unidades esperan en la recogida (en rojo).`,
      );
      return;
    }
    const lift = (p: Vec3, extra: number): Vec3 =>
      toBase(robot, [p[0], p[1], p[2] + size.height_mm + extra]);
    const targets = {
      abovePick: lift(pick, CLEARANCE_MM),
      pick: lift(pick, 0),
      aboveDrop: lift(drop, CLEARANCE_MM),
      drop: lift(drop, 0),
    };
    const yaw = { pick: pickYaw(tl, v.prev!), drop: dropYaw(tl, v.next!) };
    const xPick = xFor(yaw.pick);
    const xDrop = xFor(yaw.drop);

    // Semillas encadenadas: sobre la recogida desde la pose actual, la recogida desde ahí,
    // sobre la entrega desde sobre la recogida y la entrega desde sobre la entrega.
    let abovePick: Reach;
    if (!rest) {
      // Primer ciclo: el robot empieza ya sobre la recogida (no se anima desde la escena).
      const r = solve(targets.abovePick, xPick, restSeed);
      abovePick = r.reached
        ? { ok: true, path: [r.joints] }
        : { ok: false, reason: 'reach', detail: r };
    } else abovePick = travel(current, targets.abovePick, xPick);
    const down = abovePick.ok
      ? straight(last(abovePick), targets.abovePick, targets.pick, xPick)
      : abovePick;
    const aboveDrop = abovePick.ok ? travel(last(abovePick), targets.aboveDrop, xDrop) : null;
    const lower = aboveDrop?.ok
      ? straight(last(aboveDrop), targets.aboveDrop, targets.drop, xDrop)
      : aboveDrop;

    const report = (r: Reach | null, where: 'recogida' | 'entrega', node: string | null) => {
      if (!r || r.ok) return;
      if (r.reason === 'reach')
        warnings.add(
          `${robot.name} no alcanza el punto de ${where} en ${name(node)} con los rangos de la ficha; no se fuerza el movimiento.`,
        );
      else
        warnings.add(
          `${robot.name} tendría que cambiar de configuración (eje 1 más de ${CONFIG_LIMITS.baseJumpDeg}° o cambio de signo del eje 3 o del eje 5) para llegar a la ${where} en ${name(node)}; esos ciclos no se animan.`,
        );
    };
    report(abovePick.ok ? down : abovePick, 'recogida', v.prev);
    report(lower, 'entrega', v.next);
    if (!down.ok || !lower?.ok) {
      skipped.push(v.unit);
      return;
    }
    const downPath = down.path;
    const lowerPath = lower.path;
    const sol = {
      abovePick: downPath[0]!,
      pick: downPath[downPath.length - 1]!,
      aboveDrop: lowerPath[0]!,
      drop: lowerPath[lowerPath.length - 1]!,
    };
    if (!rest) {
      rest = sol.abovePick;
      current = rest;
    }

    const t0 = v.tAt;
    const tD = v.tDone ?? (v.tLeave != null ? v.tLeave : t0 + 1);
    const D = Math.max(1e-3, tD - t0);
    const s = CYCLE_SPLIT;
    const unit = v.unit;
    // Si el ciclo anterior no alcanzó a regresar (estaba bloqueado y este empezó al soltar),
    // este ciclo empieza regresando: usa la parte del regreso (20 %) al inicio y suelta al 90 %.
    let tStart = t0;
    if (!atAbovePick) {
      tStart = t0 + s.back * D;
      push({
        t0,
        t1: tStart,
        from: current,
        to: sol.abovePick,
        phase: 'regresando',
        carrying: null,
        unit,
      });
    }
    const tGrip = tStart + s.down * D;
    const tUp = tGrip + s.up * D;
    const tMoved = tUp + s.move * D;
    const tLowered = tMoved + s.lower * D;
    // Bloqueado: el destino acepta después de terminar el ciclo (o nunca, en la ventana).
    const blocked = v.tDone != null && (v.tLeave == null || v.tLeave > v.tDone + 1e-6);
    const tRelease = blocked ? Math.max(tLowered, v.tLeave ?? tLowered) : tLowered;
    const nextStart = visits[i + 1]?.tAt ?? Infinity;

    push({
      t0: tStart,
      t1: tGrip,
      from: sol.abovePick,
      to: sol.pick,
      path: downPath,
      phase: 'bajando a recoger',
      carrying: null,
      unit,
    });
    grips.push({ t: tGrip, command: 'close', unit });
    push({
      t0: tGrip,
      t1: tUp,
      from: sol.pick,
      to: sol.abovePick,
      path: reverse(downPath),
      phase: 'subiendo',
      carrying: unit,
      unit,
    });
    push({
      t0: tUp,
      t1: tMoved,
      from: sol.abovePick,
      to: sol.aboveDrop,
      phase: 'trasladando',
      carrying: unit,
      unit,
    });
    push({
      t0: tMoved,
      t1: tLowered,
      from: sol.aboveDrop,
      to: sol.drop,
      path: lowerPath,
      phase: 'bajando a entregar',
      carrying: unit,
      unit,
    });
    if (tRelease > tLowered)
      push({
        t0: tLowered,
        t1: tRelease,
        from: current,
        to: current,
        phase: 'esperando destino',
        carrying: unit,
        unit,
      });
    // Tras soltar: subir (10 %) y regresar (20 %) solo si cabe completo antes del siguiente
    // ciclo; si no, el siguiente ciclo empieza regresando. Nunca se comprime un movimiento.
    let tEnd = tRelease;
    atAbovePick = false;
    if (Number.isFinite(tRelease)) {
      grips.push({ t: tRelease, command: 'open', unit });
      const tRise = tRelease + s.release_up * D;
      if (tRise <= nextStart + 1e-9) {
        push({
          t0: tRelease,
          t1: tRise,
          from: sol.drop,
          to: sol.aboveDrop,
          path: reverse(lowerPath),
          phase: 'subiendo',
          carrying: null,
          unit,
        });
        tEnd = tRise;
        const tBack = tRise + s.back * D;
        if (tBack <= nextStart + 1e-9) {
          push({
            t0: tRise,
            t1: tBack,
            from: current,
            to: sol.abovePick,
            phase: 'regresando',
            carrying: null,
            unit,
          });
          tEnd = tBack;
          atAbovePick = true;
        }
      }
    }
    cycles.push({
      unit,
      t0,
      tGrip,
      tRelease,
      tEnd,
      pick,
      drop,
      pickYaw: yaw.pick,
      dropYaw: yaw.drop,
      unitHeight: size.height_mm,
    });
    busyUntil = Number.isFinite(tRelease) ? tRelease : Infinity;
  });
  visual.setJointValues(restSeed);

  // Velocidades de la ficha: un tramo más corto de lo posible no se acelera, se avisa.
  const overspeed: SegmentOverspeed[] = [];
  for (const seg of segments) {
    if (seg.unit == null || seg.phase === 'esperando destino') continue;
    const m = segmentMinDuration(seg, visual.joints);
    if (m.axis == null || m.percent <= 100 + 1e-6) continue;
    overspeed.push({
      unit: seg.unit,
      phase: seg.phase,
      t0: seg.t0,
      duration_s: seg.t1 - seg.t0,
      min_s: m.min_s,
      axis: m.axis,
      percent: m.percent,
    });
  }
  if (overspeed.length) {
    const o = overspeed[0]!;
    const more = overspeed.length - 1;
    warnings.add(
      `${robot.name}: el tramo "${o.phase}" del ciclo de la unidad ${o.unit} dura ${o.duration_s.toFixed(2)} s y con las velocidades de la ficha necesita al menos ${o.min_s.toFixed(2)} s (eje ${o.axis} al ${Math.round(o.percent)} %). No se acelera: la animación va más rápido de lo que permite el robot${more ? `; hay ${more} tramo${more > 1 ? 's' : ''} más en la misma situación` : ''}.`,
    );
  }

  return {
    robotId,
    robot,
    visual,
    rest: rest ?? restSeed,
    segments,
    grips,
    cycles,
    skipped,
    overspeed,
    warnings: [...warnings],
  };
}

const smooth = (u: number) => u * u * (3 - 2 * u);
const smoothRate = (u: number) => 6 * u * (1 - u);

/** Último tramo que empieza en o antes de t (búsqueda binaria). */
function segmentIndex(plan: MotionPlan, t: number): number {
  let lo = 0;
  let hi = plan.segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (plan.segments[mid]!.t0 <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Pose del robot en el instante t según el plan. */
export function poseAt(plan: MotionPlan, t: number): RobotPose {
  const i = segmentIndex(plan, t);
  const zero = plan.rest.map(() => 0);
  if (i < 0)
    return {
      joints: plan.rest,
      commanded: plan.rest,
      velocity: zero,
      phase: plan.segments.length || !plan.skipped.length ? 'reposo' : 'sin alcance',
      gripper: 'open',
      carrying: null,
    };
  const seg = plan.segments[i]!;
  if (t >= seg.t1) {
    // Entre ciclos: quieto en la última pose.
    return {
      joints: seg.to,
      commanded: seg.to,
      velocity: zero,
      phase: seg.phase === 'esperando destino' || seg.carrying != null ? seg.phase : 'reposo',
      gripper: seg.carrying != null ? 'closed' : 'open',
      carrying: seg.carrying,
    };
  }
  const span = seg.t1 - seg.t0;
  const u = Math.min(1, Math.max(0, (t - seg.t0) / span));
  // El suavizado se aplica al recorrido completo; con puntos intermedios, el avance se
  // reparte entre ellos (el TCP sigue la línea recta con el mismo perfil).
  const pts = seg.path ?? [seg.from, seg.to];
  const n = pts.length - 1;
  const f = smooth(u) * n;
  const k0 = Math.min(n - 1, Math.floor(f));
  const w = f - k0;
  const a = pts[k0]!;
  const b = pts[k0 + 1]!;
  const rate = (smoothRate(u) * n) / span;
  return {
    joints: a.map((x, k) => x + (b[k]! - x) * w),
    commanded: seg.to,
    velocity: a.map((x, k) => (b[k]! - x) * rate),
    phase: seg.phase,
    gripper: seg.carrying != null ? 'closed' : 'open',
    carrying: seg.carrying,
  };
}

/** Posición del TCP en el mundo para la pose del plan en el instante t. */
export function toolAt(plan: MotionPlan, t: number): { position: Vec3; matrix: number[] } {
  plan.visual.setJointValues(poseAt(plan, t).joints);
  const tool = plan.visual.toolPose();
  return { position: toWorld(plan.robot, tool.position), matrix: tool.matrix };
}

/**
 * Qué hace cada robot con cada unidad (para `placeUnits`): antes de tomarla está en la
 * recogida, luego cuelga de la herramienta y después de soltarla queda en la entrega. En la
 * herramienta, la unidad gira con el TCP desde el giro que tenía al tomarla.
 */
export function robotHandling(plans: Map<string, MotionPlan>): RobotHandling {
  const index = new Map<string, Map<number, CycleInfo>>();
  for (const [id, p] of plans) index.set(id, new Map(p.cycles.map((c) => [c.unit, c])));
  const gripYaw = new Map<CycleInfo, number>();
  return (robotId, unit, t) => {
    const plan = plans.get(robotId);
    const c = index.get(robotId)?.get(unit);
    if (!plan || !c) return null;
    if (t < c.tGrip) return { where: 'pick' };
    if (t >= c.tRelease) return { where: 'drop' };
    let atGrip = gripYaw.get(c);
    if (atGrip == null) gripYaw.set(c, (atGrip = toolYawAt(plan, c.tGrip)));
    const tcp = toolAt(plan, t).position;
    return {
      where: 'tool',
      position: [tcp[0], tcp[1], tcp[2] - c.unitHeight],
      yaw: c.pickYaw + toolYawAt(plan, t) - atGrip,
    };
  };
}

/** Giro (rad, mundo) del eje X de la herramienta en el instante t. */
export function toolYawAt(plan: MotionPlan, t: number): number {
  return (plan.robot.rotation_deg * Math.PI) / 180 + yawOf(toolAt(plan, t).matrix);
}
