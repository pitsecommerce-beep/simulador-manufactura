import { describe, expect, it } from 'vitest';
import {
  buildRobotModel,
  distMean,
  emptyProcess,
  ProcessModel,
  ProcessNode,
  removeObjectFromProcess,
  Scene,
  validateProcess,
  validateScene,
  type ProcessContext,
  type ProcessIssue,
  type Route,
  type SceneObject,
  type Timed,
} from '../src/index.ts';

const fixed = (value: number, origin: Timed['origin'] = 'user'): Timed => ({
  dist: { type: 'fixed', value },
  origin,
  note: null,
});

const ctx = (kinds: Record<string, string>): ProcessContext => ({
  objects: Object.entries(kinds).map(([id, kind]) => ({ id, kind, name: id })),
});

const source = (id: string, item = 'Producto'): ProcessNode =>
  ProcessNode.parse({
    role: 'source',
    object_id: id,
    item,
    interarrival: fixed(10),
  });
const station = (
  id: string,
  extra: Partial<Extract<ProcessNode, { role: 'station' }>> = {},
): ProcessNode =>
  ProcessNode.parse({
    role: 'station',
    object_id: id,
    cycle: fixed(8),
    ...extra,
  });
const buffer = (id: string, capacity: number | null): ProcessNode =>
  ProcessNode.parse({ role: 'buffer', object_id: id, capacity });
const sink = (id: string): ProcessNode =>
  ProcessNode.parse({ role: 'sink', object_id: id, units_per_pallet: 40 });
const route = (from: string, to: string, extra: Partial<Route> = {}): Route => ({
  id: `${from}-${to}-${extra.item ?? ''}`,
  from,
  to,
  item: null,
  share: null,
  ...extra,
});

const KINDS = {
  src: 'conveyor',
  r1: 'robot',
  buf: 'conveyor',
  r2: 'robot',
  pal: 'pallet',
  t: 'table',
};
const line = (): ProcessModel => ({
  product: { name: 'Producto', bom: [] },
  nodes: [source('src'), station('r1'), buffer('buf', 5), station('r2'), sink('pal')],
  routes: [route('src', 'r1'), route('r1', 'buf'), route('buf', 'r2'), route('r2', 'pal')],
});
const errors = (issues: ProcessIssue[]) =>
  issues.filter((i) => i.level === 'error').map((i) => i.code);

