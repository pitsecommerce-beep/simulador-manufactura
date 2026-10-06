import type { CatalogFacets, CatalogVariant } from '@sim/domain';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Value } from '../components/NotPublished';
import { Message, Spinner } from '../components/ui';
import { useApp } from '../lib/context';
import { fmt } from '../lib/format';

const FILTER_KEYS = [
  'q',
  'family',
  'application',
  'payload_min',
  'payload_max',
  'reach_min',
  'reach_max',
] as const;

export function CatalogPage() {
  const { api } = useApp();
  const [params, setParams] = useSearchParams();
  const [facets, setFacets] = useState<CatalogFacets | null>(null);
  const [result, setResult] = useState<{ variants: CatalogVariant[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(params.get('q') ?? '');

  useEffect(() => {
    api
      .catalogFacets()
      .then(setFacets)
      .catch(() => {});
  }, [api]);

  // La búsqueda de texto se aplica tras una pausa breve al escribir.
  useEffect(() => {
    const t = setTimeout(() => update('q', q), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = Object.fromEntries(
    FILTER_KEYS.map((k) => [k, params.get(k) ?? ''] as const).filter(([, v]) => v),
  );
  const key = new URLSearchParams(query).toString();

  useEffect(() => {
    let alive = true;
    api
      .listCatalog(Object.fromEntries(new URLSearchParams(key)))
      .then((r) => alive && (setResult(r), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [api, key]);

  function update(k: (typeof FILTER_KEYS)[number], v: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v) next.set(k, v);
        else next.delete(k);
        return next;
      },
      { replace: true },
    );
  }

  const active = FILTER_KEYS.some((k) => k !== 'q' && params.get(k));
  const numeric = ['payload_min', 'payload_max', 'reach_min', 'reach_max'].some((k) =>
    params.get(k),
  );

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Catálogo de robots</h1>
        <p className="mt-1 text-sm text-slate-500">
          Datos copiados de las fichas técnicas publicadas por el fabricante. Cada dato indica su
          documento de origen.
        </p>
      </div>

      <div className="card space-y-4 p-4">
        <input
          type="search"
          aria-label="Buscar"
          placeholder="Buscar por modelo o variante (ej. IRB 1300, 910INV)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="input"
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span className="label">Familia</span>
            <select
              className="input"
              value={params.get('family') ?? ''}
              onChange={(e) => update('family', e.target.value)}
            >
              <option value="">Todas</option>
              {facets?.families.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="label">Aplicación</span>
            <select
              className="input"
              value={params.get('application') ?? ''}
              onChange={(e) => update('application', e.target.value)}
            >
              <option value="">Todas</option>
              {facets?.applications.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <RangeFilter
            label="Carga útil (kg)"
            min={params.get('payload_min') ?? ''}
            max={params.get('payload_max') ?? ''}
            placeholder={facets?.payload}
            onMin={(v) => update('payload_min', v)}
            onMax={(v) => update('payload_max', v)}
          />
          <RangeFilter
            label="Alcance (mm)"
            min={params.get('reach_min') ?? ''}
            max={params.get('reach_max') ?? ''}
            placeholder={facets?.reach}
            onMin={(v) => update('reach_min', v)}
            onMax={(v) => update('reach_max', v)}
          />
        </div>
        {(active || q) && (
          <button
            type="button"
            className="btn btn-ghost px-2 py-1"
            onClick={() => {
              setQ('');
              setParams({}, { replace: true });
            }}
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {error && <Message kind="error">{error}</Message>}
      {!result ? (
        !error && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Cargando…
          </p>
        )
      ) : (
        <>
          <p className="text-sm text-slate-500">
            {result.variants.length} de {result.total} variantes
            {numeric &&
              '. Los filtros de carga y alcance excluyen las variantes cuyo dato no está publicado; en robots delta se usa el radio del área de trabajo'}
            .
          </p>
          {result.variants.length === 0 ? (
            <div className="card border-dashed p-10 text-center text-sm text-slate-500">
              Ninguna variante coincide con los filtros.
            </div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {result.variants.map((v) => (
                <li key={v.slug}>
                  <VariantCard v={v} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RangeFilter(props: {
  label: string;
  min: string;
  max: string;
  placeholder?: { min: number | null; max: number | null } | undefined;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  return (
    <fieldset className="text-sm">
      <legend className="label">{props.label}</legend>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          inputMode="decimal"
          aria-label={`${props.label} mínimo`}
          placeholder={props.placeholder?.min != null ? `mín ${props.placeholder.min}` : 'mín'}
          value={props.min}
          onChange={(e) => props.onMin(e.target.value)}
          className="input"
        />
        <span className="text-slate-400">a</span>
        <input
          type="number"
          min={0}
          inputMode="decimal"
          aria-label={`${props.label} máximo`}
          placeholder={props.placeholder?.max != null ? `máx ${props.placeholder.max}` : 'máx'}
          value={props.max}
          onChange={(e) => props.onMax(e.target.value)}
          className="input"
        />
      </div>
    </fieldset>
  );
}

function VariantCard({ v }: { v: CatalogVariant }) {
  const reach =
    v.reach_mm != null
      ? fmt(v.reach_mm, 'mm')
      : v.workspace_diameter_mm != null
        ? `Ø ${fmt(v.workspace_diameter_mm, 'mm')} (área de trabajo)`
        : null;
  return (
    <Link
      to={`/catalogo/${v.slug}`}
      className="card group flex h-full flex-col gap-3 p-5 transition hover:-translate-y-0.5 hover:border-brand-500 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold group-hover:text-brand-700">{v.variant_code}</p>
          <p className="text-xs text-slate-500">
            {v.manufacturer} · {v.model}
          </p>
        </div>
        {v.family && <span className="badge bg-brand-50 text-brand-700">{v.family}</span>}
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Carga</dt>
          <dd className="font-medium">
            <Value text={fmt(v.payload_kg, 'kg')} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Alcance</dt>
          <dd className="font-medium">
            <Value text={reach} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Ejes</dt>
          <dd className="font-medium">
            <Value text={v.axes_count != null ? String(v.axes_count) : v.axes_note} />
          </dd>
        </div>
      </dl>
      {v.application && <p className="text-xs text-slate-500">{v.application}</p>}
    </Link>
  );
}
