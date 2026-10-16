import {
  robotModelFromDetail,
  type CatalogComponent,
  type RobotModel,
  type SimRun,
} from '@sim/domain';
import { useState } from 'react';
import { Message, Spinner } from '../components/ui';
import { useApp } from '../lib/context';
import { buildAnimation, type AnimationData } from './animation';
import { TelemetryPanel } from './TelemetryPanel';

/**
 * Gráficas de los robots de una corrida terminada. Se reconstruyen del registro de eventos y
 * de la escena guardados en la corrida, así que se ven igual en cualquier momento.
 */
export function RobotCharts({ projectId, run }: { projectId: string; run: SimRun }) {
  const { api } = useApp();
  const [data, setData] = useState<AnimationData | null>(null);
  const [t, setT] = useState(0);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setState('loading');
    setError(null);
    try {
      const [{ run: full }, log, comps] = await Promise.all([
        api.getRun(projectId, run.id),
        api.getRunEvents(projectId, run.id),
        api.listComponents().catch(() => ({ components: [] as CatalogComponent[] })),
      ]);
      const scene = full.input?.scene;
      if (!scene) throw new Error('La corrida no guarda la escena simulada.');
      const slugs = [
        ...new Set(
          scene.objects.flatMap((o) => (o.kind === 'robot' ? [o.params.variant_slug] : [])),
        ),
      ];
      const models = new Map<string, RobotModel>();
      await Promise.all(
        slugs.map((s) =>
          api
            .getCatalogVariant(s)
            .then((d) => models.set(s, robotModelFromDetail(d)))
            .catch(() => {}),
        ),
      );
      const anim = buildAnimation(
        scene,
        log,
        (slug) => models.get(slug),
        new Map(comps.components.map((c) => [c.slug, c])),
      );
      setData(anim);
      setT(log.start_s);
      setState('idle');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  }

  if (!run.events_path) return null;
  return (
    <section className="space-y-2 rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-sm font-semibold">Robots: ejes, garra y estados</h5>
        {!data && (
          <button
            className="btn btn-secondary px-2.5 py-1 text-xs"
            onClick={load}
            disabled={state === 'loading'}
          >
            {state === 'loading' && <Spinner />}
            Ver gráficas de los robots
          </button>
        )}
      </div>
      {error && <Message kind="error">{error}</Message>}
      {data && <TelemetryPanel data={data} t={t} onSeek={setT} />}
    </section>
  );
}
