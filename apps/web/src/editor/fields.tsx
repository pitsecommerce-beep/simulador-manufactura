import {
  DIST_LABEL,
  Distribution,
  ORIGIN_LABEL,
  type DistributionType,
  type ParamOrigin,
  type Timed,
} from '@sim/domain';
import { useId, useState } from 'react';

/**
 * Campo numérico que solo confirma valores válidos. Mientras el texto no es válido (vacío,
 * fuera de rango) se muestra el error y la escena conserva el último valor correcto.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  required = true,
  placeholder,
  disabled,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Texto de ayuda bajo el campo cuando está vacío. No es un valor. */
  hint?: string | undefined;
}) {
  const id = useId();
  // Texto en edición; null = se muestra el valor de la escena (cambia al arrastrar, etc.).
  const [draft, setDraft] = useState<string | null>(null);

  const problem = (raw: string): string | null => {
    if (raw.trim() === '') return required ? 'Obligatorio' : null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'Número no válido';
    if (min != null && n < min) return `Mínimo ${min}`;
    if (max != null && n > max) return `Máximo ${max}`;
    return null;
  };

  function edit(raw: string) {
    setDraft(raw);
    if (problem(raw)) return;
    onChange(raw.trim() === '' ? null : Number(raw));
  }

  const text = draft ?? (value == null ? '' : String(value));
  const error = draft != null ? problem(draft) : null;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-600">
        {label}
        {unit && <span className="font-normal text-slate-400"> ({unit})</span>}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => edit(e.target.value)}
        onBlur={() => draft != null && !problem(draft) && setDraft(null)}
        aria-invalid={!!error}
        className={`input px-2.5 py-1.5 ${error ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : ''}`}
      />
      {error ? (
        <p className="mt-1 text-xs text-red-600">
          {error}
          {hint && text === '' && <span className="block text-slate-500">{hint}</span>}
        </p>
      ) : (
        hint && text === '' && <p className="mt-1 text-xs text-slate-500">{hint}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiempos con distribución y origen
// ---------------------------------------------------------------------------

const DIST_PARAMS: Record<DistributionType, [string, string][]> = {
  fixed: [['value', 'Valor']],
  exponential: [['mean', 'Media']],
  normal: [
    ['mean', 'Media'],
    ['sd', 'Desv. est.'],
  ],
  lognormal: [
    ['mean', 'Media'],
    ['sd', 'Desv. est.'],
  ],
  uniform: [
    ['min', 'Mín'],
    ['max', 'Máx'],
  ],
  triangular: [
    ['min', 'Mín'],
    ['mode', 'Moda'],
    ['max', 'Máx'],
  ],
};

const ORIGIN_STYLE: Record<ParamOrigin, string> = {
  catalog: 'bg-emerald-50 text-emerald-700',
  user: 'bg-amber-100 text-amber-800',
  assistant: 'bg-violet-100 text-violet-800',
};

export function OriginBadge({ origin }: { origin: ParamOrigin }) {
  return <span className={`badge ${ORIGIN_STYLE[origin]}`}>{ORIGIN_LABEL[origin]}</span>;
}

/** Valores numéricos de una distribución, por nombre de parámetro. */
function paramsOf(d: Distribution | null): Record<string, number | null> {
  if (!d) return {};
  return Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'type')) as Record<
    string,
    number | null
  >;
}

/**
 * Distribución editable. Solo confirma cuando todos sus parámetros están capturados; mientras
 * tanto conserva el borrador (los campos vacíos se marcan como obligatorios).
 */
export function DistributionField({
  label,
  value,
  onChange,
  unit = 's',
}: {
  label: string;
  value: Distribution | null;
  onChange: (d: Distribution) => void;
  unit?: string;
}) {
  const [type, setType] = useState<DistributionType>(value?.type ?? 'fixed');
  const [draft, setDraft] = useState<Record<string, number | null>>(paramsOf(value));
  const fields = DIST_PARAMS[type];

  function commit(nextType: DistributionType, next: Record<string, number | null>) {
    const keys = DIST_PARAMS[nextType].map(([k]) => k);
    if (keys.some((k) => next[k] == null)) return;
    const candidate = { type: nextType, ...Object.fromEntries(keys.map((k) => [k, next[k]])) };
    const parsed = Distribution.safeParse(candidate);
    if (parsed.success) onChange(parsed.data);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        <select
          aria-label={`${label}: distribución`}
          className="input w-auto px-2 py-1 text-xs"
          value={type}
          onChange={(e) => {
            const t = e.target.value as DistributionType;
            setType(t);
            commit(t, draft);
          }}
        >
          {(Object.keys(DIST_PARAMS) as DistributionType[]).map((t) => (
            <option key={t} value={t}>
              {DIST_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <div className={`grid gap-2 ${fields.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {fields.map(([k, l]) => (
          <NumberField
            key={`${type}-${k}`}
            label={l}
            unit={unit}
            value={draft[k] ?? null}
            min={0}
            step={0.1}
            onChange={(v) => {
              const next = { ...draft, [k]: v };
              setDraft(next);
              commit(type, next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Tiempo del proceso: distribución + origen. Cualquier edición manual lo marca como
 * "supuesto del usuario". `options` ofrece valores publicados en la ficha.
 */
export function TimedField({
  label,
  value,
  onChange,
  options = [],
  hint,
  onClear,
}: {
  label: string;
  value: Timed | null;
  onChange: (t: Timed | null) => void;
  options?: { value_s: number; note: string; uncertain?: boolean }[];
  hint?: string;
  /** Para tiempos opcionales: quita el valor. */
  onClear?: () => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 p-2.5">
      <DistributionField
        key={value ? JSON.stringify(value.dist) : 'vacío'}
        label={label}
        value={value?.dist ?? null}
        onChange={(dist) => onChange({ dist, origin: 'user', note: null })}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {value ? (
          <OriginBadge origin={value.origin} />
        ) : (
          <span className={hint === 'opcional' ? 'text-slate-500' : 'text-red-600'}>
            Sin capturar{hint ? `: ${hint}` : ''}
          </span>
        )}
        {value?.note && <span className="text-slate-500">{value.note}</span>}
        {value && onClear && (
          <button
            type="button"
            className="ml-auto text-slate-500 hover:underline"
            onClick={onClear}
          >
            Quitar
          </button>
        )}
      </div>
      {options.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-slate-500">Publicado en la ficha:</p>
          {options.map((o, i) => (
            <button
              key={i}
              type="button"
              className="block w-full rounded-lg bg-emerald-50 px-2 py-1 text-left text-xs text-emerald-800 hover:bg-emerald-100"
              onClick={() =>
                onChange({
                  dist: { type: 'fixed', value: o.value_s },
                  origin: 'catalog',
                  note: o.note,
                })
              }
            >
              Usar {o.value_s} s · {o.note}
              {o.uncertain && ' (asignación de columna incierta en la ficha)'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
