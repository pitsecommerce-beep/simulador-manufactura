import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';

export function Logo({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <span
      className={`${className} inline-flex items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-5 w-5"
      >
        <path d="M4 20h16M7 20v-4l4-5 4 2 3-5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="11" cy="11" r="1.5" fill="currentColor" />
        <circle cx="18" cy="8" r="1.5" fill="currentColor" />
      </svg>
    </span>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode };

/** Campo de formulario con etiqueta asociada y ayuda opcional. */
export function Field({ label, hint, className, ...input }: FieldProps) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input id={id} className="input" {...input} />
      {hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Campo de contraseña con botón para mostrarla u ocultarla. */
export function PasswordField({ label, hint, className, ...input }: FieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <input id={id} className="input pr-20" type={visible ? 'text' : 'password'} {...input} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100"
        >
          {visible ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>
      {hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export function Message({ kind, children }: { kind: 'error' | 'success'; children: ReactNode }) {
  return kind === 'error' ? (
    <p role="alert" className="alert-error">
      {children}
    </p>
  ) : (
    <p role="status" className="alert-success">
      {children}
    </p>
  );
}
