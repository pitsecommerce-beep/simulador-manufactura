import { METRIC_INFO, type SimMetric, type SimRun } from '@sim/domain';
import { agg, num } from './format';
import { EstimateNotice } from './RunResults';

const LINE_METRICS = [
  'throughput_per_hour',
  'total_output',
  'line_cycle_time_s',
  'flow_time_s',
  'wip_avg',
  'oee',
  'scrap_units',
  'pallets_completed',
];

/** ¿Los intervalos de confianza se solapan? Si sí, la diferencia no es concluyente. */
function overlap(a: SimMetric, b: SimMetric): boolean | null {
  if (a.ci_low == null || a.ci_high == null || b.ci_low == null || b.ci_high == null) return null;
  return a.ci_low <= b.ci_high && b.ci_low <= a.ci_high;
}

export function RunCompare({
  a,
  b,
}: {
  a: { run: SimRun; metrics: SimMetric[] };
  b: { run: SimRun; metrics: SimMetric[] };
}) {
  return (
    <div className="space-y-3">
      <EstimateNotice />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-1.5">Indicador</th>
              <th className="py-1.5 text-right">A · {a.run.name}</th>
              <th className="py-1.5 text-right">B · {b.run.name}</th>
              <th className="py-1.5 text-right">B − A</th>
              <th className="py-1.5 pl-3">Lectura</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {LINE_METRICS.map((metric) => {
              const ma = agg(a.metrics, metric);
              const mb = agg(b.metrics, metric);
              if (!ma && !mb) return null;
              const info = METRIC_INFO[metric];
              const diff = ma?.mean != null && mb?.mean != null ? mb.mean - ma.mean : null;
              const ov = ma && mb ? overlap(ma, mb) : null;
              const better =
                diff == null || diff === 0 || !info?.better
                  ? null
                  : diff > 0 === (info.better === 'up');
              return (
                <tr key={metric}>
                  <td className="py-2 pr-3">{info?.label ?? metric}</td>
                  <td className="py-2 text-right tabular-nums">{num(ma?.mean, ma?.unit)}</td>
                  <td className="py-2 text-right tabular-nums">{num(mb?.mean, mb?.unit)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {diff == null ? 'sin dato' : `${diff > 0 ? '+' : ''}${num(diff, ma?.unit)}`}
                  </td>
                  <td className="py-2 pl-3 text-xs">
                    {ov === true ? (
                      <span className="text-slate-500">
                        Diferencia no concluyente (los intervalos se solapan)
                      </span>
                    ) : ov === false && better != null ? (
                      <span className={better ? 'text-emerald-700' : 'text-red-700'}>
                        {better ? 'B mejora' : 'B empeora'}
                      </span>
                    ) : diff === 0 ? (
                      <span className="text-slate-500">Igual</span>
                    ) : (
                      <span className="text-slate-500">Sin intervalo (pocas réplicas)</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        La lectura usa el intervalo de confianza al 95 % de la media de cada corrida. Con una sola
        réplica no hay intervalo.
      </p>
    </div>
  );
}
