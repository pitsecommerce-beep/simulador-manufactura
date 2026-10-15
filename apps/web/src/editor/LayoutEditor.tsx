import {
  buildRobotModel,
  componentWeightKg,
  DISCLAIMERS,
  PROPORTIONS_NOTICE,
  SIMPLIFIED_NOTICE,
  validateProcess,
  validateScene,
  type CatalogComponent,
  type EventLog,
  type RobotModel,
  type Scene,
  type SimRun,
} from '@sim/domain';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Message, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';
import { useApp } from '../lib/context';
import { ComponentPicker, PalletForm, RobotPicker } from './dialogs';
import { publishedCycleOptions } from './ProcessSection';
import { ProductCard } from './ProductCard';
import { Properties, type RobotInfo } from './Properties';
import {
  addObject,
  addRoute,
  duplicateObject,
  KIND_LABEL,
  removeObject,
  updateObject,
  type NewObject,
} from './sceneOps';
import { Warnings } from './Warnings';
import { PlayerBar } from '../sim/PlayerBar';
import { SimulationPanel } from '../sim/SimulationPanel';
import { usePlayer } from '../sim/usePlayer';

const Viewport = lazy(() => import('./Viewport'));

type SaveState =
  { kind: 'idle' | 'saving' } | { kind: 'error'; message: string; conflict: boolean };

