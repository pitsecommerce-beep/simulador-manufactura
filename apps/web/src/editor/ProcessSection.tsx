import {
  ROLE_LABEL,
  type CatalogVariantDetail,
  type Distribution,
  type ProcessNode,
  type ProcessRole,
  type Scene,
  type SceneObject,
} from '@sim/domain';
import { useState } from 'react';
import { DistributionField, NumberField, OriginBadge, TimedField } from './fields';
import { rolesFor, removeRoute, setRole, updateNode, updateRoute } from './sceneOps';

/** Tiempos de ciclo publicados en la ficha de un robot, con su condición de medición. */
export function publishedCycleOptions(detail: CatalogVariantDetail | undefined) {
  const out: { value_s: number; note: string; uncertain?: boolean }[] = [];
  for (const c of detail?.specs?.published_cycle_times ?? []) {
    const cond = c.condition ?? 'condición no indicada';
    if (c.value_s != null) out.push({ value_s: c.value_s, note: cond });
    const row = c.table?.[detail!.variant.variant_code];
    row?.forEach((v, i) => {
      if (v != null)
        out.push({
          value_s: v,
          note: `${cond} (columna ${i + 1})`,
          uncertain: !!c.mapping_uncertain,
        });
    });
  }
  return out;
}

const OP_LABEL = { process: 'Procesa', assemble: 'Ensambla (consume la BOM)' } as const;

