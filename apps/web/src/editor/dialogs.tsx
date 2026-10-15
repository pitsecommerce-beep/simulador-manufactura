import {
  PALLET_PRESETS,
  PALLET_SIZES,
  componentWeightKg,
  type CatalogComponent,
  type CatalogVariant,
  type PalletPreset,
} from '@sim/domain';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Message, Spinner } from '../components/ui';
import { useApp } from '../lib/context';
import { fmt } from '../lib/format';
import { NumberField } from './fields';
import { palletPreset, PALLET_HEIGHT_HINT, type NewObject } from './sceneOps';

export function Modal({
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

export function RobotPicker({
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

const CATEGORY_LABEL: Record<string, string> = {
  grippers: 'Grippers',
  sensors: 'Sensores',
  fences: 'Vallas',
  safety: 'Seguridad',
  conveyors: 'Bandas',
};

/** Selector de componentes del catálogo. "Sin componente" deja el objeto genérico. */
export function ComponentPicker({
  title,
  categories,
  onPick,
  onClose,
}: {
  title: string;
  categories: string[];
  onPick: (c: CatalogComponent | null) => void;
  onClose: () => void;
}) {
  const { api } = useApp();
  const [list, setList] = useState<CatalogComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Clave estable: el arreglo de categorías cambia de identidad en cada render.
  const key = categories.join(',');
  useEffect(() => {
    const wanted = key.split(',');
    api
      .listComponents()
      .then((r) => setList(r.components.filter((c) => wanted.includes(c.category))))
      .catch((e: Error) => setError(e.message));
  }, [api, key]);
  return (
    <Modal title={title} onClose={onClose}>
      {error && <Message kind="error">{error}</Message>}
      {!list && !error ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Cargando componentes…
        </p>
      ) : (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
          {(list ?? []).map((c) => {
            const w = componentWeightKg(c);
            return (
              <li key={c.slug}>
                <button
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  onClick={() => onPick(c)}
                >
                  <span>
                    <span className="font-medium">
                      {c.manufacturer} {c.model}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {CATEGORY_LABEL[c.category] ?? c.category}
                      {c.type && ` · ${c.type}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {w != null ? `${fmt(w, 'kg')}` : 'peso no publicado'}
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              className="w-full px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
              onClick={() => onPick(null)}
            >
              Genérico (sin componente del catálogo)
            </button>
          </li>
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-500">
        La geometría es simplificada. Los datos del componente se leen de su ficha en el catálogo.{' '}
        <Link to="/catalogo" className="link">
          Ver catálogo
        </Link>
      </p>
    </Modal>
  );
}
