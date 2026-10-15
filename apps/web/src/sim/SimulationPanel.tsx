import type { ProcessIssue, RunConfig, SimMetric, SimRun } from '@sim/domain';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Message, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';
import { useApp } from '../lib/context';
import { NumberField } from '../editor/fields';
import { RunCompare } from './RunCompare';
import { RunResults } from './RunResults';
import { agg, num } from './format';

type Detail = { run: SimRun; metrics: SimMetric[] };

const STATUS: Record<SimRun['status'], [string, string]> = {
  queued: ['En cola', 'bg-slate-100 text-slate-700'],
  running: ['Simulando', 'bg-brand-50 text-brand-700'],
  succeeded: ['Terminada', 'bg-emerald-50 text-emerald-700'],
  failed: ['Falló', 'bg-red-50 text-red-700'],
  cancelled: ['Cancelada', 'bg-slate-100 text-slate-500'],
};

/** Corridas del motor de línea: lanzar, seguir, ver resultados, comparar y reproducir. */
export function SimulationPanel({
  projectId,
  canEdit,
  dirty,
  flowErrors,
  onPlay,
}: {
  projectId: string;
  canEdit: boolean;
  dirty: boolean;
  flowErrors: number;
  onPlay: (run: SimRun) => void;
}) {
  const { api } = useApp();
  const [runs, setRuns] = useState<SimRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ProcessIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<
    { kind: 'run'; id: string } | { kind: 'compare'; ids: [string, string] } | null
  >(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [form, setForm] = useState({
    name: '',
    horizon_h: 8 as number | null,
    warmup_h: 0.5 as number | null,
    replications: 10 as number | null,
    seed: 1 as number | null,
    demand_per_hour: null as number | null,
  });

  const refresh = useCallback(() => {
    api
      .listRuns(projectId)
      .then((r) => setRuns(r.runs))
      .catch((e: Error) => setError(e.message));
  }, [api, projectId]);
  useEffect(refresh, [refresh]);

  // Mientras haya corridas en curso, se consulta cada 3 s.
  const active = runs?.some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [active, refresh]);

  // Carga el detalle de lo que se está viendo (y lo recarga cuando la corrida termina).
  const viewIds = view ? (view.kind === 'run' ? [view.id] : view.ids) : [];
  const statusKey = viewIds.map((id) => runs?.find((r) => r.id === id)?.status).join(',');
  const viewKey = viewIds.join(',');
  useEffect(() => {
    if (!viewKey) return;
    for (const id of viewKey.split(',')) {
      api
        .getRun(projectId, id)
        .then((d) => setDetails((x) => ({ ...x, [id]: d })))
        .catch((e: Error) => setError(e.message));
    }
  }, [api, projectId, viewKey, statusKey]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues([]);
    const { name, horizon_h, warmup_h, replications, seed, demand_per_hour } = form;
    if (horizon_h == null || warmup_h == null || replications == null || seed == null) {
      setError('Completa horizonte, calentamiento, réplicas y semilla.');
      return;
    }
    const config: RunConfig = {
      name: name.trim() || `Corrida ${(runs?.length ?? 0) + 1}`,
      horizon_h,
      warmup_h,
      replications,
      seed,
      demand_per_hour,
    };
    setBusy(true);
    try {
      const { run } = await api.createRun(projectId, config);
      setRuns((r) => [run, ...(r ?? [])]);
      setView({ kind: 'run', id: run.id });
      setForm((f) => ({ ...f, name: '' }));
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError) setIssues(err.issues);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const blocked = dirty
    ? 'Guarda el layout antes de simular: el motor usa la versión guardada.'
    : flowErrors > 0
      ? `Corrige los ${flowErrors} errores del flujo antes de simular.`
      : null;
  const togglePick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  return (
    <section className="card space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Simulación de la línea</h3>
        <span className="text-xs text-slate-500">
          Motor de eventos discretos (SimPy). Resultados estimados, no garantías.
        </span>
      </div>

      {canEdit && (
        <form
          onSubmit={submit}
          className="grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-3 lg:grid-cols-7"
        >
          <label className="text-xs font-medium text-slate-600 sm:col-span-3 lg:col-span-2">
            Nombre
            <input
              className="input mt-1 px-2.5 py-1.5"
              placeholder={`Corrida ${(runs?.length ?? 0) + 1}`}
              value={form.name}
              maxLength={200}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <NumberField
            label="Horizonte"
            unit="h"
            value={form.horizon_h}
            min={0.1}
            max={10000}
            step={0.5}
            onChange={(v) => setForm((f) => ({ ...f, horizon_h: v }))}
          />
          <NumberField
            label="Calentamiento"
            unit="h"
            value={form.warmup_h}
            min={0}
            max={10000}
            step={0.5}
            onChange={(v) => setForm((f) => ({ ...f, warmup_h: v }))}
          />
          <NumberField
            label="Réplicas"
            value={form.replications}
            min={1}
            max={10000}
            onChange={(v) => setForm((f) => ({ ...f, replications: v }))}
          />
          <NumberField
            label="Semilla"
            value={form.seed}
            min={0}
            max={2147483647}
            onChange={(v) => setForm((f) => ({ ...f, seed: v }))}
          />
          <NumberField
            label="Demanda (opcional)"
            unit="u/h"
            value={form.demand_per_hour}
            min={0.001}
            required={false}
            placeholder="para el takt"
            onChange={(v) => setForm((f) => ({ ...f, demand_per_hour: v }))}
          />
          <div className="flex flex-col justify-end gap-1 sm:col-span-3 lg:col-span-7 lg:flex-row lg:items-center lg:justify-between">
            <span className="text-xs text-slate-500">
              {blocked ?? 'Misma semilla y mismo layout dan los mismos resultados.'}
            </span>
            <button className="btn btn-primary" disabled={busy || !!blocked}>
              {busy && <Spinner />}
              Simular
            </button>
          </div>
        </form>
      )}

      {error && (
        <Message kind="error">
          {error}
          {issues.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {issues.map((i, k) => (
                <li key={k}>{i.message}</li>
              ))}
            </ul>
          )}
        </Message>
      )}

      {runs === null ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Cargando corridas…
        </p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-slate-500">Aún no hay corridas.</p>
      ) : (
        <div className="space-y-2">
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {runs.map((r) => {
              const [label, style] = STATUS[r.status];
              const th = details[r.id]
                ? agg(details[r.id]!.metrics, 'throughput_per_hour')
                : undefined;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  {r.status === 'succeeded' && (
                    <input
                      type="checkbox"
                      aria-label={`Comparar ${r.name}`}
                      checked={picked.includes(r.id)}
                      onChange={() => togglePick(r.id)}
                    />
                  )}
                  <button
                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    onClick={() => setView({ kind: 'run', id: r.id })}
                  >
                    {r.name ?? 'Sin nombre'}
                  </button>
                  <span className={`badge ${style}`}>{label}</span>
                  {r.status === 'running' && r.progress != null && (
                    <span
                      className="h-1.5 w-24 overflow-hidden rounded bg-slate-200"
                      aria-label={`Progreso ${Math.round(r.progress * 100)} %`}
                    >
                      <span
                        className="block h-full rounded bg-brand-600"
                        style={{ width: `${r.progress * 100}%` }}
                      />
                    </span>
                  )}
                  {th && (
                    <span className="text-xs text-slate-500 tabular-nums">
                      {num(th.mean, 'u/h')}
                    </span>
                  )}
                  <span className="text-xs text-slate-400">
                    {new Date(r.created_at).toLocaleString('es-MX')}
                  </span>
                  {r.status === 'succeeded' && r.events_path && (
                    <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => onPlay(r)}>
                      ▶ Reproducir
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {picked.length === 2 && (
            <button
              className="btn btn-secondary py-1.5"
              onClick={() => setView({ kind: 'compare', ids: [picked[0]!, picked[1]!] })}
            >
              Comparar las 2 corridas seleccionadas
            </button>
          )}
        </div>
      )}

      {view?.kind === 'run' &&
        (() => {
          const d = details[view.id];
          const r = runs?.find((x) => x.id === view.id) ?? d?.run;
          if (!r) return null;
          return (
            <div className="space-y-3 border-t border-slate-200 pt-4">
              <h4 className="font-semibold">{r.name}</h4>
              {r.status === 'failed' ? (
                <Message kind="error">{r.error ?? 'La corrida falló.'}</Message>
              ) : r.status !== 'succeeded' ? (
                <p className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner /> {r.status === 'queued' ? 'En cola en el motor…' : 'Simulando…'}
                </p>
              ) : d ? (
                <RunResults run={d.run} metrics={d.metrics} />
              ) : (
                <p className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner /> Cargando resultados…
                </p>
              )}
            </div>
          );
        })()}
      {view?.kind === 'compare' && details[view.ids[0]] && details[view.ids[1]] && (
        <div className="space-y-3 border-t border-slate-200 pt-4">
          <h4 className="font-semibold">Comparación</h4>
          <RunCompare a={details[view.ids[0]]!} b={details[view.ids[1]]!} />
        </div>
      )}
    </section>
  );
}
