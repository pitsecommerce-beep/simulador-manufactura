import { useEffect, useState } from 'react';
import type { Health } from '../lib/api';
import { useApp } from '../lib/context';

type State =
  { kind: 'loading' } | { kind: 'ok'; health: Health } | { kind: 'error'; message: string };

export function ApiStatus() {
  const { api } = useApp();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((health) => alive && setState({ kind: 'ok', health }))
      .catch((err: Error) => alive && setState({ kind: 'error', message: err.message }));
    return () => {
      alive = false;
    };
  }, [api]);

  const pill = (dot: string, text: string, title?: string) => (
    <span
      title={title}
      className="badge hidden gap-1.5 border border-slate-200 bg-white text-slate-600 sm:inline-flex"
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {text}
    </span>
  );
  if (state.kind === 'loading') return pill('bg-slate-300', 'Comprobando API…');
  if (state.kind === 'error')
    return pill('bg-red-500', `API sin conexión: ${state.message}`, state.message);
  const ok = state.health.supabase === 'ok';
  return pill(
    ok ? 'bg-emerald-500' : 'bg-amber-500',
    `API ${state.health.version} · Supabase ${ok ? 'conectado' : 'sin conexión'}`,
  );
}
