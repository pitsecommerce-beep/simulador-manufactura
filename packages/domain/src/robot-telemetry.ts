import * as m4 from './mat4.ts';
import { poseAt, toolAt, type MotionPhase, type MotionPlan } from './robot-motion.ts';
import type { JointDef } from './robot-model.ts';
import type { Vec3 } from './validate.ts';

// Telemetría del robot (PLAN 24.11): señales y eventos de la animación representativa en la
// línea de tiempo de la reproducción. No es el controlador real del robot.

export const TELEMETRY_HZ = 20;
/** Un eje está "en tope" a menos de este porcentaje del extremo de su rango. */
export const LIMIT_MARGIN = 0.01;

export type GripperKind = 'vacuum' | 'mechanical';
export type AxisState = 'moving' | 'stopped' | 'limit';

export type TelemetryEvent =
  | { t: number; kind: 'grip'; command: 'close' | 'open'; unit: number; label: string }
  | { t: number; kind: 'phase'; phase: MotionPhase; label: string }
  | { t: number; kind: 'axis_limit'; axis: number; label: string }
  | { t: number; kind: 'overspeed'; axis: number; percent: number; label: string };

export interface RobotTelemetry {
  robotId: string;
  joints: JointDef[];
  /** Instantes de muestreo (s de simulación). */
  t: number[];
  /** Por eje: valores ejecutados, comandados y velocidad. */
  position: number[][];
  commanded: number[][];
  velocity: number[][];
  tcp: Vec3[];
  /** Velocidad lineal del TCP (m/s). */
  tcpSpeed: number[];
  phase: MotionPhase[];
  gripper: ('open' | 'closed')[];
  holding: boolean[];
  events: TelemetryEvent[];
  counters: {
    cycles: number;
    picks: number;
    places: number;
    tcp_distance_m: number;
    /** Recorrido acumulado de cada eje (° o mm). */
    axis_travel: number[];
  };
  /** Pico de velocidad por eje como porcentaje de la velocidad publicada (null = sin dato). */
  peakSpeedPercent: (number | null)[];
  warnings: string[];
}

export const gripperKind = (componentType: string | null | undefined): GripperKind =>
  /vac|suction|ventosa|vgc|vgp|schmalz|fqe|spb/i.test(componentType ?? '')
    ? 'vacuum'
    : 'mechanical';

export const gripLabel = (kind: GripperKind, command: 'close' | 'open') =>
  kind === 'vacuum'
    ? command === 'close'
      ? 'Vacío activado'
      : 'Vacío liberado'
    : command === 'close'
      ? 'Cerrar garra'
      : 'Abrir garra';

export function axisState(j: JointDef, value: number, velocity: number): AxisState {
  if (j.min != null && j.max != null) {
    const margin = (j.max - j.min) * LIMIT_MARGIN;
    if (value <= j.min + margin || value >= j.max - margin) return 'limit';
  }
  return Math.abs(velocity) > 1e-6 ? 'moving' : 'stopped';
}

