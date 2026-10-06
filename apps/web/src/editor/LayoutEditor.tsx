import {
  buildRobotModel,
  clampJoint,
  DISCLAIMERS,
  PALLET_PRESETS,
  PALLET_SIZES,
  PROPORTIONS_NOTICE,
  SIMPLIFIED_NOTICE,
  validateScene,
  type CatalogVariant,
  type CatalogVariantDetail,
  type PalletPreset,
  type RobotModel,
  type Scene,
  type SceneObject,
} from '@sim/domain';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { Message, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';
import { useApp } from '../lib/context';
import { fmt } from '../lib/format';
import { NumberField } from './fields';
import {
  addObject,
  duplicateObject,
  KIND_LABEL,
  palletPreset,
  PALLET_HEIGHT_HINT,
  removeObject,
  updateObject,
  type NewObject,
} from './sceneOps';

const Viewport = lazy(() => import('./Viewport'));

interface RobotInfo {
  detail: CatalogVariantDetail;
  model: RobotModel;
}

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
  const [adding, setAdding] = useState<'robot' | 'pallet' | null>(null);
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
    () => (scene ? validateScene(scene, (slug) => models[slug]) : []),
    [scene, models],
  );
  const warned = useMemo(
    () => new Set(warnings.filter((w) => w.level === 'warning').flatMap((w) => w.objects)),
    [warnings],
  );

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
          </>
        ) : (
          <span className="px-2 text-sm text-slate-500">Solo lectura: tu rol es lector.</span>
        )}
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
              scene={scene}
              models={models}
              selectedId={selectedId}
              warned={warned}
              editable={canEdit}
              snapMm={snapMm}
              onSelect={setSelectedId}
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
          <div className="pointer-events-none absolute bottom-2 left-2 rounded-lg bg-white/90 px-2.5 py-1 text-[11px] text-slate-500 shadow-sm">
            Arrastra para mover · Botón derecho para desplazar la vista · Rueda para acercar
          </div>
        </div>

        <aside className="card order-3 max-h-[34rem] overflow-y-auto p-4">
          {selected ? (
            <Properties
              key={selected.id}
              o={selected}
              scene={scene}
              robot={selected.kind === 'robot' ? robots[selected.params.variant_slug] : undefined}
              canEdit={canEdit}
              onChange={(fn) => change((s) => updateObject(s, selected.id, fn))}
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

      <Warnings warnings={warnings} onSelect={setSelectedId} />

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
    </div>
  );
}

