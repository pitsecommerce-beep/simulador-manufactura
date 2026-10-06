import { DISCLAIMERS } from '@sim/domain';

export function Disclaimer() {
  return (
    <div className="mx-auto max-w-5xl px-4 pt-4 sm:px-6">
      <div
        role="note"
        className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900"
      >
        <strong>Aviso:</strong> {DISCLAIMERS.estimates}
      </div>
    </div>
  );
}
