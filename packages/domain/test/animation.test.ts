import { describe, expect, it } from 'vitest';
import {
  axisState,
  buildMotionPlan,
  buildRobotModel,
  buildTimeline,
  createLinePlayer,
  gripperKind,
  lineStateAt,
  m4,
  placeUnits,
  poseAt,
  robotHandling,
  sampleTelemetry,
  Scene,
  simplifiedVisual,
  telemetryCsv,
  toolAt,
  type EventLog,
  type IkResult,
  type JointDef,
  type LinkPose,
  type RobotVisual,
  type SimEvent,
  type ToolTarget,
  type Vec3,
} from '../src/index.ts';
import { IRB1300 } from './fixtures.ts';

const round = (x: number) => Math.round(x * 1000) / 1000;
const fixed = (value: number) => ({ dist: { type: 'fixed', value }, origin: 'user', note: null });

/** Banda de entrada → robot → pallet EUR (2 cajas por pallet, cambio de 9 s). */
const scene = Scene.parse({
  schema: 2,
  objects: [
    {
      id: 'in',
      name: 'Banda',
      kind: 'conveyor',
      position: [0, 700],
      color: '#475569',
      params: { length_mm: 1200, width_mm: 400, height_mm: 500 },
    },
    {
      id: 'r',
      name: 'Robot',
      kind: 'robot',
      position: [0, 0],
      color: '#f97316',
      params: { variant_slug: 'irb-1300-7-1-4' },
    },
    {
      id: 'p',
      name: 'Pallet',
      kind: 'pallet',
      position: [0, -700],
      color: '#c08a4a',
      params: { preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 },
    },
  ],
  process: {
    product: { name: 'Caja', size_mm: { length_mm: 300, width_mm: 200, height_mm: 200 } },
    nodes: [
      { role: 'source', object_id: 'in', item: 'Caja', interarrival: fixed(2) },
      { role: 'station', object_id: 'r', cycle: fixed(4) },
      { role: 'sink', object_id: 'p', units_per_pallet: 2, pallet_change: fixed(9) },
    ],
    routes: [
      { id: 'a', from: 'in', to: 'r' },
      { id: 'b', from: 'r', to: 'p' },
    ],
  },
});

// Unidad 1: ciclo de 1 a 5 s y el pallet la acepta en 7 (el robot queda bloqueado 2 s).
// Unidad 2: llega en 3, espera en la banda hasta 7 y su ciclo va de 7 a 11. Completa el pallet.
const v2: SimEvent[] = [
  [0, 'st', 'r', 'idle'],
  [0, 'pal', 'p', 0],
  [1, 'at', 1, 'in'],
  [1, 'at', 1, 'r'],
  [1, 'st', 'r', 'busy'],
  [3, 'at', 2, 'in'],
  [5, 'done', 1, 'r'],
  [5, 'st', 'r', 'blocked'],
  [7, 'at', 1, 'p'],
  [7, 'pal', 'p', 1],
  [7, 'gone', 1],
  [7, 'at', 2, 'r'],
  [7, 'st', 'r', 'busy'],
  [11, 'done', 2, 'r'],
  [11, 'at', 2, 'p'],
  [11, 'pal', 'p', 2],
  [11, 'pal', 'p', 0],
  [11, 'pchg', 'p', 1],
  [11, 'gone', 2],
  [11, 'st', 'r', 'idle'],
  [20, 'pchg', 'p', 0],
];
const log: EventLog = {
  version: 2,
  start_s: 0,
  end_s: 30,
  replication: 0,
  truncated: false,
  events: v2,
};