function Warnings({
  warnings,
  onSelect,
}: {
  warnings: ReturnType<typeof validateScene>;
  onSelect: (id: string) => void;
}) {
  if (warnings.length === 0) return null;
  return (
    <div className="card p-4">
      <h3 className="mb-2 text-sm font-semibold">Validaciones</h3>
      <ul className="space-y-1.5 text-sm">
        {warnings.map((w, i) => (
          <li key={i}>
            <button
              onClick={() => onSelect(w.objects[0]!)}
              className={`w-full rounded-lg px-3 py-2 text-left ${
                w.level === 'warning'
                  ? 'bg-amber-50 text-amber-900 hover:bg-amber-100'
                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
              }`}
            >
              <span className="mr-2 font-medium">
                {w.level === 'warning' ? '⚠' : 'ℹ'}{' '}
                {
                  { reach: 'Alcance', payload: 'Carga', collision: 'Colisión', data: 'Datos' }[
                    w.kind
                  ]
                }
                :
              </span>
              {w.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Properties({
  o,
  scene,
  robot,
  canEdit,
  onChange,
  onDelete,
  onDuplicate,
}: {
  o: SceneObject;
  scene: Scene;
  robot: RobotInfo | 'error' | undefined;
  canEdit: boolean;
  onChange: (fn: (o: SceneObject) => SceneObject) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const set = <K extends keyof SceneObject>(k: K, v: SceneObject[K]) =>
    onChange((x) => ({ ...x, [k]: v }));
  const setParam = (k: string, v: unknown) =>
    onChange((x) => ({ ...x, params: { ...x.params, [k]: v } }) as SceneObject);
  const robotsInScene = scene.objects.filter((x) => x.kind === 'robot');
  const dis = !canEdit;

  return (
    <fieldset disabled={dis} className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <span className="badge bg-slate-100 text-slate-600">{KIND_LABEL[o.kind]}</span>
        {canEdit && (
          <div className="flex gap-1">
            <button className="btn btn-ghost px-2 py-1 text-xs" onClick={onDuplicate}>
              Duplicar
            </button>
            <button className="btn btn-danger px-2 py-1 text-xs" onClick={onDelete}>
              Eliminar
            </button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <label className="text-xs font-medium text-slate-600">
          Nombre
          <input
            className="input mt-1 px-2.5 py-1.5"
            value={o.name}
            maxLength={100}
            onChange={(e) => e.target.value.trim() && set('name', e.target.value)}
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Color
          <input
            type="color"
            className="mt-1 block h-[34px] w-12 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
            value={o.color}
            onChange={(e) => set('color', e.target.value)}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="X"
          unit="mm"
          value={o.position[0]}
          min={-100000}
          max={100000}
          onChange={(v) => set('position', [v!, o.position[1]])}
        />
        <NumberField
          label="Y"
          unit="mm"
          value={o.position[1]}
          min={-100000}
          max={100000}
          onChange={(v) => set('position', [o.position[0], v!])}
        />
        <NumberField
          label="Elevación"
          unit="mm"
          value={o.elevation}
          min={0}
          max={20000}
          onChange={(v) => set('elevation', v!)}
        />
        <NumberField
          label="Giro"
          unit="°"
          value={o.rotation_deg}
          min={-360}
          max={360}
          step={5}
          onChange={(v) => set('rotation_deg', v!)}
        />
      </div>

      {o.kind === 'robot' ? (
        <RobotProps o={o} robot={robot} setParam={setParam} />
      ) : (
        <>
          {o.kind === 'pallet' && (
            <label className="block text-xs font-medium text-slate-600">
              Tipo de pallet
              <select
                className="input mt-1 px-2.5 py-1.5"
                value={o.params.preset}
                onChange={(e) => {
                  const preset = e.target.value as PalletPreset;
                  const p = palletPreset(preset);
                  onChange((x) =>
                    x.kind === 'pallet'
                      ? {
                          ...x,
                          params: {
                            ...x.params,
                            preset,
                            length_mm: p.length_mm ?? x.params.length_mm,
                            width_mm: p.width_mm ?? x.params.width_mm,
                            height_mm: p.height_mm ?? x.params.height_mm,
                          },
                        }
                      : x,
                  );
                }}
              >
                {PALLET_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p === 'custom' ? 'Personalizado' : PALLET_SIZES[p].label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid grid-cols-3 gap-2">
            {(['length_mm', 'width_mm', 'height_mm'] as const).map((k) => {
              const fixed =
                o.kind === 'pallet' && o.params.preset !== 'custom' && k !== 'height_mm';
              return (
                <NumberField
                  key={k}
                  label={{ length_mm: 'Largo', width_mm: 'Ancho', height_mm: 'Alto' }[k]}
                  unit="mm"
                  value={o.params[k]}
                  min={1}
                  max={50000}
                  disabled={fixed}
                  placeholder={
                    o.kind === 'pallet' && k === 'height_mm' ? PALLET_HEIGHT_HINT : undefined
                  }
                  hint={o.kind === 'pallet' && k === 'height_mm' ? PALLET_HEIGHT_HINT : undefined}
                  onChange={(v) => setParam(k, v)}
                />
              );
            })}
          </div>
          {o.kind === 'pallet' && o.params.preset !== 'custom' && (
            <p className="text-xs text-slate-500">
              Largo y ancho del preset ({PALLET_SIZES[o.params.preset].source}). Elige
              "Personalizado" para cambiarlos.
            </p>
          )}
          {o.kind === 'box' && (
            <NumberField
              label="Masa"
              unit="kg"
              value={o.params.mass_kg}
              min={0}
              max={10000}
              step={0.1}
              required={false}
              placeholder="Opcional, para validar carga"
              onChange={(v) => setParam('mass_kg', v)}
            />
          )}
          <label className="block text-xs font-medium text-slate-600">
            Atendido por
            <select
              className="input mt-1 px-2.5 py-1.5"
              value={o.served_by ?? ''}
              onChange={(e) => set('served_by', e.target.value || null)}
            >
              <option value="">Ningún robot</option>
              {robotsInScene.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block font-normal text-slate-500">
              Se valida el alcance{o.kind === 'box' ? ' y la carga' : ''} de ese robot.
            </span>
          </label>
        </>
      )}
    </fieldset>
  );
}

function RobotProps({
  o,
  robot,
  setParam,
}: {
  o: Extract<SceneObject, { kind: 'robot' }>;
  robot: RobotInfo | 'error' | undefined;
  setParam: (k: string, v: unknown) => void;
}) {
  if (robot === 'error')
    return <Message kind="error">No se pudo cargar la ficha de {o.params.variant_slug}.</Message>;
  if (!robot)
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Cargando ficha…
      </p>
    );
  const { detail, model } = robot;
  const joints = model.joints.map((j, i) => clampJoint(j, o.params.joints[i] ?? j.home));
  const setJoint = (i: number, v: number) => {
    const next = [...joints];
    next[i] = clampJoint(model.joints[i]!, v);
    setParam('joints', next);
  };
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
        <Link to={`/catalogo/${detail.variant.slug}`} className="link text-sm">
          {detail.variant.variant_code}
        </Link>
        <p className="mt-1">
          Alcance (ficha):{' '}
          {model.reach_mm == null ? (
            <span className="not-published">No publicado</span>
          ) : (
            fmt(model.kind === 'delta' ? model.reach_mm * 2 : model.reach_mm, 'mm')
          )}
          {model.kind === 'delta' && model.reach_mm != null && ' de diámetro de trabajo'}
        </p>
        <p>
          Carga útil (ficha):{' '}
          {model.payload_kg == null ? (
            <span className="not-published">No publicado</span>
          ) : (
            fmt(model.payload_kg, 'kg')
          )}
        </p>
        <p className="mt-2">
          <span className="badge bg-amber-100 text-amber-800">Supuesto visual</span> Proporciones de
          eslabones fijas por familia.
        </p>
        {model.notes.map((n) => (
          <p key={n} className="mt-1">
            {n}
          </p>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={o.params.show_envelope}
          onChange={(e) => setParam('show_envelope', e.target.checked)}
        />
        Mostrar envolvente de alcance
      </label>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Ejes</h4>
          {model.joints.length > 0 && (
            <button
              className="btn btn-ghost px-2 py-0.5 text-xs"
              onClick={() =>
                setParam(
                  'joints',
                  model.joints.map((j) => j.home),
                )
              }
            >
              Posición inicial
            </button>
          )}
        </div>
        {model.joints.length === 0 ? (
          <p className="not-published">Ejes no publicados en la ficha</p>
        ) : (
          <ul className="space-y-3">
            {model.joints.map((j, i) => {
              const u = j.unit === 'mm' ? 'mm' : '°';
              const free = j.min != null && j.max != null;
              return (
                <li key={j.axis}>
                  <div className="flex justify-between text-xs">
                    <label htmlFor={`j-${o.id}-${i}`} className="font-medium text-slate-600">
                      Eje {j.axis}
                    </label>
                    <span className="text-slate-500 tabular-nums">
                      {free ? `${joints[i]} ${u}  [${j.min} a ${j.max}]` : 'rango no publicado'}
                    </span>
                  </div>
                  <input
                    id={`j-${o.id}-${i}`}
                    type="range"
                    className="w-full accent-brand-600"
                    min={j.min ?? 0}
                    max={j.max ?? 0}
                    step={1}
                    value={joints[i]}
                    disabled={!free}
                    onChange={(e) => setJoint(i, Number(e.target.value))}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card w-full max-w-lg p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button className="btn btn-ghost px-2 py-1" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function RobotPicker({
  onPick,
  onClose,
}: {
  onPick: (v: CatalogVariant) => void;
  onClose: () => void;
}) {
  const { api } = useApp();
  const [list, setList] = useState<CatalogVariant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    api
      .listCatalog()
      .then((r) => setList(r.variants))
      .catch((e: Error) => setError(e.message));
  }, [api]);
  const shown = (list ?? []).filter((v) =>
    `${v.variant_code} ${v.family}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <Modal title="Añadir robot del catálogo" onClose={onClose}>
      <input
        autoFocus
        type="search"
        className="input mb-3"
        placeholder="Buscar variante"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <Message kind="error">{error}</Message>}
      {!list && !error ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Cargando catálogo…
        </p>
      ) : (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
          {shown.map((v) => (
            <li key={v.slug}>
              <button
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                onClick={() => onPick(v)}
              >
                <span>
                  <span className="font-medium">{v.variant_code}</span>
                  <span className="block text-xs text-slate-500">{v.family}</span>
                </span>
                <span className="text-xs text-slate-500">
                  {fmt(v.payload_kg, 'kg') ?? 'carga n/p'} ·{' '}
                  {fmt(v.reach_mm ?? v.workspace_diameter_mm, 'mm') ?? 'alcance n/p'}
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-3 py-4 text-sm text-slate-500">Sin resultados.</li>
          )}
        </ul>
      )}
    </Modal>
  );
}

export function PalletForm({
  onAdd,
  onClose,
}: {
  onAdd: (spec: NewObject) => void;
  onClose: () => void;
}) {
  const [preset, setPreset] = useState<PalletPreset>('eur');
  const p = palletPreset(preset);
  const [dims, setDims] = useState<{
    length_mm: number | null;
    width_mm: number | null;
    height_mm: number | null;
  }>(p);
  const choose = (next: PalletPreset) => {
    setPreset(next);
    setDims(palletPreset(next));
  };
  const valid = dims.length_mm != null && dims.width_mm != null && dims.height_mm != null;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    onAdd({
      kind: 'pallet',
      preset,
      length_mm: dims.length_mm!,
      width_mm: dims.width_mm!,
      height_mm: dims.height_mm!,
    });
  }
  return (
    <Modal title="Añadir pallet" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm font-medium text-slate-700">
          Tipo
          <select
            className="input mt-1.5"
            value={preset}
            onChange={(e) => choose(e.target.value as PalletPreset)}
          >
            {PALLET_PRESETS.map((x) => (
              <option key={x} value={x}>
                {x === 'custom' ? 'Personalizado' : PALLET_SIZES[x].label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <NumberField
            label="Largo"
            unit="mm"
            value={dims.length_mm}
            min={1}
            max={50000}
            disabled={preset !== 'custom'}
            onChange={(v) => setDims((d) => ({ ...d, length_mm: v }))}
          />
          <NumberField
            label="Ancho"
            unit="mm"
            value={dims.width_mm}
            min={1}
            max={50000}
            disabled={preset !== 'custom'}
            onChange={(v) => setDims((d) => ({ ...d, width_mm: v }))}
          />
          <NumberField
            label="Alto"
            unit="mm"
            value={dims.height_mm}
            min={1}
            max={50000}
            placeholder={PALLET_HEIGHT_HINT}
            hint={PALLET_HEIGHT_HINT}
            onChange={(v) => setDims((d) => ({ ...d, height_mm: v }))}
          />
        </div>
        {preset !== 'custom' && PALLET_SIZES[preset].height_mm == null && (
          <p className="text-xs text-amber-700">
            La altura de este pallet no está publicada en los presets: captúrala para continuar.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>
            Añadir pallet
          </button>
        </div>
      </form>
    </Modal>
  );
}
