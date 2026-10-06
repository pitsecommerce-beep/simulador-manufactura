import { Scene, emptyScene } from '@sim/domain';
import { describe, expect, it } from 'vitest';
import {
  addObject,
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