describe('reproducción: estado en un instante', () => {
  const tl = buildTimeline(log, scene);

  it('cuenta lo que espera, lo que se procesa y lo que espera para entrar', () => {
    const s = lineStateAt(tl, 4);
    expect(s.states.get('r')).toBe('busy');
    expect(s.queues.get('in')).toMatchObject({ waiting: 1, inProcess: 0 });
    expect(s.queues.get('r')).toMatchObject({ waiting: 0, inProcess: 1, incoming: 1 });
    // Robot bloqueado con la unidad terminada: su capacidad (1) está llena.
    expect(lineStateAt(tl, 6).queues.get('r')).toMatchObject({
      waiting: 1,
      ratio: 1,
      level: 'full',
    });
  });

  it('acumula el tiempo de espera para el mapa de calor', () => {
    const s = lineStateAt(tl, 7.5);
    expect(s.heat.get('in')).toBeCloseTo(4); // unidad 2: de 3 a 7
    expect(s.heat.get('r')).toBeCloseTo(2); // unidad 1 bloqueada de 5 a 7
    expect(s.heatMax).toBeCloseTo(4);
  });

  it('llena el pallet, lo muestra lleno durante el cambio y luego vacío', () => {
    expect(lineStateAt(tl, 8).pallets.get('p')).toMatchObject({ fill: 1, changing: false });
    expect(lineStateAt(tl, 12).pallets.get('p')).toMatchObject({
      fill: 2,
      changing: true,
      completed: 1,
    });
    expect(lineStateAt(tl, 21).pallets.get('p')).toMatchObject({ fill: 0, changing: false });
    expect(lineStateAt(tl, 12).counters.get('r')).toEqual({ arrived: 2, completed: 2 });
    // Cada unidad ocupa su lugar del patrón.
    expect(tl.visitsByUnit.get(1)!.find((v) => v.node === 'p')!.slot).toBe(0);
    expect(tl.visitsByUnit.get(2)!.find((v) => v.node === 'p')!.slot).toBe(1);
  });

  it('da el mismo estado al avanzar y al retroceder', () => {
    const p = createLinePlayer(tl);
    for (const t of [2, 6, 12, 4, 25, 6]) expect(p.seek(t)).toEqual(lineStateAt(tl, t));
  });

  it('reproduce registros de la versión 1 estimando el fin de ciclo con la media', () => {
    const v1 = buildTimeline(
      {
        ...log,
        version: undefined,
        events: v2.filter((e) => e[1] !== 'done' && e[1] !== 'pal' && e[1] !== 'pchg'),
      },
      scene,
    );
    expect(v1.visitsByUnit.get(1)!.find((v) => v.node === 'r')!.tDone).toBe(5);
    expect(lineStateAt(v1, 6).queues.get('r')).toMatchObject({ waiting: 1, inProcess: 0 });
    expect(lineStateAt(v1, 8).pallets.get('p')!.fill).toBe(1);
  });

  it('las unidades en banda avanzan y se acumulan al final', () => {
    const conv = Scene.parse({
      schema: 2,
      objects: [
        {
          id: 'b',
          name: 'Banda',
          kind: 'conveyor',
          position: [0, 0],
          color: '#475569',
          params: { length_mm: 1000, width_mm: 400, height_mm: 700 },
        },
        {
          id: 's',
          name: 'Mesa',
          kind: 'table',
          position: [1500, 0],
          color: '#94a3b8',
          params: { length_mm: 600, width_mm: 600, height_mm: 700 },
        },
      ],
      process: {
        product: { name: 'P', size_mm: { length_mm: 200, width_mm: 200, height_mm: 100 } },
        nodes: [
          { role: 'buffer', object_id: 'b', capacity: 10, transfer: fixed(10) },
          { role: 'station', object_id: 's', cycle: fixed(100) },
        ],
        routes: [{ id: 'x', from: 'b', to: 's' }],
      },
    });
    const t2 = buildTimeline(
      {
        ...log,
        events: [
          [0, 'at', 1, 'b'],
          [1, 'at', 2, 'b'],
          [2, 'at', 3, 'b'],
        ],
      },
      conv,
    );
    // Velocidad = 1000 mm / 10 s = 100 mm/s. A t = 3 la unidad 1 avanzó 300 mm.
    const at3 = placeUnits(t2, lineStateAt(t2, 3));
    expect(at3.find((u) => u.id === 1)!.position[0]).toBeCloseTo(-500 + 110 + 300);
    // A t = 60 las tres están acumuladas al final, separadas por su largo (+10 %).
    const end = placeUnits(t2, lineStateAt(t2, 60)).sort((a, b) => a.id - b.id);
    expect(end.map((u) => Math.round(u.position[0]))).toEqual([390, 170, -50]);
    expect(end.every((u) => u.position[2] === 700)).toBe(true);
  });
});

