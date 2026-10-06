import { describe, expect, it } from 'vitest';
import {
  aabb,
  buildRobotModel,
  clampJoint,
  overlaps,
  PALLET_SIZES,
  parseStoredScene,
  PROPORTIONS,
  reachExcess,
  resolveJoints,
  Scene,
  validateScene,
  type AxisLimit,
  type RobotModel,
  type RobotSpecInput,
  type SceneObject,
} from '../src/index.ts';

const deg = (axis: number, min: number, max: number): AxisLimit => ({
  axis,
  min,
  max,
  unit: 'deg',
  max_speed: 100,
  speed_unit: 'deg/s',
});

const IRB1300: RobotSpecInput = {
  kinematic_type: 'serial',
  axes_count: 6,
  reach_mm: 1400,
  workspace_diameter_mm: null,
  payload_kg: 7,
  axis_limits: [
    deg(1, -180, 180),
    deg(2, -95, 155),
    deg(3, -210, 69),
    deg(4, -230, 230),
    deg(5, -130, 130),
    deg(6, -400, 400),
  ],
};
const DELTA: RobotSpecInput = {
  kinematic_type: 'delta',
  axes_count: null,
  reach_mm: null,
  workspace_diameter_mm: 1130,
  payload_kg: 1,
  axis_limits: null,
};
const SCARA: RobotSpecInput = {
  kinematic_type: 'scara',
  axes_count: 4,
  reach_mm: 350,
  workspace_diameter_mm: null,
  payload_kg: 3,
  axis_limits: [
    deg(1, -225, 225),
    deg(2, -225, 225),
    { axis: 3, min: -140, max: 0, unit: 'mm', max_speed: 1.1, speed_unit: 'm/s' },
    deg(4, -720, 720),
  ],
};

const robot = (id: string, x = 0, y = 0, elevation = 0): SceneObject => ({
  id,
  name: id,
  kind: 'robot',
  position: [x, y],
  elevation,
  rotation_deg: 0,
  color: '#ff6600',
  served_by: null,
  params: { variant_slug: id, joints: [], show_envelope: false },
});
const box = (
  id: string,
  x: number,
  y: number,
  o: Partial<SceneObject> = {},
  mass: number | null = null,
) =>
  ({
    id,
    name: id,
    kind: 'box',
    position: [x, y],
    elevation: 0,
    rotation_deg: 0,
    color: '#aa7744',
    served_by: null,
    params: { length_mm: 400, width_mm: 300, height_mm: 200, mass_kg: mass },
    ...o,
  }) as SceneObject;

describe('modelo paramétrico de robot', () => {
  it('serie de 6 ejes: alcance y rangos de la ficha, proporciones que suman el alcance', () => {
    const m = buildRobotModel(IRB1300);
    expect(m.kind).toBe('serial6');
    expect(m.reach_mm).toBe(1400);
    expect(m.joints.map((j) => [j.min, j.max])).toEqual(
      IRB1300.axis_limits!.map((a) => [a.min, a.max]),
    );
    const p = PROPORTIONS.serial6;
    expect(p.upper + p.fore + p.wrist).toBeCloseTo(1);
    expect(m.envelope).toEqual({ type: 'sphere', center_z: 0.35 * 1400, radius: 1400 });
  });

  it('delta usa el diámetro de trabajo y no permite mover ejes sin rango publicado', () => {
    const m = buildRobotModel(DELTA);
    expect(m.kind).toBe('delta');
    expect(m.reach_mm).toBe(565);
    expect(m.joints).toEqual([]);
    expect(m.inverted).toBe(true);
  });

  it('SCARA invertido: eje 3 lineal en mm con su carrera', () => {
    const m = buildRobotModel(SCARA);
    expect(m.kind).toBe('scara');
    expect(m.joints[2]).toMatchObject({ type: 'prismatic', unit: 'mm', min: -140, max: 0 });
    expect(m.dims.stroke).toBe(140);
  });

  it('paletizador de 4 ejes y robot sin ejes publicados', () => {
    expect(
      buildRobotModel({
        ...IRB1300,
        kinematic_type: 'parallel_linkage',
        axes_count: 4,
        axis_limits: null,
      }).kind,
    ).toBe('palletizer4');
    const block = buildRobotModel({ ...IRB1300, axes_count: null, axis_limits: null });
    expect(block.kind).toBe('block');
    expect(block.joints).toEqual([]);
  });

  it('los ejes se limitan al rango de la ficha y los sin rango no se mueven', () => {
    const m = buildRobotModel(IRB1300);
    expect(clampJoint(m.joints[1]!, 500)).toBe(155);
    expect(clampJoint(m.joints[1]!, -500)).toBe(-95);
    expect(resolveJoints(m, [10])).toEqual([10, 0, 0, 0, 0, 0]);
    expect(
      clampJoint({ axis: 1, type: 'revolute', min: null, max: 10, unit: 'deg', home: 0 }, 5),
    ).toBe(0);
    // Si 0 queda fuera del rango, el valor inicial es el punto medio.
    expect(buildRobotModel(SCARA).joints[2]!.home).toBe(0);
    expect(
      buildRobotModel({
        ...SCARA,
        axis_limits: [{ ...SCARA.axis_limits![2]!, axis: 1, min: 10, max: 30 }],
      }).joints[0]!.home,
    ).toBe(20);
  });
});

