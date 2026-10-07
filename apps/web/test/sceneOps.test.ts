import { Scene, emptyScene } from '@sim/domain';
import { describe, expect, it } from 'vitest';
import {
  addObject,
  addRoute,
  setRole,
  type NewObject,
  duplicateObject,
  palletPreset,
  PALLET_HEIGHT_HINT,
  removeObject,
  snap,
  updateObject,
} from '../src/editor/sceneOps';

describe('operaciones de escena', () => {
  it('añade objetos válidos con nombres únicos', () => {
    let s = emptyScene();
    ({ scene: s } = addObject(s, { kind: 'box' }));
    ({ scene: s } = addObject(s, { kind: 'box' }));
    ({ scene: s } = addObject(s, {
      kind: 'robot',
      variant_slug: 'irb-1300-7-1-4',
      label: 'IRB 1300-7/1.4',
    }));
    expect(s.objects.map((o) => o.name)).toEqual(['Caja 1', 'Caja 2', 'IRB 1300-7/1.4 1']);
    expect(Scene.safeParse(s).success).toBe(true);
  });

  it('al borrar un robot se limpian las referencias "atendido por"', () => {
    const { scene: s1, id: robotId } = addObject(emptyScene(), {
      kind: 'robot',
      variant_slug: 'x',
      label: 'R',
    });
    const { scene: s2, id: boxId } = addObject(s1, { kind: 'box' });
    let s = updateObject(s2, boxId, (o) => ({ ...o, served_by: robotId }));
    s = removeObject(s, robotId);
    expect(s.objects).toHaveLength(1);
    expect(s.objects[0]!.served_by).toBeNull();
  });

  it('duplica con id y nombre nuevos', () => {
    const { scene, id } = addObject(emptyScene(), { kind: 'table' });
    const d = duplicateObject(scene, id);
    expect(d.scene.objects).toHaveLength(2);
    expect(d.id).not.toBe(id);
    expect(d.scene.objects[1]!.name).toBe('Mesa 2');
  });

  it('pallets: solo el EUR trae altura; los demás quedan vacíos y la ayuda no es un dato', () => {
    expect(palletPreset('eur').height_mm).toBe(144);
    expect(palletPreset('gma')).toEqual({ length_mm: 1219, width_mm: 1016, height_mm: null });
    expect(palletPreset('1200x1000').height_mm).toBeNull();
    expect(palletPreset('custom').length_mm).toBeNull();
    expect(PALLET_HEIGHT_HINT).toBe('EUR publicado: 144 mm');
  });

  it('ajusta a la cuadrícula', () => {
    expect(snap(1234, 50)).toBe(1250);
    expect(snap(1234, 0)).toBe(1234);
  });
});

describe('proceso en el editor', () => {
  const build = () => {
    let s = emptyScene();
    const ids: Record<string, string> = {};
    for (const [key, spec] of [
      ['banda', { kind: 'conveyor' }],
      ['robot', { kind: 'robot', variant_slug: 'irb-1300-7-1-4', label: 'IRB' }],
      ['pallet', { kind: 'pallet', preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 }],
    ] as const) {
      const r = addObject(s, spec as NewObject);
      s = r.scene;
      ids[key] = r.id;
    }
    return { s, ids };
  };

  it('asigna roles sin valores por defecto y conecta rutas válidas', () => {
    const { s: s0, ids } = build();
    let s = setRole(s0, ids.banda!, 'source');
    s = setRole(s, ids.robot!, 'station');
    s = setRole(s, ids.pallet!, 'sink');
    const station = s.process.nodes.find((n) => n.object_id === ids.robot);
    expect(station).toMatchObject({ role: 'station', cycle: null, failures: null, scrap: null });
    expect(s.process.nodes.find((n) => n.role === 'sink')).toMatchObject({
      units_per_pallet: null,
    });
    s = addRoute(s, ids.banda!, ids.robot!)!;
    s = addRoute(s, ids.robot!, ids.pallet!)!;
    expect(s.process.routes).toHaveLength(2);
    // No se conecta hacia una fuente, desde una salida, ni dos veces la misma ruta.
    expect(addRoute(s, ids.robot!, ids.banda!)).toBeNull();
    expect(addRoute(s, ids.pallet!, ids.robot!)).toBeNull();
    expect(addRoute(s, ids.banda!, ids.robot!)).toBeNull();
    expect(Scene.safeParse(s).success).toBe(true);
  });

  it('borrar un objeto quita su nodo y sus rutas; quitar el rol también', () => {
    const { s: s0, ids } = build();
    let s = setRole(
      setRole(setRole(s0, ids.banda!, 'source'), ids.robot!, 'station'),
      ids.pallet!,
      'sink',
    );
    s = addRoute(addRoute(s, ids.banda!, ids.robot!)!, ids.robot!, ids.pallet!)!;
    const removed = removeObject(s, ids.robot!);
    expect(removed.process.nodes.map((n) => n.object_id)).not.toContain(ids.robot);
    expect(removed.process.routes).toEqual([]);
    const unroled = setRole(s, ids.pallet!, null);
    expect(unroled.process.routes.map((r) => r.to)).not.toContain(ids.pallet);
  });

  it('el gripper se monta en el robot y queda suelto si el robot se borra', () => {
    const { s: s0, ids } = build();
    const { scene: s, id } = addObject(s0, {
      kind: 'gripper',
      component_slug: 'onrobot-2fg7',
      label: '2FG7',
      mounted_on: ids.robot!,
    });
    expect(s.objects.find((o) => o.id === id)).toMatchObject({
      params: { mounted_on: ids.robot, component_slug: 'onrobot-2fg7' },
    });
    const after = removeObject(s, ids.robot!);
    expect(after.objects.find((o) => o.id === id)).toMatchObject({ params: { mounted_on: null } });
  });

  it('valla y zona de seguridad con medidas editables', () => {
    let s = emptyScene();
    ({ scene: s } = addObject(s, { kind: 'fence' }));
    ({ scene: s } = addObject(s, { kind: 'safety_zone' }));
    expect(s.objects.map((o) => o.name)).toEqual(['Valla 1', 'Zona de seguridad 1']);
    expect(Scene.safeParse(s).success).toBe(true);
  });
});