/** Rol del objeto en el proceso, sus parámetros y sus rutas de salida. */
export function ProcessSection({
  o,
  scene,
  robotDetail,
  changeScene,
  onConnect,
}: {
  o: SceneObject;
  scene: Scene;
  robotDetail?: CatalogVariantDetail | undefined;
  changeScene: (fn: (s: Scene) => Scene) => void;
  onConnect: () => void;
}) {
  const roles = rolesFor(o);
  if (roles.length === 0) return null;
  const p = scene.process;
  const node = p.nodes.find((n) => n.object_id === o.id) ?? null;
  const names = new Map(scene.objects.map((x) => [x.id, x.name]));
  const items = [p.product.name, ...p.product.bom.map((b) => b.item)];
  const patch = (fn: (n: ProcessNode) => ProcessNode) =>
    changeScene((s) => updateNode(s, o.id, fn));
  const outRoutes = p.routes.filter((r) => r.from === o.id);
  const inRoutes = p.routes.filter((r) => r.to === o.id);

  return (
    <section className="space-y-3 border-t border-slate-200 pt-4">
      <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Proceso</h4>
      <label className="block text-xs font-medium text-slate-600">
        Rol
        <select
          className="input mt-1 px-2.5 py-1.5"
          value={node?.role ?? ''}
          onChange={(e) =>
            changeScene((s) => setRole(s, o.id, (e.target.value || null) as ProcessRole | null))
          }
        >
          <option value="">Sin rol en el proceso</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>

      {node?.role === 'source' && (
        <>
          <label className="block text-xs font-medium text-slate-600">
            Artículo que entra
            <select
              className="input mt-1 px-2.5 py-1.5"
              value={node.item ?? ''}
              onChange={(e) =>
                patch((n) => ({ ...n, item: e.target.value || null }) as ProcessNode)
              }
            >
              <option value="">Elegir…</option>
              {items.map((it) => (
                <option key={it}>{it}</option>
              ))}
            </select>
          </label>
          <TimedField
            label="Tiempo entre llegadas"
            value={node.interarrival}
            onChange={(t) => patch((n) => ({ ...n, interarrival: t }) as ProcessNode)}
            hint="obligatorio"
          />
          <NumberField
            label="Unidades por llegada"
            value={node.batch}
            min={1}
            max={10000}
            onChange={(v) => patch((n) => ({ ...n, batch: v ?? 1 }) as ProcessNode)}
          />
        </>
      )}

      {node?.role === 'station' && (
        <>
          <label className="block text-xs font-medium text-slate-600">
            Operación
            <select
              className="input mt-1 px-2.5 py-1.5"
              value={node.operation}
              onChange={(e) =>
                patch(
                  (n) =>
                    ({ ...n, operation: e.target.value as 'process' | 'assemble' }) as ProcessNode,
                )
              }
            >
              {(['process', 'assemble'] as const).map((k) => (
                <option key={k} value={k}>
                  {OP_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <TimedField
            label="Tiempo de ciclo"
            value={node.cycle}
            onChange={(t) => patch((n) => ({ ...n, cycle: t }) as ProcessNode)}
            options={o.kind === 'robot' ? publishedCycleOptions(robotDetail) : []}
            hint={o.kind === 'robot' ? 'la ficha no lo publica para tu operación' : 'obligatorio'}
          />
          <NumberField
            label="Unidades en paralelo"
            value={node.capacity}
            min={1}
            max={100}
            onChange={(v) => patch((n) => ({ ...n, capacity: v ?? 1 }) as ProcessNode)}
          />
          <ScrapField
            value={node.scrap}
            onChange={(scrap) => patch((n) => ({ ...n, scrap }) as ProcessNode)}
          />
          <FailuresField
            value={node.failures}
            onChange={(failures) => patch((n) => ({ ...n, failures }) as ProcessNode)}
          />
        </>
      )}

      {node?.role === 'buffer' && (
        <>
          <NumberField
            label="Capacidad (unidades)"
            value={node.capacity}
            min={1}
            max={100000}
            onChange={(v) => patch((n) => ({ ...n, capacity: v }) as ProcessNode)}
          />
          <TimedField
            label="Tiempo de recorrido (opcional)"
            value={node.transfer}
            onChange={(t) => patch((n) => ({ ...n, transfer: t }) as ProcessNode)}
            hint="opcional"
            onClear={() => patch((n) => ({ ...n, transfer: null }) as ProcessNode)}
          />
        </>
      )}

      {node?.role === 'sink' && (
        <>
          <NumberField
            label="Unidades por pallet lleno"
            value={node.units_per_pallet}
            min={1}
            max={100000}
            onChange={(v) => patch((n) => ({ ...n, units_per_pallet: v }) as ProcessNode)}
          />
          <TimedField
            label="Cambio de pallet (opcional)"
            value={node.pallet_change}
            onChange={(t) => patch((n) => ({ ...n, pallet_change: t }) as ProcessNode)}
            hint="opcional"
            onClear={() => patch((n) => ({ ...n, pallet_change: null }) as ProcessNode)}
          />
        </>
      )}

      {node && (
        <div className="space-y-2">
          {inRoutes.length > 0 && (
            <p className="text-xs text-slate-500">
              Recibe de: {inRoutes.map((r) => names.get(r.from) ?? r.from).join(', ')}
            </p>
          )}
          {node.role !== 'sink' && (
            <>
              <p className="text-xs font-medium text-slate-600">Envía a</p>
              {outRoutes.length === 0 && (
                <p className="text-xs text-red-600">Sin ruta de salida.</p>
              )}
              <ul className="space-y-1.5">
                {outRoutes.map((r) => (
                  <li key={r.id} className="rounded-lg bg-slate-50 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">→ {names.get(r.to) ?? r.to}</span>
                      <button
                        type="button"
                        className="text-red-600 hover:underline"
                        onClick={() => changeScene((s) => removeRoute(s, r.id))}
                      >
                        Quitar
                      </button>
                    </div>
                    {(outRoutes.length > 1 || p.product.bom.length > 0) && (
                      <div className="mt-1.5 grid grid-cols-2 gap-2">
                        <label className="text-slate-600">
                          Artículo
                          <select
                            className="input mt-1 px-2 py-1 text-xs"
                            value={r.item ?? ''}
                            onChange={(e) =>
                              changeScene((s) =>
                                updateRoute(s, r.id, { item: e.target.value || null }),
                              )
                            }
                          >
                            <option value="">Todos</option>
                            {items.map((it) => (
                              <option key={it}>{it}</option>
                            ))}
                          </select>
                        </label>
                        {outRoutes.length > 1 && (
                          <NumberField
                            label="Fracción"
                            value={r.share}
                            min={0}
                            max={1}
                            step={0.05}
                            required={false}
                            onChange={(v) => changeScene((s) => updateRoute(s, r.id, { share: v }))}
                          />
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn btn-secondary w-full py-1.5 text-xs"
                onClick={onConnect}
              >
                Conectar a otro objeto…
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

type Station = Extract<ProcessNode, { role: 'station' }>;

/** Scrap opcional. Al activarlo el campo empieza vacío: no hay valor por defecto. */
function ScrapField({
  value,
  onChange,
}: {
  value: Station['scrap'];
  onChange: (v: Station['scrap']) => void;
}) {
  const [open, setOpen] = useState(value != null);
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => {
            setOpen(e.target.checked);
            if (!e.target.checked) onChange(null);
          }}
        />
        Scrap
      </label>
      {open && (
        <div className="space-y-1">
          <NumberField
            label="Fracción descartada (0 a 0.99)"
            value={value?.rate ?? null}
            min={0}
            max={0.99}
            step={0.01}
            onChange={(v) => onChange(v == null ? null : { rate: v, origin: 'user' })}
          />
          {value && <OriginBadge origin={value.origin} />}
        </div>
      )}
    </div>
  );
}

/** Fallas opcionales: se guardan solo cuando MTBF y MTTR están capturados. */
function FailuresField({
  value,
  onChange,
}: {
  value: Station['failures'];
  onChange: (v: Station['failures']) => void;
}) {
  const [open, setOpen] = useState(value != null);
  const [mtbf, setMtbf] = useState<number | null>(value?.mtbf_s ?? null);
  const [mttr, setMttr] = useState<Distribution | null>(value?.mttr ?? null);
  const commit = (a: number | null, b: Distribution | null) => {
    if (a != null && b) onChange({ mtbf_s: a, mttr: b, origin: 'user' });
  };
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => {
            setOpen(e.target.checked);
            if (!e.target.checked) onChange(null);
          }}
        />
        Fallas (MTBF y MTTR)
      </label>
      {open && (
        <div className="space-y-2">
          <NumberField
            label="MTBF (tiempo de operación entre fallas)"
            unit="s"
            value={mtbf}
            min={1}
            onChange={(v) => {
              setMtbf(v);
              commit(v, mttr);
            }}
          />
          <DistributionField
            label="MTTR (tiempo de reparación)"
            value={mttr}
            onChange={(d) => {
              setMttr(d);
              commit(mtbf, d);
            }}
          />
          {value ? (
            <OriginBadge origin={value.origin} />
          ) : (
            <p className="text-xs text-red-600">Captura MTBF y MTTR para aplicarlas.</p>
          )}
        </div>
      )}
    </div>
  );
}
