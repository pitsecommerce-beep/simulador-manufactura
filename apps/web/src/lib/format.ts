const nf = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 3 });

/** Formatea un número con unidad. Devuelve null si el dato no está publicado. */
export function fmt(value: number | null | undefined, unit = ''): string | null {
  if (value == null) return null;
  return `${nf.format(value)}${unit ? ` ${unit}` : ''}`;
}