describe('alcance', () => {
  const m = buildRobotModel(IRB1300);
  const r = robot('r1') as Extract<SceneObject, { kind: 'robot' }>;

  it('dentro, en el borde y fuera de la esfera de alcance', () => {
    const near = box('b', 600, 0) as Exclude<SceneObject, { kind: 'robot' }>;
    expect(reachExcess(r, m, near)).toBe(0);
    // Cara superior a la altura del hombro: el borde más cercano a exactamente R.
    const edge = box('b', 1400 + 200, 0, { elevation: 290 }) as Exclude<
      SceneObject,
      { kind: 'robot' }
    >;
    expect(reachExcess(r, m, edge)).toBeCloseTo(0);
    const far = box('b', 2000, 0, { elevation: 290 }) as Exclude<SceneObject, { kind: 'robot' }>;
    expect(reachExcess(r, m, far)).toBeCloseTo(400);
  });

  it('respeta el giro del objeto al buscar el punto más cercano', () => {
    const long = {
      ...box('b', 1800, 0, { elevation: 290 }),
      params: { length_mm: 1200, width_mm: 100, height_mm: 200, mass_kg: null },
    } as Exclude<SceneObject, { kind: 'robot' }>;
    expect(reachExcess(r, m, long)).toBeCloseTo(0); // largo apuntando al robot: borde a 1200
    expect(reachExcess(r, m, { ...long, rotation_deg: 90 })).toBeGreaterThan(300);
  });

  it('alcance no publicado: no se puede validar', () => {
    const nm = buildRobotModel({ ...IRB1300, reach_mm: null });
    expect(
      reachExcess(r, nm, box('b', 0, 0) as Exclude<SceneObject, { kind: 'robot' }>),
    ).toBeNull();
  });

  it('delta: radio del área de trabajo y objeto debajo de la base', () => {
    const dm = buildRobotModel(DELTA);
    const d = robot('d', 0, 0, 1500) as Extract<SceneObject, { kind: 'robot' }>;
    expect(reachExcess(d, dm, box('b', 500, 0) as Exclude<SceneObject, { kind: 'robot' }>)).toBe(0);
    expect(
      reachExcess(d, dm, box('b', 965, 0) as Exclude<SceneObject, { kind: 'robot' }>),
    ).toBeCloseTo(200);
    expect(
      reachExcess(
        d,
        dm,
        box('b', 0, 0, { elevation: 1400 }) as Exclude<SceneObject, { kind: 'robot' }>,
      ),
    ).toBeCloseTo(100);
  });
});

