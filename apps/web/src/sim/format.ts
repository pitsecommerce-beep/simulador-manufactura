import { METRIC_INFO, type SimMetric, type StationState } from '@sim/domain';

/** Colores de estado de estación (mismos en el lienzo, la leyenda y las barras). */
export const STATE_COLOR: Record<StationState, string> = {
  busy: '#10b981',
  blocked: '#f59e0b',
  idle: '#cbd5e1',
  failed: '#ef4444',
};
export const STATE_LABEL: Record<StationState, string> = {
  busy: 'Ocupada',
  blocked: 'Bloqueada',
  idle: 'En espera',
  failed: 'En falla',
};

const nf = (digits: number) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: digits });

/** Número con precisión acorde a su magnitud. null = sin dato. */
export function num(v: number | null | undefined, unit?: string | null): string {
  if (v == null || !Number.isFinite(v)) return 'sin dato';
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  const s = nf(digits).format(v);
  if (!unit) return s;
  return unit === '%' ? `${s} %` : `${s} ${unit}`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Métrica agregada (todas las réplicas). */
export function agg(metrics: SimMetric[], metric: string, scope = 'line'): SimMetric | undefined {
  return metrics.find((m) => m.metric === metric && m.scope === scope && m.replication == null);
}

export const metricLabel = (m: string) => METRIC_INFO[m]?.label ?? m;
