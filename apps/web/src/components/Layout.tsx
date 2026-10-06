import { Link, NavLink, Outlet } from 'react-router-dom';
import { useApp } from '../lib/context';
import { ApiStatus } from './ApiStatus';
import { Disclaimer } from './Disclaimer';
import { Logo } from './ui';

export function Layout() {
  const { supabase, session } = useApp();
  const email = session?.user.email ?? '';
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link to="/" className="flex items-center gap-3 font-semibold">
            <Logo />
            <span className="hidden sm:inline">Simulador de líneas de producción</span>
          </Link>
          <div className="flex items-center gap-2 sm:gap-3">
            <ApiStatus />
            {session && (
              <>
                <NavLink
                  to="/cuenta"
                  title={email}
                  className="flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm text-slate-600 hover:bg-slate-100"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 uppercase">
                    {email.slice(0, 1)}
                  </span>
                  <span className="hidden max-w-48 truncate md:inline">{email}</span>
                </NavLink>
                <button
                  className="btn btn-secondary py-1.5"
                  onClick={() => supabase.auth.signOut()}
                >
                  Cerrar sesión
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <Disclaimer />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