describe('validateScene', () => {
  const models: Record<string, RobotModel> = {
    r1: buildRobotModel(IRB1300),
    r2: buildRobotModel({ ...IRB1300, payload_kg: null }),
  };
  const scene = (objects: SceneObject[]) => Scene.parse({ schema: 1, objects });

  it('advierte fuera de alcance y carga excedida', () => {
    const w = validateScene(
      scene([
        robot('r1'),
        box('lejos', 3000, 0, { served_by: 'r1' }, 2),
        box('pesada', 700, 0, { served_by: 'r1' }, 9),
      ]),
      (s) => models[s],
    );
    expect(w.map((x) => [x.kind, x.level, x.objects[0]])).toEqual([
      ['reach', 'warning', 'lejos'],
      ['payload', 'warning', 'pesada'],
    ]);
    expect(w[0]!.message).toMatch(/excede/);
  });

  it('carga dentro del límite no advierte; masa o carga desconocida informa', () => {
    const w = validateScene(
      scene([
        robot('r1'),
        robot('r2', 5000),
        box('ok', 700, 0, { served_by: 'r1' }, 7),
        box('sin masa', 700, 600, { served_by: 'r1' }),
        box('x', 5700, 0, { served_by: 'r2' }, 1),
      ]),
      (s) => models[s],
    );
    expect(w.map((x) => [x.kind, x.level])).toEqual([
      ['payload', 'info'],
      ['payload', 'info'],
    ]);
  });

  it('colisiones AABB: solapados sí, tocándose o separados no', () => {
    const stacked = box('arriba', 1000, 0, { elevation: 200 });
    const w = validateScene(
      scene([
        box('a', 1000, 0),
        box('b', 1100, 0),
        stacked,
        box('c', 1500, 0),
        box('lejos', 4000, 0),
      ]),
      () => null,
    );
    const pairs = w.filter((x) => x.kind === 'collision').map((x) => x.objects.join('+'));
    // a y b se solapan; "arriba" toca a y b por encima; c toca a b en el borde (x = 1300).
    expect(pairs).toEqual(['a+b']);
  });

  it('el giro de 90° cambia la caja delimitadora', () => {
    const b = box('b', 0, 0) as SceneObject;
    expect(aabb(b).max[0]).toBe(200);
    expect(aabb({ ...b, rotation_deg: 90 }).max[0]).toBeCloseTo(150);
    const near = box('n', 0, 330) as SceneObject;
    expect(overlaps(aabb(b), aabb(near))).toBe(false);
    expect(overlaps(aabb({ ...b, rotation_deg: 90 }), aabb(near))).toBe(true);
  });

  it('un robot sobre un pallet colisiona con él', () => {
    const pallet = {
      ...box('p', 0, 0),
      kind: 'pallet',
      params: { preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 },
    } as SceneObject;
    const w = validateScene(scene([robot('r1'), pallet]), (s) => models[s]);
    expect(w.some((x) => x.kind === 'collision')).toBe(true);
  });
});

describe('escena', () => {
  it('valida ids únicos, medidas positivas y la altura obligatoria del pallet', () => {
    const ok = { schema: 1, objects: [box('a', 0, 0)] };
    expect(Scene.safeParse(ok).success).toBe(true);
    expect(Scene.safeParse({ schema: 1, objects: [box('a', 0, 0), box('a', 1, 1)] }).success).toBe(
      false,
    );
    const pallet = {
      ...box('p', 0, 0),
      kind: 'pallet',
      params: { preset: 'gma', length_mm: 1219, width_mm: 1016 },
    };
    expect(Scene.safeParse({ schema: 1, objects: [pallet] }).success).toBe(false);
  });

  it('un layout guardado vacío ({}) se lee como escena vacía', () => {
    expect(parseStoredScene({})).toEqual({ schema: 1, objects: [] });
  });

  it('solo el EUR publica altura de pallet', () => {
    expect(PALLET_SIZES.eur.height_mm).toBe(144);
    expect(PALLET_SIZES.gma.height_mm).toBeNull();
    expect(PALLET_SIZES['1200x1000'].height_mm).toBeNull();
  });
});
