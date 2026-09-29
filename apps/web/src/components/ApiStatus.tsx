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

  if (state.kind === 'loading')
    return <span className="text-xs text-slate-500">Comprobando API…</span>;
  if (state.kind === 'error')
    return <span className="text-xs text-red-600">API sin conexión: {state.message}</span>;
  const ok = state.health.supabase === 'ok';
  return (
    <span className={`text-xs ${ok ? 'text-emerald-700' : 'text-amber-700'}`}>
      API {state.health.version} · Supabase {ok ? 'conectado' : 'sin conexión'}
    </span>
  );
}