export function sampleTelemetry(
  plan: MotionPlan,
  opts: {
    start: number;
    end: number;
    hz?: number;
    gripper?: GripperKind;
    /** Velocidad máxima del TCP publicada (m/s), si la ficha la trae. */
    maxTcpSpeed?: number | null;
    name?: string;
  },
): RobotTelemetry {
  const hz = opts.hz ?? TELEMETRY_HZ;
  const dt = 1 / hz;
  const joints = [...plan.visual.joints];
  const n = Math.max(1, Math.floor((opts.end - opts.start) * hz) + 1);
  const name = opts.name ?? plan.robot.name;
  const kind = opts.gripper ?? 'mechanical';
  const out: RobotTelemetry = {
    robotId: plan.robotId,
    joints,
    t: [],
    position: joints.map(() => []),
    commanded: joints.map(() => []),
    velocity: joints.map(() => []),
    tcp: [],
    tcpSpeed: [],
    phase: [],
    gripper: [],
    holding: [],
    events: [],
    counters: {
      cycles: 0,
      picks: 0,
      places: 0,
      tcp_distance_m: 0,
      axis_travel: joints.map(() => 0),
    },
    peakSpeedPercent: joints.map(() => null),
    warnings: [],
  };

  let prevTcp: Vec3 | null = null;
  let prevPhase: MotionPhase | null = null;
  const atLimit = joints.map(() => false);
  for (let i = 0; i < n; i++) {
    const t = Math.min(opts.end, opts.start + i * dt);
    const pose = poseAt(plan, t);
    const tcp = toolAt(plan, t).position;
    out.t.push(t);
    pose.joints.forEach((v, k) => {
      out.position[k]!.push(v);
      out.commanded[k]!.push(pose.commanded[k]!);
      out.velocity[k]!.push(pose.velocity[k]!);
      const prev = out.position[k]![i - 1];
      if (prev != null) out.counters.axis_travel[k]! += Math.abs(v - prev);
      const lim = axisState(joints[k]!, v, pose.velocity[k]!) === 'limit';
      if (lim && !atLimit[k])
        out.events.push({
          t,
          kind: 'axis_limit',
          axis: joints[k]!.axis,
          label: `Eje ${joints[k]!.axis} en tope de su rango`,
        });
      atLimit[k] = lim;
    });
    const step = prevTcp ? m4.norm(m4.sub(tcp, prevTcp)) : 0;
    out.counters.tcp_distance_m += step / 1000;
    out.tcp.push(tcp);
    out.tcpSpeed.push(prevTcp ? step / 1000 / dt : 0);
    prevTcp = tcp;
    out.phase.push(pose.phase);
    out.gripper.push(pose.gripper);
    out.holding.push(pose.carrying != null);
    if (pose.phase !== prevPhase) {
      out.events.push({ t, kind: 'phase', phase: pose.phase, label: `Fase: ${pose.phase}` });
      prevPhase = pose.phase;
    }
  }

  // Comandos de la garra en su instante exacto.
  for (const g of plan.grips) {
    if (g.t < opts.start || g.t > opts.end) continue;
    out.events.push({
      t: g.t,
      kind: 'grip',
      command: g.command,
      unit: g.unit,
      label: `${gripLabel(kind, g.command)} (unidad ${g.unit})`,
    });
    if (g.command === 'close') out.counters.picks++;
    else out.counters.places++;
  }
  out.counters.cycles = plan.cycles.filter((c) => c.t0 >= opts.start && c.t0 <= opts.end).length;

  // Sobrevelocidad: pico del tramo (1.5 × cambio ÷ duración con el perfil suavizado)
  // contra la velocidad publicada del eje.
  const worst = joints.map(() => 0);
  for (const seg of plan.segments) {
    if (seg.t1 < opts.start || seg.t0 > opts.end) continue;
    const span = seg.t1 - seg.t0;
    joints.forEach((j, k) => {
      const peak = (1.5 * Math.abs(seg.to[k]! - seg.from[k]!)) / span;
      if (j.max_speed == null || j.max_speed <= 0) return;
      const pct = (peak / j.max_speed) * 100;
      out.peakSpeedPercent[k] = Math.max(out.peakSpeedPercent[k] ?? 0, pct);
      if (pct > 100) {
        worst[k] = Math.max(worst[k]!, pct);
        out.events.push({
          t: seg.t0,
          kind: 'overspeed',
          axis: j.axis,
          percent: Math.round(pct),
          label: `Eje ${j.axis} necesitaría ${Math.round(pct)} % de su velocidad publicada`,
        });
      }
    });
  }
  worst.forEach((w, k) => {
    if (w > 100)
      out.warnings.push(
        `El eje ${joints[k]!.axis} de ${name} necesitaría hasta ${Math.round(w)} % de su velocidad publicada para cumplir el ciclo de la réplica: el ciclo es más corto de lo que permite ese recorrido. No cambia la simulación.`,
      );
  });
  if (opts.maxTcpSpeed != null) {
    const peak = Math.max(0, ...out.tcpSpeed);
    if (peak > opts.maxTcpSpeed)
      out.warnings.push(
        `El TCP de ${name} llegaría a ${peak.toFixed(2)} m/s, más que los ${opts.maxTcpSpeed} m/s publicados.`,
      );
  }
  out.events.sort((a, b) => a.t - b.t);
  return out;
}

/** Índice de la muestra más cercana a t. */
export function sampleIndex(tel: RobotTelemetry, t: number): number {
  if (!tel.t.length) return -1;
  const dt = tel.t.length > 1 ? tel.t[1]! - tel.t[0]! : 1;
  return Math.min(tel.t.length - 1, Math.max(0, Math.round((t - tel.t[0]!) / dt)));
}

const unitOf = (j: JointDef) => (j.type === 'prismatic' ? 'mm' : 'deg');

/** CSV con las señales muestreadas y, al final, los eventos de la ventana. */
export function telemetryCsv(tel: RobotTelemetry): string {
  const head = [
    't_s',
    ...tel.joints.flatMap((j) => [
      `eje${j.axis}_${unitOf(j)}`,
      `eje${j.axis}_comandado_${unitOf(j)}`,
      `eje${j.axis}_vel_${unitOf(j)}_s`,
    ]),
    'tcp_x_mm',
    'tcp_y_mm',
    'tcp_z_mm',
    'tcp_vel_m_s',
    'fase',
    'garra',
    'con_pieza',
  ];
  const f = (x: number) => (Math.round(x * 1000) / 1000).toString();
  const rows = tel.t.map((t, i) =>
    [
      f(t),
      ...tel.joints.flatMap((_, k) => [
        f(tel.position[k]![i]!),
        f(tel.commanded[k]![i]!),
        f(tel.velocity[k]![i]!),
      ]),
      ...tel.tcp[i]!.map(f),
      f(tel.tcpSpeed[i]!),
      tel.phase[i]!,
      tel.gripper[i]!,
      tel.holding[i] ? '1' : '0',
    ].join(','),
  );
  const events = tel.events.map((e) => `${f(e.t)},${e.kind},"${e.label.replaceAll('"', '""')}"`);
  return [head.join(','), ...rows, '', 't_s,evento,detalle', ...events].join('\n') + '\n';
}