describe('movimiento del robot (tomar y dejar)', () => {
  const tl = buildTimeline(log, scene);
  const visual = simplifiedVisual(buildRobotModel(IRB1300));
  const plan = buildMotionPlan(tl, 'r', visual);

  it('cierra la garra al tomar y la abre al soltar; espera bloqueado sosteniendo la pieza', () => {
    expect(plan.warnings).toEqual([]);
    // Unidad 2: empieza al soltar la 1 (bloqueado), así que su ciclo arranca regresando
    // (20 %) y suelta al 90 % del ciclo.
    expect(plan.grips.map((g) => [round(g.t), g.command, g.unit])).toEqual([
      [1.48, 'close', 1],
      [7, 'open', 1],
      [8.28, 'close', 2],
      [10.6, 'open', 2],
    ]);
    expect(poseAt(plan, 7.4)).toMatchObject({ phase: 'regresando', carrying: null });
    expect(poseAt(plan, 3)).toMatchObject({ phase: 'trasladando', carrying: 1, gripper: 'closed' });
    expect(poseAt(plan, 6)).toMatchObject({ phase: 'esperando destino', carrying: 1 });
    expect(poseAt(plan, 12)).toMatchObject({ phase: 'reposo', gripper: 'open', carrying: null });
  });

  it('la herramienta llega a la recogida y a la entrega (lugar del pallet)', () => {
    const c = plan.cycles[0]!;
    const near = (a: Vec3, b: Vec3) => expect(m4.norm(m4.sub(a, b))).toBeLessThan(1);
    near(toolAt(plan, c.tGrip).position, [c.pick[0], c.pick[1], c.pick[2] + 200]);
    near(toolAt(plan, 1 + 0.7 * 4).position, [c.drop[0], c.drop[1], c.drop[2] + 200]);
    // La recogida es el frente de la banda; la entrega, el lugar 0 del patrón del pallet.
    expect(c.pick).toEqual([600 - 165, 700, 500]);
    expect(c.drop[2]).toBe(144);
  });

  it('la pieza cuelga de la herramienta mientras la transporta', () => {
    const at = 3;
    const units = placeUnits(tl, lineStateAt(tl, at), robotHandling(new Map([['r', plan]])));
    const u = units.find((x) => x.id === 1)!;
    expect(u.carriedBy).toBe('r');
    const tcp = toolAt(plan, at).position;
    expect(u.position).toEqual([tcp[0], tcp[1], tcp[2] - 200]);
    // Antes de tomarla está en la recogida; ya soltada, en el pallet.
    const before = placeUnits(tl, lineStateAt(tl, 1.2), robotHandling(new Map([['r', plan]])));
    expect(before.find((x) => x.id === 1)!.position).toEqual(plan.cycles[0]!.pick);
  });

  it('los ejes nunca salen de los rangos de la ficha', () => {
    for (let t = 0; t <= 14; t += 0.05) {
      poseAt(plan, t).joints.forEach((q, i) => {
        const j = visual.joints[i]!;
        expect(q).toBeGreaterThanOrEqual(j.min! - 1e-6);
        expect(q).toBeLessThanOrEqual(j.max! + 1e-6);
      });
    }
  });

  it('si la ficha no permite alcanzar un punto, avisa y no fuerza el movimiento', () => {
    const far = Scene.parse({
      ...scene,
      objects: scene.objects.map((o) => (o.id === 'p' ? { ...o, position: [0, -3000] } : o)),
    });
    const p = buildMotionPlan(buildTimeline(log, far), 'r', visual);
    expect(p.warnings.join(' ')).toMatch(/no alcanza el punto de entrega en Pallet/);
    expect(p.segments).toEqual([]);
    expect(p.skipped).toEqual([1, 2]);
  });
});

