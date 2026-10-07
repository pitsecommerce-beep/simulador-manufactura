import type { ProcessIssue, SceneWarning } from '@sim/domain';
import { useState } from 'react';

const KIND_LABEL: Record<SceneWarning['kind'], string> = {
  reach: 'Alcance',
  payload: 'Carga',
  collision: 'Colisión',
  safety: 'Seguridad',
  data: 'Datos',
};

const LEVEL_STYLE = {
  error: 'bg-red-50 text-red-800 hover:bg-red-100',
  warning: 'bg-amber-50 text-amber-900 hover:bg-amber-100',
  info: 'bg-slate-50 text-slate-600 hover:bg-slate-100',
} as const;
const LEVEL_ICON = { error: '✕', warning: '⚠', info: 'ℹ' } as const;

/** Validaciones del layout (alcance, carga, colisiones) y del flujo de proceso. */
export function Warnings({
  warnings,
  processIssues,
  onSelect,
}: {
  warnings: SceneWarning[];
  processIssues: ProcessIssue[];
  onSelect: (id: string) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const rows = [
    ...processIssues.map((i) => ({
      level: i.level,
      label: 'Flujo',
      objects: i.objects,
      message: i.message,
    })),
    ...warnings.map((w) => ({
      level: w.level,
      label: KIND_LABEL[w.kind],
      objects: w.objects,
      message: w.message,
    })),
  ].sort(
    (a, b) =>
      ['error', 'warning', 'info'].indexOf(a.level) - ['error', 'warning', 'info'].indexOf(b.level),
  );
  if (rows.length === 0) return null;
  const infos = rows.filter((r) => r.level === 'info').length;
  const shown = showInfo ? rows : rows.filter((r) => r.level !== 'info');

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Validaciones</h3>
        {infos > 0 && (
          <button
            className="btn btn-ghost px-2 py-0.5 text-xs"
            onClick={() => setShowInfo((v) => !v)}
          >
            {showInfo
              ? 'Ocultar notas'
              : `Ver ${infos} nota${infos > 1 ? 's' : ''} (supuestos y datos)`}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-emerald-700">Sin errores ni advertencias.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {shown.map((w, i) => (
            <li key={i}>
              <button
                onClick={() => w.objects[0] && onSelect(w.objects[0])}
                className={`w-full rounded-lg px-3 py-2 text-left ${LEVEL_STYLE[w.level]}`}
              >
                <span className="mr-2 font-medium">
                  {LEVEL_ICON[w.level]} {w.label}:
                </span>
                {w.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
