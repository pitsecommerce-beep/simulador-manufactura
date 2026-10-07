import { describe, expect, it } from 'vitest';
import {
  compileProcess,
  createPlayback,
  frameAt,
  modelAssumptions,
  RunConfig,
  Scene,
  type EventLog,
} from '../src/index.ts';

const fixed = (value: number, origin = 'user') => ({
  dist: { type: 'fixed', value },
  origin,
  note: null,
});
const base = { elevation: 0, rotation_deg: 0, served_by: null, color: '#123456' };
const scene = Scene.parse({
  schema: 2,
  objects: [
    {
      ...base,
      id: 'b',
      name: 'Banda',
      kind: 'conveyor',
      position: [0, 0],
      params: { length_mm: 2000, width_mm: 500, height_mm: 800 },
    },
    {
      ...base,
      id: 'r',
      name: 'Robot',
      kind: 'robot',
      position: [1000, 0],
      params: { variant_slug: 'irb', joints: [] },
    },
    {
      ...base,
      id: 'p',
      name: 'Pallet',
      kind: 'pallet',
      position: [2000, 0],
      params: { preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 },
    },
  ],
  process: {
    product: { name: 'Caja', bom: [] },
    nodes: [
      { role: 'source', object_id: 'b', item: 'Caja', interarrival: fixed(10) },
      {
        role: 'station',
        object_id: 'r',
        cycle: { ...fixed(0.54, 'catalog'), note: '25/305/25 mm' },
      },
      { role: 'sink', object_id: 'p', units_per_pallet: 40 },
    ],
    routes: [
      { id: '1', from: 'b', to: 'r' },
      { id: '2', from: 'r', to: 'p' },
    ],
  },
});

describe('compilación del modelo', () => {
  it('agrega nombre y tipo a cada nodo y lista los supuestos', () => {
    const { model, issues } = compileProcess(scene);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(model!.nodes.map((n) => [n.name, n.kind])).toEqual([
      ['Banda', 'conveyor'],
      ['Robot', 'robot'],
      ['Pallet', 'pallet'],
    ]);
    const a = modelAssumptions(model!);
    expect(a).toContain('Banda: llegadas 10 s (supuesto del usuario)');
    expect(a.join(' ')).toMatch(/Robot: ciclo de la ficha 0.54 s, medido en "25\/305\/25 mm"/);
  });

  it('sin proceso o con errores no hay modelo', () => {
    expect(compileProcess(Scene.parse({ schema: 2, objects: [] })).model).toBeNull();
    const broken = { ...scene, process: { ...scene.process, routes: [] } };
    expect(compileProcess(broken).model).toBeNull();
  });

  it('valida la configuración de la corrida', () => {
    const ok = { name: 'A', horizon_h: 8, warmup_h: 1, replications: 10, seed: 1 };
    expect(RunConfig.parse(ok).demand_per_hour).toBeNull();
    expect(RunConfig.safeParse({ ...ok, warmup_h: 8 }).success).toBe(false);
    expect(RunConfig.safeParse({ ...ok, replications: 0 }).success).toBe(false);
  });
});

describe('reproductor', () => {
  const log: EventLog = {
    start_s: 0,
    end_s: 100,
    replication: 0,
    truncated: false,
    events: [
      [0, 'st', 'r', 'idle'],
      [10, 'at', 1, 'b'],
      [10, 'at', 1, 'r'],
      [10, 'st', 'r', 'busy'],
      [11, 'at', 1, 'p'],
      [11, 'st', 'r', 'idle'],
      [12, 'gone', 1],
      [20, 'st', 'r', 'failed'],
    ],
  };

  it('estado de estaciones y unidades en cada instante, con traslado interpolado', () => {
    const f = frameAt(log, 10.5);
    expect(f.states.get('r')).toBe('busy');
    expect(f.units.get(1)).toEqual(['b', 'r', 0.25]);
    expect(frameAt(log, 11.9).units.get(1)![1]).toBe('p');
    expect(frameAt(log, 12).units.size).toBe(0);
    expect(frameAt(log, 25).states.get('r')).toBe('failed');
  });

  it('el reproductor incremental coincide con frameAt al avanzar y retroceder', () => {
    const p = createPlayback(log);
    for (const t of [0, 10.5, 11.2, 30, 10.5, 5, 12]) {
      expect(p.seek(t)).toEqual(frameAt(log, t));
    }
  });
});
