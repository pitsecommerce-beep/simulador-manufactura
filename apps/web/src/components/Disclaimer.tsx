import { DISCLAIMERS } from '@sim/domain';

export function Disclaimer() {
  return (
    <div
      role="note"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900"
    >
      <strong>Aviso:</strong> {DISCLAIMERS.estimates}
    </div>
  );
}
