import type {
  CatalogVariantDetail,
  CycleTime,
  DataSource,
  RobotDocument,
  RobotSpecs,
} from '@sim/domain';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { NotPublished, Value } from '../components/NotPublished';
import { Message, Spinner } from '../components/ui';
import { useApp } from '../lib/context';
import { fmt } from '../lib/format';

// Documentos del robot por ruta, para mostrar título, URL y términos junto a cada dato.
const DocsContext = createContext<Map<string, RobotDocument>>(new Map());

const UNIT_LABEL: Record<string, string> = { deg: '°', mm: 'mm', 'deg/s': '°/s', 'm/s': 'm/s' };
const REP_LABEL: Record<string, string> = {
  pose_repeatability_mm: 'Repetibilidad de posición (RP), mm',
  position_repeatability_mm: 'Repetibilidad de posición, mm',
  path_repeatability_mm: 'Repetibilidad de trayectoria (RT), mm',
  path_repeatability_linear_mm: 'Repetibilidad de trayectoria lineal, mm',
  path_accuracy_mm: 'Precisión de trayectoria, mm',
  pose_stabilization_time_s: 'Tiempo de estabilización, s',
  angular_repeatability_axis4_deg: 'Repetibilidad angular eje 4, °',
  robot_accuracy_tcp_mm: 'Precisión del TCP, mm',
  trolley_mm: 'Carro, mm',
  standard: 'Norma',
};
const unit = (u: string | null | undefined) => (u ? (UNIT_LABEL[u] ?? u) : '');

