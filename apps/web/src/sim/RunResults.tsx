import { type SimMetric, type SimRun, type StationState } from '@sim/domain';
import { agg, metricLabel, num, STATE_COLOR, STATE_LABEL } from './format';

export function EstimateNotice() {
  return (
    <p
      role="note"
      className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
    >
      <strong>Resultados estimados</strong> con supuestos y datos de ficha técnica. No son garantías
      de rendimiento ni réplicas de RobotStudio.
    </p>
  );
}

function Tile({ m, label, hint }: { m: SimMetric | undefined; label?: string; hint?: string }) {
  const name = label ?? (m ? metricLabel(m.metric) : '');
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{name}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">
        {m ? num(m.mean, m.unit) : (hint ?? 'sin dato')}
      </p>
      {m && m.min != null && (
        <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
          mín {num(m.min)} · máx {num(m.max)}
          {m.ci_low != null && ` · IC 95 % ${num(m.ci_low)} a ${num(m.ci_high)}`}
        </p>
      )}
    </div>
  );
}

const STATES: StationState[] = ['busy', 'blocked', 'idle', 'failed'];
const STATE_METRIC: Record<StationState, string> = {
  busy: 'busy',
  blocked: 'blocked',
  idle: 'starved',
  failed: 'failed',
};

/** Barra apilada de estados de una estación (con separación de 2 px y fin redondeado). */
function StateBar({ values }: { values: Record<StationState, number> }) {
  return (
    <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded" aria-hidden>
      {STATES.filter((s) => values[s] > 0.05).map((s) => (
        <div
          key={s}
          title={`${STATE_LABEL[s]}: ${num(values[s], '%')}`}
          style={{ width: `${values[s]}%`, background: STATE_COLOR[s] }}
          className="first:rounded-l last:rounded-r"
        />
      ))}
    </div>
  );
}

export function StateLegend() {
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-slate-600">
      {STATES.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: STATE_COLOR[s] }} />
          {STATE_LABEL[s]}
        </li>
      ))}
    </ul>
  );
}

export function RunResults({ run, metrics }: { run: SimRun; metrics: SimMetric[] }) {
  const cfg = run.input?.config;
  const summary = run.summary;
  const stations = run.input?.model.nodes.filter((n) => n.role === 'station') ?? [];
  const buffers = run.input?.model.nodes.filter((n) => n.role === 'buffer') ?? [];
  const reps = metrics
    .filter((m) => m.metric === 'throughput_per_hour' && m.replication != null)
    .sort((a, b) => a.replication! - b.replication!);
  const bottleneck = summary?.bottleneck?.node;

  return (
    <div className="space-y-4">
      <EstimateNotice />
      {cfg && (
        <p className="text-xs text-slate-500">
          {cfg.replications} réplicas · horizonte {cfg.horizon_h} h · calentamiento {cfg.warmup_h} h
          · semilla {cfg.seed}
          {run.layout_version != null && ` · layout v${run.layout_version}`}
          {run.engine_version && ` · ${run.engine_version}`}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Tile m={agg(metrics, 'throughput_per_hour')} />
        <Tile m={agg(metrics, 'total_output')} />
        <Tile m={agg(metrics, 'line_cycle_time_s')} />
        <Tile
          m={undefined}
          label="Takt time"
          hint={summary?.takt_time_s != null ? num(summary.takt_time_s, 's/u') : 'requiere demanda'}
        />
        <Tile m={agg(metrics, 'flow_time_s')} />
        <Tile m={agg(metrics, 'wip_avg')} />
        <Tile m={agg(metrics, 'oee')} label="OEE de la línea" />
        <Tile m={agg(metrics, 'scrap_units')} />
        <Tile m={agg(metrics, 'pallets_completed')} />
      </div>

      {summary?.takt_time_s != null &&
        agg(metrics, 'line_cycle_time_s')?.mean != null &&
        agg(metrics, 'line_cycle_time_s')!.mean! > summary.takt_time_s && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <strong>No alcanza la demanda:</strong> el tiempo de ciclo de la línea (
            {num(agg(metrics, 'line_cycle_time_s')!.mean, 's/u')}) es mayor que el takt (
            {num(summary.takt_time_s, 's/u')}).
          </p>
        )}
      {summary?.bottleneck && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-900">
          <strong>Cuello de botella:</strong> {summary.bottleneck.name} (ocupada o en falla{' '}
          {num(summary.bottleneck.busy_failed * 100, '%')} del tiempo)
          {summary.bottleneck.second &&
            `. Le sigue ${summary.bottleneck.second.name} con ${num(summary.bottleneck.second.busy_failed * 100, '%')}.`}
        </p>
      )}

      {stations.length > 0 && (
        <div className="overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">Por estación (promedio de réplicas)</h4>
            <StateLegend />
          </div>
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1.5">Estación</th>
                <th className="w-48 py-1.5">Estados</th>
                {['Ocupada', 'Bloqueada', 'En espera', 'En falla', 'OEE', 'Scrap'].map((h) => (
                  <th key={h} className="py-1.5 text-right">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stations.map((s) => {
                const v = (metric: string) => agg(metrics, metric, s.object_id)?.mean ?? 0;
                const values = Object.fromEntries(
                  STATES.map((st) => [st, v(STATE_METRIC[st])]),
                ) as Record<StationState, number>;
                return (
                  <tr
                    key={s.object_id}
                    className={s.object_id === bottleneck ? 'bg-red-50/60' : ''}
                  >
                    <td className="py-2 pr-3 font-medium">
                      {s.name}
                      {s.object_id === bottleneck && (
                        <span className="ml-2 badge bg-red-100 text-red-700">
                          cuello de botella
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <StateBar values={values} />
                    </td>
                    {STATES.map((st) => (
                      <td key={st} className="py-2 text-right tabular-nums">
                        {num(values[st], '%')}
                      </td>
                    ))}
                    <td className="py-2 text-right tabular-nums">{num(v('oee'), '%')}</td>
                    <td className="py-2 text-right tabular-nums">{num(v('scrap_units'))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {buffers.length > 0 && (
        <p className="text-sm text-slate-600">
          Ocupación promedio de buffers:{' '}
          {buffers
            .map((b) => `${b.name} ${num(agg(metrics, 'buffer_avg', b.object_id)?.mean, 'u')}`)
            .join(' · ')}
        </p>
      )}

      {reps.length > 1 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-600">Producción por réplica</summary>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {reps.map((r) => `#${r.replication! + 1}: ${num(r.value, 'u/h')}`).join(' · ')}
          </p>
        </details>
      )}

      {(summary?.assumptions?.length ?? 0) > 0 && (
        <div className="text-sm">
          <h4 className="font-semibold">Supuestos usados</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
            {summary!.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {(summary?.notes?.length ?? 0) > 0 && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">Cómo calcula el motor</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {summary!.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      {run.input && run.input.config.demand_per_hour == null && (
        <p className="text-xs text-slate-500">
          Takt time: requiere la demanda (unidades/h). Captúrala en la próxima corrida para
          compararlo con el tiempo de ciclo.
        </p>
      )}
    </div>
  );
}