/**
 * Robot de prueba que NO usa la cadena simplificada: un robot cilíndrico (giro, brazo
 * telescópico y columna) escrito desde cero. Si la animación solo habla con RobotVisual, debe
 * funcionar igual con él, como funcionará con el CAD.
 */
class CylindricalTestRobot implements RobotVisual {
  readonly kind = 'block' as const;
  readonly notes = [];
  readonly joints: JointDef[] = [
    { axis: 1, type: 'revolute', min: -170, max: 170, unit: 'deg', home: 0, max_speed: 180 },
    { axis: 2, type: 'prismatic', min: 200, max: 1500, unit: 'mm', home: 600, max_speed: 1000 },
    { axis: 3, type: 'prismatic', min: 0, max: 1500, unit: 'mm', home: 1000, max_speed: 1000 },
  ];
  readonly links = [];
  private q = [0, 600, 1000];
  setJointValues(v: readonly number[]) {
    this.q = this.joints.map((j, i) => Math.min(j.max!, Math.max(j.min!, v[i] ?? j.home)));
  }
  jointValues() {
    return [...this.q];
  }
  linkPoses(): LinkPose[] {
    return [{ name: 'carro', matrix: m4.translation(this.toolPose().position) }];
  }
  toolPose() {
    const a = (this.q[0]! * Math.PI) / 180;
    const position: Vec3 = [Math.cos(a) * this.q[1]!, Math.sin(a) * this.q[1]!, this.q[2]!];
    return { position, approach: [0, 0, -1] as Vec3, matrix: m4.translation(position) };
  }
  solve(target: ToolTarget): IkResult {
    const [x, y, z] = target.position;
    const q = [(Math.atan2(y, x) * 180) / Math.PI, Math.hypot(x, y), z];
    const ok = q.every((v, i) => v >= this.joints[i]!.min! && v <= this.joints[i]!.max!);
    return {
      reached: ok,
      joints: q,
      error_mm: 0,
      error_deg: 0,
      reason: ok ? null : 'fuera de rango',
    };
  }
}

describe('RobotVisual: la animación funciona con otro modelo (cambio a CAD transparente)', () => {
  const tl = buildTimeline(log, scene);
  const robot = new CylindricalTestRobot();
  const plan = buildMotionPlan(tl, 'r', robot);

  it('mismo plan de tomar y dejar, mismos comandos de garra y pieza en la herramienta', () => {
    expect(plan.warnings).toEqual([]);
    expect(plan.grips.map((g) => [round(g.t), g.command])).toEqual([
      [1.48, 'close'],
      [7, 'open'],
      [8.28, 'close'],
      [10.6, 'open'],
    ]);
    const c = plan.cycles[0]!;
    const tcp = toolAt(plan, c.tGrip).position;
    expect(m4.norm(m4.sub(tcp, [c.pick[0], c.pick[1], c.pick[2] + 200]))).toBeLessThan(1e-6);
    const units = placeUnits(tl, lineStateAt(tl, 3), robotHandling(new Map([['r', plan]])));
    expect(units.find((u) => u.id === 1)!.carriedBy).toBe('r');
  });

  it('la telemetría sale igual y respeta los rangos del modelo de prueba', () => {
    const tel = sampleTelemetry(plan, { start: 0, end: 14 });
    expect(tel.joints.map((j) => j.axis)).toEqual([1, 2, 3]);
    tel.position.forEach((serie, k) =>
      serie.forEach((v) => {
        expect(v).toBeGreaterThanOrEqual(robot.joints[k]!.min!);
        expect(v).toBeLessThanOrEqual(robot.joints[k]!.max!);
      }),
    );
  });
});