export function CatalogVariantPage() {
  const { slug = '' } = useParams();
  const { api } = useApp();
  // Se guarda el slug junto al resultado para no mostrar la variante anterior al navegar.
  const [state, setState] = useState<{
    slug: string;
    data?: CatalogVariantDetail;
    error?: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getCatalogVariant(slug)
      .then((data) => alive && setState({ slug, data }))
      .catch((e: Error) => alive && setState({ slug, error: e.message }));
    return () => {
      alive = false;
    };
  }, [api, slug]);

  const current = state?.slug === slug ? state : null;
  const data = current?.data;
  const error = current?.error;
  if (!data)
    return error ? (
      <Message kind="error">{error}</Message>
    ) : (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Cargando…
      </p>
    );

  const { variant, robot, specs, documents, siblings } = data;
  return (
    <section className="space-y-6">
      <div>
        <Link to="/catalogo" className="text-sm text-slate-500 hover:text-slate-700">
          ← Catálogo
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{variant.variant_code}</h1>
          {robot.family && <span className="badge bg-brand-50 text-brand-700">{robot.family}</span>}
          {robot.data_status === 'partial' && (
            <span className="badge bg-amber-100 text-amber-800">Datos parciales</span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {robot.manufacturer} · {robot.model}
          {robot.typical_application && ` · ${robot.typical_application}`}
        </p>
        {siblings.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {siblings.map((s) => (
              <Link
                key={s.slug}
                to={`/catalogo/${s.slug}`}
                className={`badge border ${
                  s.slug === variant.slug
                    ? 'border-brand-500 bg-brand-600 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-brand-500'
                }`}
              >
                {s.variant_code}
              </Link>
            ))}
          </div>
        )}
      </div>

      <DocsContext.Provider value={new Map(documents.map((d) => [d.path, d]))}>
        {!specs ? (
          <Message kind="error">Esta variante no tiene datos de ficha cargados.</Message>
        ) : (
          <>
            <SpecsTable specs={specs} variantCode={variant.variant_code} />
            <AxesTable specs={specs} />
            <CycleTimes specs={specs} variantCode={variant.variant_code} />
          </>
        )}
      </DocsContext.Provider>

      <div className="card p-6">
        <h2 className="font-semibold">Documentos de origen</h2>
        <p className="mt-1 mb-4 text-sm text-slate-500">
          Los documentos no se descargan desde esta aplicación. Los enlaces llevan al portal público
          del fabricante.
        </p>
        {documents.length === 0 ? (
          <NotPublished label="Sin documentos registrados" />
        ) : (
          <ul className="space-y-3">
            {documents.map((d) => (
              <li key={d.path} className="rounded-xl border border-slate-200 p-4 text-sm">
                <p className="font-medium">{d.title ?? d.path}</p>
                <p className="text-xs text-slate-500">
                  {[d.kind, d.doc_id, d.revision && `rev. ${d.revision}`, d.doc_date]
                    .filter(Boolean)
                    .join(' · ')}
                  {d.accessed_at && ` · consultado ${d.accessed_at.slice(0, 10)}`}
                </p>
                {d.url && (
                  <a href={d.url} target="_blank" rel="noreferrer" className="link text-xs">
                    Ver en el portal del fabricante
                  </a>
                )}
                {d.license_terms && (
                  <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
                    <strong>Términos de uso:</strong> {d.license_terms}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(robot.notes?.length || specs?.provenance._extraction) && (
        <div className="card p-6 text-sm">
          <h2 className="font-semibold">Notas de extracción</h2>
          {specs?.provenance._extraction?.note && (
            <p className="mt-2 text-slate-600">{specs.provenance._extraction.note}</p>
          )}
          {robot.notes && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
              {robot.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function SourceInfo({ sources }: { sources: DataSource[] | null | undefined }) {
  const docs = useContext(DocsContext);
  if (!sources?.length)
    return <span className="text-xs text-amber-700 italic">Fuente no indicada</span>;
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer list-none text-brand-600 hover:underline">
        {sources.map((s) => `${s.file}${s.page != null ? ` p. ${s.page}` : ''}`).join(', ')}
      </summary>
      <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-2 text-slate-600">
        {sources.map((s, i) => {
          const doc = docs.get(s.file);
          return (
            <div key={i}>
              <p>
                <strong>{doc?.title ?? s.file}</strong>
                {s.doc_id && ` (${s.doc_id}${s.revision ? ` rev. ${s.revision}` : ''})`}
              </p>
              <p>
                {s.page != null ? `Página ${s.page}` : 'Página no indicada'}
                {s.section && ` · Sección "${s.section}"`}
                {doc?.accessed_at && ` · consultado ${doc.accessed_at.slice(0, 10)}`}
              </p>
              {doc?.url && (
                <a href={doc.url} target="_blank" rel="noreferrer" className="link">
                  Ver documento en el portal del fabricante
                </a>
              )}
              {doc?.license_terms && <p className="mt-1">Términos: {doc.license_terms}</p>}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function Row({
  label,
  children,
  sources,
  missing = false,
}: {
  label: string;
  children: ReactNode;
  sources: DataSource[] | null | undefined;
  /** El dato no está publicado: no se muestra fuente para no sugerir que existe. */
  missing?: boolean;
}) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-slate-600">{label}</dt>
      <dd className="text-sm">{children}</dd>
      <dd className="min-w-0">{!missing && <SourceInfo sources={sources} />}</dd>
    </div>
  );
}

function SpecsTable({ specs, variantCode }: { specs: RobotSpecs; variantCode: string }) {
  const p = specs.provenance;
  const rep = specs.repeatability
    ? Object.entries(specs.repeatability).filter(([k, v]) => v != null && k !== 'note')
    : [];
  return (
    <div className="card p-6">
      <h2 className="font-semibold">Datos de ficha</h2>
      <p className="mt-1 text-sm text-slate-500">
        Valores publicados para {variantCode}. Pulsa la fuente para ver documento, página y términos
        de uso.
      </p>
      <dl className="mt-4 divide-y divide-slate-100">
        <Row
          label="Número de ejes"
          sources={p.axes_count}
          missing={specs.axes_count == null && !specs.axes_note}
        >
          {specs.axes_count != null ? (
            specs.axes_count
          ) : specs.axes_note ? (
            <span>
              {specs.axes_note}{' '}
              <span className="text-xs text-slate-500">
                (texto de la ficha, sin un único valor)
              </span>
            </span>
          ) : (
            <NotPublished />
          )}
        </Row>
        <Row label="Alcance" sources={p.reach_mm} missing={specs.reach_mm == null}>
          <Value text={fmt(specs.reach_mm, 'mm')} />
        </Row>
        {(specs.workspace_diameter_mm != null || specs.reach_mm == null) && (
          <Row
            label="Diámetro del área de trabajo"
            sources={p.workspace_diameter_mm}
            missing={specs.workspace_diameter_mm == null}
          >
            <Value text={fmt(specs.workspace_diameter_mm, 'mm')} />
          </Row>
        )}
        <Row label="Carga útil" sources={p.payload_kg} missing={specs.payload_kg == null}>
          <Value text={fmt(specs.payload_kg, 'kg')} />
          {specs.payload_note && <p className="text-xs text-slate-500">{specs.payload_note}</p>}
        </Row>
        <Row
          label="Carga en el brazo (armload)"
          sources={p.armload_kg}
          missing={specs.armload_kg == null}
        >
          <Value text={fmt(specs.armload_kg, 'kg')} />
        </Row>
        <Row label="Peso del robot" sources={p.weight_kg} missing={specs.weight_kg == null}>
          <Value text={fmt(specs.weight_kg, 'kg')} />
        </Row>
        <Row label="Repetibilidad" sources={p.repeatability} missing={rep.length === 0}>
          {rep.length === 0 ? (
            <NotPublished />
          ) : (
            <ul className="space-y-0.5">
              {rep.map(([k, v]) => (
                <li key={k}>
                  <span className="text-slate-500">{REP_LABEL[k] ?? k.replaceAll('_', ' ')}:</span>{' '}
                  {String(v)}
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Montaje" sources={p.mounting_allowed} missing={!specs.mounting_allowed?.length}>
          <Value text={specs.mounting_allowed?.join(', ') || null} />
        </Row>
        <Row label="Protección IP" sources={p.ip_rating} missing={specs.ip_rating == null}>
          <Value text={specs.ip_rating} />
        </Row>
        <Row label="Controlador" sources={p.controller} missing={specs.controller == null}>
          <Value text={specs.controller} />
        </Row>
        <Row
          label="Velocidad máxima del TCP"
          sources={p.max_tcp_speed_m_s}
          missing={specs.max_tcp_speed_m_s == null}
        >
          <Value text={fmt(specs.max_tcp_speed_m_s, 'm/s')} />
        </Row>
        {specs.extra &&
          Object.entries(specs.extra).map(([k, v]) => (
            <Row key={k} label={k.replaceAll('_', ' ')} sources={p.extra}>
              <Value text={v == null ? null : String(v)} />
            </Row>
          ))}
      </dl>
    </div>
  );
}

function AxesTable({ specs }: { specs: RobotSpecs }) {
  return (
    <div className="card overflow-x-auto p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Ejes: rango y velocidad</h2>
        {specs.axis_limits && <SourceInfo sources={specs.provenance.axis_limits} />}
      </div>
      {!specs.axis_limits ? (
        <p className="mt-4">
          <NotPublished label="Rangos y velocidades de ejes no publicados" />
        </p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="pb-2">Eje</th>
              <th className="pb-2">Rango</th>
              <th className="pb-2">Velocidad máxima</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {specs.axis_limits.map((a) => (
              <tr key={a.axis}>
                <td className="py-2 font-medium">{a.axis}</td>
                <td className="py-2">
                  {a.min == null || a.max == null ? (
                    <NotPublished />
                  ) : (
                    `${fmt(a.min)} a ${fmt(a.max)} ${unit(a.unit)}`
                  )}
                </td>
                <td className="py-2">
                  <Value
                    text={a.max_speed == null ? null : `${fmt(a.max_speed)} ${unit(a.speed_unit)}`}
                  />
                  {a.note && <p className="text-xs text-slate-500">{a.note}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function cycleValue(c: CycleTime, variantCode: string): string | null {
  if (c.value_s != null) return `${fmt(c.value_s)} s`;
  const row = c.table?.[variantCode];
  if (row) return row.map((v) => (v == null ? 'n/p' : `${fmt(v)} s`)).join(' / ');
  return null;
}

function CycleTimes({ specs, variantCode }: { specs: RobotSpecs; variantCode: string }) {
  const list = specs.published_cycle_times ?? [];
  return (
    <div className="card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Tiempos de ciclo publicados</h2>
        {list.length > 0 && <SourceInfo sources={specs.provenance.published_cycle_times} />}
      </div>
      {list.length === 0 ? (
        <p className="mt-4">
          <NotPublished label="Sin tiempos de ciclo publicados" />
        </p>
      ) : (
        <ul className="mt-4 space-y-3 text-sm">
          {list.map((c, i) => (
            <li key={i} className="rounded-xl border border-slate-200 p-3">
              <p className="font-medium">
                <Value text={cycleValue(c, variantCode)} />
              </p>
              {c.condition && <p className="text-xs text-slate-500">{c.condition}</p>}
              {c.mapping_uncertain && (
                <p className="mt-1 text-xs text-amber-700">
                  La asignación de columnas de la tabla a cada variante es incierta en la ficha.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
