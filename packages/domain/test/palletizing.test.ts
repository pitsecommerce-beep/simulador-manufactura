import { describe, expect, it } from 'vitest';
import { palletPattern } from '../src/index.ts';

const EUR = { length_mm: 1200, width_mm: 800 };

describe('patrón de paletizado', () => {
  it('elige la orientación que acomoda más unidades por capa', () => {
    // 400 × 300: derecho 3 × 2 = 6; girado 4 × 2 = 8.
    const p = palletPattern(EUR, { length_mm: 400, width_mm: 300, height_mm: 250 }, 20);
    expect(p).toMatchObject({ rotated: true, nx: 4, ny: 2, perLayer: 8, layers: 3, fits: true });
    expect(p.footprint).toEqual({ length_mm: 300, width_mm: 400, height_mm: 250 });
    expect(p.load_height_mm).toBe(750);
    expect(p.slots).toHaveLength(20);
    // Primera unidad en la esquina, centrada en la cuadrícula; la capa 2 empieza a 250 mm.
    expect(p.slots[0]).toEqual([-450, -200, 0]);
    expect(p.slots[8]![2]).toBe(250);
    // Todas las unidades quedan dentro del pallet.
    for (const [x, y] of p.slots) {
      expect(Math.abs(x) + 150).toBeLessThanOrEqual(600);
      expect(Math.abs(y) + 200).toBeLessThanOrEqual(400);
    }
    // Ninguna posición se repite dentro de la misma capa.
    const keys = new Set(p.slots.map((s) => s.join(',')));
    expect(keys.size).toBe(20);
  });

  it('una unidad más grande que el pallet va una por capa y se marca', () => {
    const p = palletPattern(EUR, { length_mm: 1500, width_mm: 900, height_mm: 100 }, 3);
    expect(p).toMatchObject({ fits: false, perLayer: 1, layers: 3 });
    expect(p.slots.map((s) => s[2])).toEqual([0, 100, 200]);
  });

  it('sin unidades no hay capas', () => {
    expect(palletPattern(EUR, { length_mm: 300, width_mm: 200, height_mm: 200 }, 0)).toMatchObject({
      layers: 0,
      slots: [],
    });
  });
});
