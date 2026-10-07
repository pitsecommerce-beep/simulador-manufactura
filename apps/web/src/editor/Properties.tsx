import {
  clampJoint,
  componentWeightKg,
  isWorkObject,
  PALLET_PRESETS,
  PALLET_SIZES,
  type CatalogComponent,
  type CatalogVariantDetail,
  type PalletPreset,
  type RobotModel,
  type Scene,
  type SceneObject,
} from '@sim/domain';
import { Link } from 'react-router-dom';
import { Message, Spinner } from '../components/ui';
import { fmt } from '../lib/format';
import { NumberField } from './fields';
import { ProcessSection } from './ProcessSection';
import { KIND_LABEL, palletPreset, PALLET_HEIGHT_HINT } from './sceneOps';

export interface RobotInfo {
  detail: CatalogVariantDetail;
  model: RobotModel;
}

function ComponentInfo({
  slug,
  components,
}: {
  slug: string | null;
  components: Map<string, CatalogComponent>;
}) {
  if (!slug)
    return (
      <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
        Genérico, sin componente del catálogo. Su geometría es un supuesto visual.
      </p>
    );
  const c = components.get(slug);
  if (!c)
    return (
      <p className="flex items-center gap-2 text-xs text-slate-500">
        <Spinner /> Cargando componente…
      </p>
    );
  const w = componentWeightKg(c);
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
      <p className="text-sm font-medium text-slate-800">
        {c.manufacturer} {c.model}
      </p>
      {c.type && <p>{c.type}</p>}
      <p className="mt-1">
        Peso (ficha):{' '}
        {w == null ? <span className="not-published">No publicado</span> : fmt(w, 'kg')}
      </p>
      <p className="mt-2">
        <span className="badge bg-amber-100 text-amber-800">Supuesto visual</span> Geometría
        simplificada, no es el CAD del fabricante.
      </p>
    </div>
  );
}

export function Properties({
  o,
  scene,
  robot,
  canEdit,
  components,
  onChange,
  changeScene,
  onConnect,
  onDelete,
  onDuplicate,
}: {
  o: SceneObject;
  scene: Scene;
  robot: RobotInfo | 'error' | undefined;
  canEdit: boolean;
  components: Map<string, CatalogComponent>;
  onChange: (fn: (o: SceneObject) => SceneObject) => void;
  changeScene: (fn: (s: Scene) => Scene) => void;
  onConnect: () => void;
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

      {o.kind === 'robot' && <RobotProps o={o} robot={robot} setParam={setParam} />}
      {isWorkObject(o) && (
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
      {o.kind === 'fence' && (
        <div className="grid grid-cols-3 gap-2">
          {(['length_mm', 'height_mm', 'thickness_mm'] as const).map((k) => (
            <NumberField
              key={k}
              label={{ length_mm: 'Largo', height_mm: 'Alto', thickness_mm: 'Grosor' }[k]}
              unit="mm"
              value={o.params[k]}
              min={1}
              max={50000}
              onChange={(v) => setParam(k, v)}
            />
          ))}
        </div>
      )}
      {o.kind === 'safety_zone' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {(['length_mm', 'width_mm'] as const).map((k) => (
              <NumberField
                key={k}
                label={{ length_mm: 'Largo', width_mm: 'Ancho' }[k]}
                unit="mm"
                value={o.params[k]}
                min={1}
                max={50000}
                onChange={(v) => setParam(k, v)}
              />
            ))}
          </div>
          <p className="text-xs text-slate-500">
            Zona marcada en el piso. No colisiona; se avisa si la envolvente de alcance de un robot
            la invade.
          </p>
        </>
      )}
      {(o.kind === 'gripper' || o.kind === 'sensor') && (
        <ComponentInfo slug={o.params.component_slug} components={components} />
      )}
      {o.kind === 'gripper' && (
        <label className="block text-xs font-medium text-slate-600">
          Montado en
          <select
            className="input mt-1 px-2.5 py-1.5"
            value={o.params.mounted_on ?? ''}
            onChange={(e) => {
              const id = e.target.value || null;
              const r = scene.objects.find((x) => x.id === id);
              onChange((x) =>
                x.kind === 'gripper'
                  ? {
                      ...x,
                      position: r ? r.position : x.position,
                      params: { ...x.params, mounted_on: id },
                    }
                  : x,
              );
            }}
          >
            <option value="">Suelto en el piso</option>
            {robotsInScene.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block font-normal text-slate-500">
            Si su ficha publica el peso, se suma a la carga del robot.
          </span>
        </label>
      )}
      <ProcessSection
        o={o}
        scene={scene}
        robotDetail={o.kind === 'robot' && robot && robot !== 'error' ? robot.detail : undefined}
        changeScene={changeScene}
        onConnect={onConnect}
      />
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
