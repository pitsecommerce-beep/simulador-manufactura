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
