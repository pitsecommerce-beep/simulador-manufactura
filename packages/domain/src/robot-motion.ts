import {
  dropPoint,
  pickPoint,
  slotFor,
  unitSize,
  type LineTimeline,
  type RobotHandling,
} from './playback.ts';
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
  phase: MotionPhase;
  /** Unidad que lleva la herramienta durante el tramo (null = vacía). */
  carrying: number | null;
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
  /** Ciclos sin animación (punto fuera de alcance o ciclos simultáneos). */
  skipped: number[];
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

export function buildMotionPlan(
  tl: LineTimeline,
  robotId: string,
  visual: RobotVisual,
): MotionPlan {
  const robot = tl.objects.get(robotId)!;
  const visits = tl.visitsByNode.get(robotId) ?? [];
  const cache = new Map<string, IkResult>();
  const restSeed = visual.jointValues();
  const solve = (p: Vec3) => {
    const local = toBase(robot, p);
    const key = local.map((x) => Math.round(x)).join(',');
    let r = cache.get(key);
    if (!r) {
      r = visual.solve({ position: local, approach: DOWN }, restSeed);
      cache.set(key, r);
    }
    return r;
  };

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
        `${robot.name}: ciclos simultáneos (capacidad mayor que 1); se anima uno a la vez.`,
      );
      return;
    }
    const lift = (p: Vec3, extra: number): Vec3 => [p[0], p[1], p[2] + size.height_mm + extra];
    const targets = {
      abovePick: lift(pick, CLEARANCE_MM),
      pick: lift(pick, 0),
      aboveDrop: lift(drop, CLEARANCE_MM),
      drop: lift(drop, 0),
    };
    const sol = {
      abovePick: solve(targets.abovePick),
      pick: solve(targets.pick),
      aboveDrop: solve(targets.aboveDrop),
      drop: solve(targets.drop),
    };
    if (!sol.pick.reached || !sol.abovePick.reached)
      warnings.add(
        `${robot.name} no alcanza el punto de recogida en ${name(v.prev)} con los rangos de la ficha; no se fuerza el movimiento.`,
      );
    if (!sol.drop.reached || !sol.aboveDrop.reached)
      warnings.add(
        `${robot.name} no alcanza el punto de entrega en ${name(v.next)} con los rangos de la ficha; no se fuerza el movimiento.`,
      );
    if (Object.values(sol).some((r) => !r.reached)) {
      skipped.push(v.unit);
      return;
    }
    if (!rest) {
      rest = sol.abovePick.joints;
      current = rest;
    }

    const t0 = v.tAt;
    const tD = v.tDone ?? (v.tLeave != null ? v.tLeave : t0 + 1);
    const D = Math.max(1e-3, tD - t0);
    const s = CYCLE_SPLIT;
    // Si el ciclo anterior no alcanzó a regresar (estaba bloqueado y este empezó al soltar),
    // este ciclo empieza regresando: usa la parte del regreso (20 %) al inicio y suelta al 90 %.
    let tStart = t0;
    if (!atAbovePick) {
      tStart = t0 + s.back * D;
      push({
        t0,
        t1: tStart,
        from: current,
        to: sol.abovePick.joints,
        phase: 'regresando',
        carrying: null,
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
      from: current,
      to: sol.pick.joints,
      phase: 'bajando a recoger',
      carrying: null,
    });
    grips.push({ t: tGrip, command: 'close', unit: v.unit });
    push({
      t0: tGrip,
      t1: tUp,
      from: current,
      to: sol.abovePick.joints,
      phase: 'subiendo',
      carrying: v.unit,
    });
    push({
      t0: tUp,
      t1: tMoved,
      from: current,
      to: sol.aboveDrop.joints,
      phase: 'trasladando',
      carrying: v.unit,
    });
    push({
      t0: tMoved,
      t1: tLowered,
      from: current,
      to: sol.drop.joints,
      phase: 'bajando a entregar',
      carrying: v.unit,
    });
    if (tRelease > tLowered)
      push({
        t0: tLowered,
        t1: tRelease,
        from: current,
        to: current,
        phase: 'esperando destino',
        carrying: v.unit,
      });
    // Tras soltar: subir (10 %) y regresar (20 %) solo si cabe completo antes del siguiente
    // ciclo; si no, el siguiente ciclo empieza regresando. Nunca se comprime un movimiento.
    let tEnd = tRelease;
    atAbovePick = false;
    if (Number.isFinite(tRelease)) {
      grips.push({ t: tRelease, command: 'open', unit: v.unit });
      const tRise = tRelease + s.release_up * D;
      if (tRise <= nextStart + 1e-9) {
        push({
          t0: tRelease,
          t1: tRise,
          from: current,
          to: sol.aboveDrop.joints,
          phase: 'subiendo',
          carrying: null,
        });
        tEnd = tRise;
        const tBack = tRise + s.back * D;
        if (tBack <= nextStart + 1e-9) {
          push({
            t0: tRise,
            t1: tBack,
            from: current,
            to: sol.abovePick.joints,
            phase: 'regresando',
            carrying: null,
          });
          tEnd = tBack;
          atAbovePick = true;
        }
      }
    }
    cycles.push({
      unit: v.unit,
      t0,
      tGrip,
      tRelease,
      tEnd,
      pick,
      drop,
      unitHeight: size.height_mm,
    });
    busyUntil = Number.isFinite(tRelease) ? tRelease : Infinity;
  });

  return {
    robotId,
    robot,
    visual,
    rest: rest ?? restSeed,
    segments,
    grips,
    cycles,
    skipped,
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
  const f = smooth(u);
  const rate = smoothRate(u) / span;
  return {
    joints: seg.from.map((a, k) => a + (seg.to[k]! - a) * f),
    commanded: seg.to,
    velocity: seg.from.map((a, k) => (seg.to[k]! - a) * rate),
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
 * recogida, luego cuelga de la herramienta y después de soltarla queda en la entrega.
 */
export function robotHandling(plans: Map<string, MotionPlan>): RobotHandling {
  const index = new Map<string, Map<number, CycleInfo>>();
  for (const [id, p] of plans) index.set(id, new Map(p.cycles.map((c) => [c.unit, c])));
  return (robotId, unit, t) => {
    const plan = plans.get(robotId);
    const c = index.get(robotId)?.get(unit);
    if (!plan || !c) return null;
    if (t < c.tGrip) return { where: 'pick' };
    if (t >= c.tRelease) return { where: 'drop' };
    const tcp = toolAt(plan, t).position;
    return { where: 'tool', position: [tcp[0], tcp[1], tcp[2] - c.unitHeight] };
  };
}