export default function LayoutEditor({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const { api } = useApp();
  const [scene, setScene] = useState<Scene | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [robots, setRobots] = useState<Record<string, RobotInfo | 'error'>>({});
  const [snapMm, setSnapMm] = useState(50);
  const [adding, setAdding] = useState<'robot' | 'pallet' | 'gripper' | 'sensor' | null>(null);
  const [flowMode, setFlowMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [components, setComponents] = useState<Map<string, CatalogComponent>>(new Map());
  // Reproducción de una corrida: se muestra la escena simulada (foto), no la actual.
  const [playing, setPlaying] = useState<{ run: SimRun; log: EventLog } | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const player = usePlayer(playing?.log ?? null);
  const requested = useRef(new Set<string>());

  const load = useCallback(() => {
    api
      .getLayout(projectId)
      .then((l) => {
        setScene(l.scene);
        setVersion(l.version);
        setDirty(false);
        setSave({ kind: 'idle' });
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [api, projectId]);
  useEffect(load, [load]);

  // Carga la ficha de cada variante de robot presente en la escena.
  useEffect(() => {
    for (const o of scene?.objects ?? []) {
      if (o.kind !== 'robot') continue;
      const slug = o.params.variant_slug;
      if (requested.current.has(slug)) continue;
      requested.current.add(slug);
      api
        .getCatalogVariant(slug)
        .then((detail) => {
          const s = detail.specs;
          const model = buildRobotModel({
            kinematic_type: detail.variant.kinematic_type,
            axes_count: s?.axes_count ?? null,
            reach_mm: s?.reach_mm ?? null,
            workspace_diameter_mm: s?.workspace_diameter_mm ?? null,
            payload_kg: s?.payload_kg ?? null,
            axis_limits: s?.axis_limits ?? null,
          });
          setRobots((r) => ({ ...r, [slug]: { detail, model } }));
        })
        .catch(() => setRobots((r) => ({ ...r, [slug]: 'error' })));
    }
  }, [api, scene]);

  // Componentes del catálogo (pocos): se cargan una vez para validar pesos y mostrar fichas.
  useEffect(() => {
    api
      .listComponents()
      .then((r) => setComponents(new Map(r.components.map((c) => [c.slug, c]))))
      .catch(() => {});
  }, [api]);

  // Aviso al salir con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const models = useMemo(() => {
    const m: Record<string, RobotModel | undefined> = {};
    for (const [slug, info] of Object.entries(robots)) if (info !== 'error') m[slug] = info.model;
    return m;
  }, [robots]);

  const warnings = useMemo(
    () =>
      scene
        ? validateScene(
            scene,
            (slug) => models[slug],
            (slug) => {
              const c = components.get(slug);
              return c
                ? {
                    name: `${c.manufacturer ?? ''} ${c.model}`.trim(),
                    weight_kg: componentWeightKg(c),
                  }
                : null;
            },
          )
        : [],
    [scene, models, components],
  );
  const processIssues = useMemo(() => {
    if (!scene) return [];
    return validateProcess(scene.process, {
      objects: scene.objects.map((o) => ({ id: o.id, kind: o.kind, name: o.name })),
      publishedCycles: (id) => {
        const o = scene.objects.find((x) => x.id === id);
        if (o?.kind !== 'robot') return undefined;
        const info = robots[o.params.variant_slug];
        return info && info !== 'error'
          ? publishedCycleOptions(info.detail).map((c) => c.value_s)
          : undefined;
      },
    });
  }, [scene, robots]);
  const warned = useMemo(
    () =>
      new Set([
        ...warnings.filter((w) => w.level === 'warning').flatMap((w) => w.objects),
        ...processIssues.filter((i) => i.level !== 'info').flatMap((i) => i.objects),
      ]),
    [warnings, processIssues],
  );
  const flowErrors = processIssues.filter((i) => i.level === 'error').length;

  const change = useCallback((fn: (s: Scene) => Scene) => {
    setScene((s) => (s ? fn(s) : s));
    setDirty(true);
  }, []);

  const doSave = useCallback(async () => {
    if (!scene || !canEdit) return;
    setSave({ kind: 'saving' });
    try {
      const saved = await api.saveLayout(projectId, scene, version);
      setVersion(saved.version);
      setDirty(false);
      setSave({ kind: 'idle' });
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      setSave({ kind: 'error', message: (e as Error).message, conflict });
    }
  }, [api, canEdit, projectId, scene, version]);

  // Atajos: Supr borra, Ctrl+S guarda.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, select, textarea');
      if (e.key === 'Escape') {
        setConnectFrom(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) void doSave();
      } else if (
        !typing &&
        canEdit &&
        selectedId &&
        (e.key === 'Delete' || e.key === 'Backspace')
      ) {
        change((s) => removeObject(s, selectedId));
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit, change, dirty, doSave, selectedId]);

  if (!scene)
    return loadError ? (
      <Message kind="error">{loadError}</Message>
    ) : (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Cargando layout…
      </p>
    );

  const selected = scene.objects.find((o) => o.id === selectedId) ?? null;
  const add = (spec: NewObject) => {
    const r = addObject(scene, spec);
    setScene(r.scene);
    setDirty(true);
    setSelectedId(r.id);
    setAdding(null);
  };
  const nWarn = warnings.filter((w) => w.level === 'warning').length;

  // Con "conectar" activo, el clic en otro objeto crea la ruta en lugar de seleccionarlo.
  const handleSelect = (id: string | null) => {
    if (connectFrom && id && id !== connectFrom) {
      const next = addRoute(scene, connectFrom, id);
      const fromName = scene.objects.find((o) => o.id === connectFrom)?.name;
      const toName = scene.objects.find((o) => o.id === id)?.name;
      if (next) {
        setScene(next);
        setDirty(true);
        setNotice(`Ruta creada: ${fromName} → ${toName}.`);
      } else {
        setNotice(
          `No se puede conectar ${fromName} → ${toName}: el destino necesita un rol en el proceso (y no puede ser una fuente), o la ruta ya existe.`,
        );
      }
      setConnectFrom(null);
      setSelectedId(connectFrom);
      return;
    }
    if (connectFrom && id == null) setConnectFrom(null);
    setSelectedId(id);
  };
  const selectedRobot = selected?.kind === 'robot' ? selected : null;

  async function startPlayback(run: SimRun) {
    setPlayError(null);
    try {
      const [{ run: full }, log] = await Promise.all([
        api.getRun(projectId, run.id),
        api.getRunEvents(projectId, run.id),
      ]);
      if (!full.input?.scene) throw new Error('La corrida no guarda la escena simulada.');
      setConnectFrom(null);
      setPlaying({ run: full, log });
      player.setT(log.start_s);
      player.setPlaying(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setPlayError((e as Error).message);
    }
  }
  const viewScene = playing?.run.input?.scene ?? scene;

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center gap-2 p-2">
        {canEdit ? (
          <>
            <button className="btn btn-secondary py-1.5" onClick={() => setAdding('robot')}>
              + Robot
            </button>
            <button className="btn btn-secondary py-1.5" onClick={() => setAdding('pallet')}>
              + Pallet
            </button>
            {(['box', 'table', 'conveyor'] as const).map((k) => (
              <button key={k} className="btn btn-secondary py-1.5" onClick={() => add({ kind: k })}>
                + {KIND_LABEL[k]}
              </button>
            ))}
            <details className="relative">
              <summary className="btn btn-secondary cursor-pointer list-none py-1.5">
                + Más…
              </summary>
              <div className="card absolute z-20 mt-1 flex w-52 flex-col p-1">
                <button
                  className="btn btn-ghost justify-start py-1.5"
                  onClick={() => setAdding('gripper')}
                >
                  Gripper {selectedRobot ? `(en ${selectedRobot.name})` : ''}
                </button>
                <button
                  className="btn btn-ghost justify-start py-1.5"
                  onClick={() => setAdding('sensor')}
                >
                  Sensor
                </button>
                <button
                  className="btn btn-ghost justify-start py-1.5"
                  onClick={() => add({ kind: 'fence' })}
                >
                  Valla
                </button>
                <button
                  className="btn btn-ghost justify-start py-1.5"
                  onClick={() => add({ kind: 'safety_zone' })}
                >
                  Zona de seguridad
                </button>
              </div>
            </details>
          </>
        ) : (
          <span className="px-2 text-sm text-slate-500">Solo lectura: tu rol es lector.</span>
        )}
        <button
          className={`btn py-1.5 ${flowMode ? 'bg-violet-600 text-white hover:bg-violet-700' : 'btn-secondary'}`}
          aria-pressed={flowMode}
          onClick={() => {
            setFlowMode((v) => !v);
            setConnectFrom(null);
          }}
        >
          Flujo
          {flowErrors > 0 && <span className="badge bg-red-100 text-red-700">{flowErrors}</span>}
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            Cuadrícula
            <select
              className="input w-auto px-2 py-1 text-xs"
              value={snapMm}
              onChange={(e) => setSnapMm(Number(e.target.value))}
            >
              <option value={0}>libre</option>
              <option value={10}>10 mm</option>
              <option value={50}>50 mm</option>
              <option value={100}>100 mm</option>
            </select>
          </label>
          <span
            className={`badge ${nWarn ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'}`}
          >
            {nWarn ? `${nWarn} advertencia${nWarn > 1 ? 's' : ''}` : 'Sin advertencias'}
          </span>
          {canEdit && (
            <>
              <span className="text-xs text-slate-500">
                {save.kind === 'saving'
                  ? 'Guardando…'
                  : dirty
                    ? 'Cambios sin guardar'
                    : version
                      ? `Guardado (v${version})`
                      : 'Sin guardar'}
              </span>
              <button
                className="btn btn-primary py-1.5"
                disabled={!dirty || save.kind === 'saving'}
                onClick={doSave}
              >
                {save.kind === 'saving' && <Spinner />}
                Guardar
              </button>
            </>
          )}
        </div>
      </div>

      {save.kind === 'error' && (
        <Message kind="error">
          {save.message}{' '}
          {save.conflict && (
            <button className="link" onClick={load}>
              Recargar el layout guardado
            </button>
          )}
        </Message>
      )}

      {connectFrom && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2 text-sm text-violet-900">
          <span>
            Haz clic en el objeto destino de la ruta desde{' '}
            <strong>{scene.objects.find((o) => o.id === connectFrom)?.name}</strong>.
          </span>
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setConnectFrom(null)}>
            Cancelar (Esc)
          </button>
        </div>
      )}
      {notice && !connectFrom && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700">
          <span>{notice}</span>
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setNotice(null)}>
            Cerrar
          </button>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_18rem]">
        <aside className="card order-2 max-h-[34rem] overflow-y-auto p-3 lg:order-1">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Objetos
          </h3>
          {scene.objects.length === 0 ? (
            <p className="text-sm text-slate-500">
              {canEdit ? 'Añade un robot u objeto con la barra superior.' : 'El layout está vacío.'}
            </p>
          ) : (
            <ul className="space-y-1">
              {scene.objects.map((o) => (
                <li key={o.id}>
                  <button
                    onClick={() => setSelectedId(o.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                      o.id === selectedId ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-100'
                    }`}
                  >
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: o.color }} />
                    <span className="truncate">{o.name}</span>
                    {warned.has(o.id) && (
                      <span className="ml-auto text-amber-600" title="Tiene advertencias">
                        ●
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="relative order-1 h-[26rem] overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 sm:h-[34rem] lg:order-2">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
                <Spinner /> Cargando lienzo 3D…
              </div>
            }
          >
            <Viewport
              scene={viewScene}
              playback={playing ? player.frame : null}
              models={models}
              selectedId={selectedId}
              warned={warned}
              editable={canEdit && !playing}
              snapMm={snapMm}
              flowMode={flowMode || connectFrom != null}
              connectFrom={connectFrom}
              onSelect={handleSelect}
              onMove={(id, position) =>
                change((s) => updateObject(s, id, (o) => ({ ...o, position })))
              }
              onMoveEnd={() => {}}
            />
          </Suspense>
          <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-between gap-2">
            <span className="rounded-lg bg-white/90 px-2.5 py-1 text-[11px] text-slate-600 shadow-sm">
              {SIMPLIFIED_NOTICE}
            </span>
          </div>
          {playing ? (
            <PlayerBar
              log={playing.log}
              name={playing.run.name ?? 'Corrida'}
              t={player.t}
              playing={player.playing}
              speed={player.speed}
              onSeek={(t) => player.setT(t)}
              onToggle={() => player.setPlaying((p) => !p)}
              onSpeed={player.setSpeed}
              onClose={() => {
                player.setPlaying(false);
                setPlaying(null);
              }}
            />
          ) : (
            <div className="pointer-events-none absolute bottom-2 left-2 rounded-lg bg-white/90 px-2.5 py-1 text-[11px] text-slate-500 shadow-sm">
              Arrastra para mover · Botón derecho para desplazar la vista · Rueda para acercar
            </div>
          )}
        </div>

        <aside className="card order-3 max-h-[34rem] overflow-y-auto p-4">
          {selected ? (
            <Properties
              key={selected.id}
              o={selected}
              scene={scene}
              robot={selected.kind === 'robot' ? robots[selected.params.variant_slug] : undefined}
              canEdit={canEdit}
              components={components}
              onChange={(fn) => change((s) => updateObject(s, selected.id, fn))}
              changeScene={change}
              onConnect={() => {
                setFlowMode(true);
                setNotice(null);
                setConnectFrom(selected.id);
              }}
              onDelete={() => {
                change((s) => removeObject(s, selected.id));
                setSelectedId(null);
              }}
              onDuplicate={() => {
                const r = duplicateObject(scene, selected.id);
                setScene(r.scene);
                setDirty(true);
                setSelectedId(r.id);
              }}
            />
          ) : (
            <p className="text-sm text-slate-500">
              Selecciona un objeto en el lienzo o en la lista.
            </p>
          )}
        </aside>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Warnings warnings={warnings} processIssues={processIssues} onSelect={setSelectedId} />
        <ProductCard
          product={scene.process.product}
          canEdit={canEdit}
          onChange={(product) => change((s) => ({ ...s, process: { ...s.process, product } }))}
        />
      </div>

      {playError && <Message kind="error">{playError}</Message>}
      <SimulationPanel
        projectId={projectId}
        canEdit={canEdit}
        dirty={dirty}
        flowErrors={flowErrors}
        onPlay={startPlayback}
      />

      <p className="text-xs text-slate-500">
        {PROPORTIONS_NOTICE} {DISCLAIMERS.estimates}
      </p>

      {adding === 'robot' && (
        <RobotPicker
          onClose={() => setAdding(null)}
          onPick={(v) => add({ kind: 'robot', variant_slug: v.slug, label: v.variant_code })}
        />
      )}
      {adding === 'pallet' && <PalletForm onClose={() => setAdding(null)} onAdd={add} />}
      {(adding === 'gripper' || adding === 'sensor') && (
        <ComponentPicker
          title={adding === 'gripper' ? 'Añadir gripper' : 'Añadir sensor'}
          categories={adding === 'gripper' ? ['grippers'] : ['sensors', 'safety']}
          onClose={() => setAdding(null)}
          onPick={(c) =>
            add({
              kind: adding,
              component_slug: c?.slug ?? null,
              label: c ? c.model : KIND_LABEL[adding],
              mounted_on: adding === 'gripper' ? (selectedRobot?.id ?? null) : null,
            })
          }
        />
      )}
    </div>
  );
}
