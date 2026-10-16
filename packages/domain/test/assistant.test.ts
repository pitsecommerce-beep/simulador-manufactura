import { describe, expect, it } from 'vitest';
import { enforceAssistantOrigins, mergeScenes, Scene, validateProcess } from '../src/index.ts';

const fixed = (value: number, origin: string) => ({
  dist: { type: 'fixed', value },
  origin,
  note: null,
});

const line = (prefix = '') =>
  Scene.parse({
    schema: 2,
    objects: [
      {
        id: `${prefix}b`,
        name: 'Banda',
        kind: 'conveyor',
        position: [0, 0],
        color: '#475569',
        params: { length_mm: 2000, width_mm: 500, height_mm: 800 },
      },
      {
        id: `${prefix}r`,
        name: 'Robot',
        kind: 'robot',
        position: [1500, 800],
        color: '#f97316',
        params: { variant_slug: 'irb-1300-7-1-4' },
      },
      {
        id: `${prefix}g`,
        name: 'Gripper',
        kind: 'gripper',
        position: [1500, 800],
        color: '#64748b',
        params: { component_slug: 'onrobot-2fg7', mounted_on: `${prefix}r` },
      },
      {
        id: `${prefix}p`,
        name: 'Pallet',
        kind: 'pallet',
        position: [3000, 0],
        color: '#c08a4a',
        served_by: `${prefix}r`,
        params: { preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 },
      },
    ],
    process: {
      product: { name: 'Caja', bom: [] },
      nodes: [
        { role: 'source', object_id: `${prefix}b`, item: 'Caja', interarrival: fixed(10, 'user') },
        { role: 'station', object_id: `${prefix}r`, cycle: fixed(6, 'catalog') },
        { role: 'sink', object_id: `${prefix}p`, units_per_pallet: 40 },
      ],
      routes: [
        { id: 'r1', from: `${prefix}b`, to: `${prefix}r` },
        { id: 'r2', from: `${prefix}r`, to: `${prefix}p` },
      ],
    },
  });

describe('reglas de origen del asistente', () => {
  it('marca como supuesto del asistente lo que no viene de la ficha', () => {
    const { scene, notes } = enforceAssistantOrigins(line(), () => [
      { value_s: 5.5, note: 'ciclo 25-305-25 mm' },
    ]);
    const [src, st] = scene.process.nodes;
    expect(src?.role === 'source' && src.interarrival?.origin).toBe('assistant');
    // 6 s no está publicado: no puede quedar como dato de ficha.
    expect(st?.role === 'station' && st.cycle?.origin).toBe('assistant');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Robot: el ciclo no coincide/);
  });

  it('conserva un ciclo de ficha que coincide con el publicado y le pone su condición', () => {
    const { scene, notes } = enforceAssistantOrigins(line(), () => [
      { value_s: 6, note: 'ciclo 25-305-25 mm' },
    ]);
    const st = scene.process.nodes[1];
    expect(st?.role === 'station' && st.cycle).toMatchObject({
      origin: 'catalog',
      note: 'ciclo 25-305-25 mm',
    });
    expect(notes).toEqual([]);
  });
});

describe('fusionar una propuesta', () => {
  it('renombra ids repetidos y sus referencias, y conserva el producto actual', () => {
    const base = line();
    const proposal = {
      ...line(),
      process: { ...line().process, product: { name: 'Otro', bom: [] } },
    };
    const merged = mergeScenes(base, proposal);
    expect(merged.objects.map((o) => o.id)).toEqual([
      'b',
      'r',
      'g',
      'p',
      'b-2',
      'r-2',
      'g-2',
      'p-2',
    ]);
    const g2 = merged.objects.find((o) => o.id === 'g-2');
    expect(g2?.kind === 'gripper' && g2.params.mounted_on).toBe('r-2');
    expect(merged.objects.find((o) => o.id === 'p-2')?.served_by).toBe('r-2');
    expect(merged.process.product.name).toBe('Caja');
    expect(merged.process.routes.map((r) => [r.id, r.from, r.to])).toEqual([
      ['r1', 'b', 'r'],
      ['r2', 'r', 'p'],
      ['r1-2', 'b-2', 'r-2'],
      ['r2-2', 'r-2', 'p-2'],
    ]);
    // La escena fusionada es válida y su proceso no tiene errores.
    expect(() => Scene.parse(merged)).not.toThrow();
    const issues = validateProcess(merged.process, {
      objects: merged.objects.map((o) => ({ id: o.id, kind: o.kind, name: o.name })),
    });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('sobre una escena vacía toma el producto de la propuesta', () => {
    const empty = Scene.parse({});
    const merged = mergeScenes(empty, line('x'));
    expect(merged.objects.map((o) => o.id)).toEqual(['xb', 'xr', 'xg', 'xp']);
    expect(merged.process.product.name).toBe('Caja');
  });
});
