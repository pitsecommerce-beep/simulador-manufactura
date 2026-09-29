import { Link, Outlet } from 'react-router-dom';
import { useApp } from '../lib/context';
import { ApiStatus } from './ApiStatus';
import { Disclaimer } from './Disclaimer';

export function Layout() {
  const { supabase, session } = useApp();
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b bg-white px-4 py-3">
        <Link to="/" className="font-semibold">
          Simulador de líneas de producción
        </Link>
        <div className="flex items-center gap-4">
          <ApiStatus />
          {session && (
            <>
              <Link to="/cuenta" className="text-sm text-slate-600 hover:underline">
                {session.user.email}
              </Link>
              <button
                className="rounded border px-3 py-1 text-sm hover:bg-slate-100"
                onClick={() => supabase.auth.signOut()}
              >
                Cerrar sesión
              </button>
            </>
          )}
        </div>
      </header>
      <Disclaimer />
      <main className="mx-auto max-w-4xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
