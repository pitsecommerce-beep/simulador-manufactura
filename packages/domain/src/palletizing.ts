import type { ProductSize } from './process.ts';
import type { Vec3 } from './validate.ts';

// Patrón de paletizado por capas (PLAN 24.4): columnas en la orientación que más unidades
// acomoda por capa. Las posiciones son el centro de la base de cada unidad, relativas al
// centro de la cara superior del pallet (mm, sin girar).

export interface PalletPattern {
  /** Unidades por capa y su arreglo. */
  perLayer: number;
  nx: number;
  ny: number;
  layers: number;
  /** La unidad va girada 90° (su largo sobre el ancho del pallet). */
  rotated: boolean;
  /** Medidas de la unidad tal como queda en el pallet. */
  footprint: { length_mm: number; width_mm: number; height_mm: number };
  /** Altura de la carga completa. */
  load_height_mm: number;
  /** false si la unidad es más grande que el pallet (se dibuja una por capa, sobresaliendo). */
  fits: boolean;
  slots: Vec3[];
}

export function palletPattern(
  pallet: { length_mm: number; width_mm: number },
  unit: ProductSize,
  count: number,
): PalletPattern {
  const straight = {
    nx: Math.floor(pallet.length_mm / unit.length_mm),
    ny: Math.floor(pallet.width_mm / unit.width_mm),
  };
  const turned = {
    nx: Math.floor(pallet.length_mm / unit.width_mm),
    ny: Math.floor(pallet.width_mm / unit.length_mm),
  };
  const rotated = turned.nx * turned.ny > straight.nx * straight.ny;
  const g = rotated ? turned : straight;
  const fits = g.nx * g.ny > 0;
  const nx = fits ? g.nx : 1;
  const ny = fits ? g.ny : 1;
  const perLayer = nx * ny;
  const l = rotated ? unit.width_mm : unit.length_mm;
  const w = rotated ? unit.length_mm : unit.width_mm;
  const n = Math.max(0, Math.floor(count));
  const layers = Math.ceil(n / perLayer);
  const slots: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const layer = Math.floor(k / perLayer);
    const i = k % perLayer;
    // Cada capa empieza por la esquina opuesta para alternar (como un patrón cruzado simple).
    const ix = i % nx;
    const iy = Math.floor(i / nx);
    const fx = layer % 2 ? nx - 1 - ix : ix;
    slots.push([(fx - (nx - 1) / 2) * l, (iy - (ny - 1) / 2) * w, layer * unit.height_mm]);
  }
  return {
    perLayer,
    nx,
    ny,
    layers,
    rotated,
    footprint: { length_mm: l, width_mm: w, height_mm: unit.height_mm },
    load_height_mm: layers * unit.height_mm,
    fits,
    slots,
  };
}