describe('validateProcess', () => {
  it('una línea fuente → estación → buffer → estación → salida es válida', () => {
    const issues = validateProcess(line(), ctx(KINDS));
    expect(errors(issues)).toEqual([]);
    // Los tiempos capturados por el usuario se informan como supuestos.
    expect(issues.filter((i) => i.code === 'assumption').length).toBeGreaterThan(0);
  });

  it('un proceso vacío no genera avisos', () => {
    expect(validateProcess(emptyProcess(), ctx({}))).toEqual([]);
  });

  it('detecta rutas sin salida y nodos inalcanzables', () => {
    const p = line();
    p.routes = p.routes.filter((r) => r.from !== 'r2');
    p.nodes.push(station('t'));
    p.routes.push(route('t', 'pal'));
    const codes = errors(validateProcess(p, ctx(KINDS)));
    expect(codes).toContain('no_exit'); // r2 no tiene salida
    expect(codes).toContain('unreachable'); // a t no llega nada
  });

  it('detecta ciclos', () => {
    const p = line();
    p.routes.push(route('r2', 'r1', { share: 0.5 }));
    p.routes.find((r) => r.from === 'r2' && r.to === 'pal')!.share = 0.5;
    const issues = validateProcess(p, ctx(KINDS));
    expect(errors(issues)).toContain('cycle');
    expect(issues.find((i) => i.code === 'cycle')!.objects.sort()).toEqual(['buf', 'r1', 'r2']);
  });

  it.each([
    [null, true],
    [0, true],
    [2.5, true],
    [1, false],
  ])('buffer con capacidad %s → error: %s', (capacity, isError) => {
    const p = line();
    p.nodes[2] = buffer('buf', capacity);
    expect(errors(validateProcess(p, ctx(KINDS))).includes('buffer_capacity')).toBe(isError);
  });

  it('exige tiempo de ciclo, tasa de llegada, artículo y unidades por pallet', () => {
    const p = line();
    p.nodes = [
      { ...source('src'), interarrival: null, item: null } as ProcessNode,
      { ...station('r1'), cycle: null } as ProcessNode,
      buffer('buf', 5),
      station('r2'),
      { ...sink('pal'), units_per_pallet: null } as ProcessNode,
    ];
    expect(errors(validateProcess(p, ctx(KINDS)))).toEqual(
      expect.arrayContaining([
        'missing_interarrival',
        'missing_item',
        'missing_cycle',
        'missing_units',
      ]),
    );
  });

  it('roles incompatibles, rutas desde una salida o hacia una fuente', () => {
    const p = line();
    p.nodes[1] = buffer('r1', 3); // un robot no puede ser buffer
    p.routes.push(route('pal', 'r2'), route('r2', 'src'));
    const codes = errors(validateProcess(p, ctx(KINDS)));
    expect(codes).toEqual(
      expect.arrayContaining(['role_incompatible', 'route_from_sink', 'route_to_source']),
    );
  });

  it('varias salidas: fracciones obligatorias que sumen 1, o reparto por artículo', () => {
    const k = { ...KINDS, pal2: 'pallet' };
    const p = line();
    p.nodes.push(sink('pal2'));
    p.routes.push(route('r2', 'pal2'));
    expect(errors(validateProcess(p, ctx(k)))).toContain('share_missing');
    p.routes.find((r) => r.to === 'pal')!.share = 0.7;
    p.routes.find((r) => r.to === 'pal2')!.share = 0.2;
    expect(errors(validateProcess(p, ctx(k)))).toContain('share_sum');
    p.routes.find((r) => r.to === 'pal2')!.share = 0.3;
    expect(errors(validateProcess(p, ctx(k)))).toEqual([]);
  });

  it('ensamblaje: la BOM debe llegar completa a la estación', () => {
    const k = { tapas: 'conveyor', cajas: 'conveyor', r1: 'robot', pal: 'pallet' };
    const p: ProcessModel = {
      product: {
        name: 'Caja cerrada',
        bom: [
          { item: 'caja', qty: 1 },
          { item: 'tapa', qty: 1 },
        ],
      },
      nodes: [
        source('cajas', 'caja'),
        source('tapas', 'tapa'),
        station('r1', { operation: 'assemble' }),
        sink('pal'),
      ],
      routes: [route('cajas', 'r1'), route('r1', 'pal')],
    };
    const issues = validateProcess(p, ctx(k));
    expect(errors(issues)).toEqual(expect.arrayContaining(['bom_uncovered', 'no_exit']));
    expect(issues.find((i) => i.code === 'bom_uncovered')!.message).toMatch(/tapa/);
    p.routes.push(route('tapas', 'r1'));
    expect(errors(validateProcess(p, ctx(k)))).toEqual([]);
    p.product.bom = [];
    expect(errors(validateProcess(p, ctx(k)))).toContain('assemble_without_bom');
  });

  it('parámetros fuera de rango: scrap, MTBF y distribuciones mal formadas', () => {
    const p = line();
    p.nodes[1] = station('r1', {
      scrap: { rate: 1.2, origin: 'user' },
      failures: { mtbf_s: 0, mttr: { type: 'uniform', min: 60, max: 30 }, origin: 'user' },
      cycle: { dist: { type: 'triangular', min: 5, mode: 4, max: 9 }, origin: 'user', note: null },
    });
    const msgs = validateProcess(p, ctx(KINDS)).filter((i) => i.code === 'param_range');
    expect(msgs).toHaveLength(4);
  });

  it('marca el origen de los tiempos y avisa si la ficha publica ciclos', () => {
    const p = line();
    p.nodes[1] = station('r1', { cycle: fixed(0.54, 'catalog') });
    p.nodes[3] = station('r2', { cycle: fixed(3, 'assistant') });
    const issues = validateProcess(p, {
      ...ctx(KINDS),
      publishedCycles: (id) => (id === 'r2' ? [0.54] : undefined),
    });
    const r1 = issues.filter((i) => i.objects[0] === 'r1' && i.code === 'assumption');
    expect(r1).toEqual([]); // ciclo de la ficha: no es supuesto
    expect(issues.find((i) => i.objects[0] === 'r2' && i.code === 'assumption')!.message).toMatch(
      /asistente/,
    );
    expect(issues.some((i) => i.code === 'catalog_cycle_available')).toBe(true);
  });

  it('nodos que apuntan a objetos borrados', () => {
    const p = line();
    const rest = Object.fromEntries(Object.entries(KINDS).filter(([id]) => id !== 'r1'));
    expect(errors(validateProcess(p, ctx(rest)))).toContain('missing_object');
    const cleaned = removeObjectFromProcess(p, 'r1');
    expect(cleaned.nodes.map((n) => n.object_id)).not.toContain('r1');
    expect(cleaned.routes.some((r) => r.from === 'r1' || r.to === 'r1')).toBe(false);
  });

  it('media de cada distribución', () => {
    expect(distMean({ type: 'triangular', min: 1, mode: 2, max: 6 })).toBe(3);
    expect(distMean({ type: 'uniform', min: 2, max: 4 })).toBe(3);
    expect(distMean({ type: 'exponential', mean: 5 })).toBe(5);
  });
});