describe('telemetría del robot', () => {
  const tl = buildTimeline(log, scene);
  const plan = buildMotionPlan(tl, 'r', simplifiedVisual(buildRobotModel(IRB1300)));
  const tel = sampleTelemetry(plan, { start: 0, end: 14, gripper: 'vacuum' });

  it('registra los comandos de la garra en su instante y los contadores', () => {
    const grips = tel.events.filter((e) => e.kind === 'grip');
    expect(grips.map((e) => [round(e.t), e.label])).toEqual([
      [1.48, 'Vacío activado (unidad 1)'],
      [7, 'Vacío liberado (unidad 1)'],
      [8.28, 'Vacío activado (unidad 2)'],
      [10.6, 'Vacío liberado (unidad 2)'],
    ]);
    expect(tel.counters).toMatchObject({ cycles: 2, picks: 2, places: 2 });
    expect(tel.counters.tcp_distance_m).toBeGreaterThan(1);
    expect(tel.events.some((e) => e.kind === 'phase' && e.phase === 'esperando destino')).toBe(
      true,
    );
    expect(gripperKind('vacuum gripper')).toBe('vacuum');
    expect(gripperKind('electric parallel gripper (2 jaws)')).toBe('mechanical');
  });

  it('la velocidad de cada eje es la derivada de su posición', () => {
    const h = 1e-4;
    for (const t of [1.2, 2.5, 3.3, 7.3, 8.5, 9.6]) {
      const v = poseAt(plan, t).velocity;
      const a = poseAt(plan, t - h).joints;
      const b = poseAt(plan, t + h).joints;
      v.forEach((x, k) => expect(x).toBeCloseTo((b[k]! - a[k]!) / (2 * h), 2));
    }
    // Las muestras de la telemetría son esas mismas velocidades.
    const i = Math.round(2.5 * 20);
    expect(tel.velocity[1]![i]).toBeCloseTo(poseAt(plan, tel.t[i]!).velocity[1]!, 9);
    // Comandado: el objetivo del tramo; el ejecutado lo alcanza al terminar el tramo.
    const end = Math.round(3.8 * 20);
    expect(tel.position[0]![end]).toBeCloseTo(tel.commanded[0]![end - 1]!, 6);
  });

  it('marca sobrevelocidad contra la ficha sin cambiar la simulación', () => {
    const slow = {
      ...IRB1300,
      axis_limits: IRB1300.axis_limits!.map((a) => ({ ...a, max_speed: 1 })),
    };
    const p = buildMotionPlan(tl, 'r', simplifiedVisual(buildRobotModel(slow)));
    const t = sampleTelemetry(p, { start: 0, end: 14 });
    expect(t.warnings.join(' ')).toMatch(/necesitaría hasta \d+ % de su velocidad publicada/);
    expect(t.events.some((e) => e.kind === 'overspeed')).toBe(true);
    expect(p.grips).toEqual(plan.grips);
  });

  it('estado de eje: en movimiento, detenido o en tope', () => {
    const j: JointDef = {
      axis: 1,
      type: 'revolute',
      min: -100,
      max: 100,
      unit: 'deg',
      home: 0,
      max_speed: 100,
    };
    expect(axisState(j, 0, 5)).toBe('moving');
    expect(axisState(j, 0, 0)).toBe('stopped');
    expect(axisState(j, 99.5, 0)).toBe('limit');
  });

  it('exporta CSV con señales y eventos', () => {
    const csv = telemetryCsv(tel);
    const [head, first] = csv.split('\n');
    expect(head).toMatch(
      /^t_s,eje1_deg,eje1_comandado_deg,eje1_vel_deg_s,.*tcp_vel_m_s,fase,garra,con_pieza$/,
    );
    expect(first!.split(',')).toHaveLength(head!.split(',').length);
    expect(csv).toContain('t_s,evento,detalle');
    expect(csv).toContain('grip,"Vacío activado (unidad 1)"');
  });
});