describe('escena schema 2 y objetos nuevos', () => {
  const base = {
    position: [0, 0],
    elevation: 0,
    rotation_deg: 0,
    color: '#123456',
    served_by: null,
  };

  it('convierte escenas schema 1 agregando un proceso vacío', () => {
    const s = Scene.parse({ schema: 1, objects: [] });
    expect(s.schema).toBe(2);
    expect(s.process).toEqual(emptyProcess());
  });

  it('acepta gripper, sensor, valla y zona de seguridad', () => {
    const s = Scene.parse({
      schema: 2,
      objects: [
        {
          ...base,
          id: 'g',
          name: 'Gripper',
          kind: 'gripper',
          params: { component_slug: 'onrobot-2fg7', mounted_on: null },
        },
        { ...base, id: 's', name: 'Sensor', kind: 'sensor', params: { component_slug: null } },
        {
          ...base,
          id: 'f',
          name: 'Valla',
          kind: 'fence',
          params: { length_mm: 2000, height_mm: 2200, thickness_mm: 50, component_slug: null },
        },
        {
          ...base,
          id: 'z',
          name: 'Zona',
          kind: 'safety_zone',
          params: { length_mm: 1000, width_mm: 1000 },
        },
      ],
    });
    expect(s.objects.map((o) => o.kind)).toEqual(['gripper', 'sensor', 'fence', 'safety_zone']);
  });

  const IRB = buildRobotModel({
    kinematic_type: 'serial',
    axes_count: 6,
    reach_mm: 1400,
    workspace_diameter_mm: null,
    payload_kg: 7,
    axis_limits: null,
  });
  const robot = {
    ...base,
    id: 'r1',
    name: 'IRB',
    kind: 'robot',
    params: { variant_slug: 'irb', joints: [], show_envelope: false },
  };
  const boxOf = (mass: number) => ({
    ...base,
    id: 'b',
    name: 'Caja',
    kind: 'box',
    position: [700, 0],
    served_by: 'r1',
    params: { length_mm: 300, width_mm: 200, height_mm: 200, mass_kg: mass },
  });
  const gripper = (slug: string | null) => ({
    ...base,
    id: 'g',
    name: 'Gripper',
    kind: 'gripper',
    params: { component_slug: slug, mounted_on: 'r1' },
  });
  const scene = (objects: unknown[]) => Scene.parse({ schema: 2, objects });
  const components = {
    '2fg7': { name: '2FG7', weight_kg: 1.1 },
    'sin-peso': { name: 'X', weight_kg: null },
  };

  it('la carga suma el peso publicado del gripper montado', () => {
    const w = validateScene(
      scene([robot, boxOf(6.5), gripper('2fg7')]),
      () => IRB,
      (s) => components[s as keyof typeof components],
    );
    const payload = w.find((x) => x.kind === 'payload' && x.level === 'warning');
    expect(payload?.message).toMatch(/7\.6 kg.*Incluye Gripper \(1\.1 kg publicados\)/);
    // Sin gripper, 6.5 kg cabe.
    expect(
      validateScene(scene([robot, boxOf(6.5)]), () => IRB).some((x) => x.kind === 'payload'),
    ).toBe(false);
  });

  it('gripper sin peso publicado: se avisa y no se suma', () => {
    const w = validateScene(
      scene([robot, boxOf(6.5), gripper('sin-peso')]),
      () => IRB,
      (s) => components[s as keyof typeof components],
    );
    expect(w.filter((x) => x.kind === 'payload').map((x) => x.level)).toEqual(['info']);
  });

  it('zona de seguridad invadida por la envolvente; montado en robot inexistente', () => {
    const zone = {
      ...base,
      id: 'z',
      name: 'Zona',
      kind: 'safety_zone',
      position: [2000, 0],
      params: { length_mm: 1000, width_mm: 1000 },
    };
    expect(validateScene(scene([robot, zone]), () => IRB).some((x) => x.kind === 'safety')).toBe(
      false,
    );
    const near = { ...zone, position: [1500, 0] };
    expect(validateScene(scene([robot, near]), () => IRB).some((x) => x.kind === 'safety')).toBe(
      true,
    );
    const lost = { ...gripper(null), params: { component_slug: null, mounted_on: 'nadie' } };
    expect(validateScene(scene([lost]), () => null)[0]!.kind).toBe('data');
  });

  it('la valla colisiona; la zona de seguridad y el gripper montado no', () => {
    const fence = {
      ...base,
      id: 'f',
      name: 'Valla',
      kind: 'fence',
      position: [700, 0],
      params: { length_mm: 2000, height_mm: 2000, thickness_mm: 50, component_slug: null },
    };
    const zone = {
      ...base,
      id: 'z',
      name: 'Zona',
      kind: 'safety_zone',
      position: [700, 0],
      params: { length_mm: 3000, width_mm: 3000 },
    };
    const w = validateScene(scene([boxOf(1), fence, zone, gripper(null)]), () => IRB);
    const pairs = w.filter((x) => x.kind === 'collision').map((x) => x.objects.sort().join('+'));
    expect(pairs).toEqual(['b+f']);
  });
});

it('los objetos sin rol válido no rompen la validación', () => {
  const objects: SceneObject[] = [];
  expect(validateScene(Scene.parse({ schema: 2, objects }), () => null)).toEqual([]);
});
