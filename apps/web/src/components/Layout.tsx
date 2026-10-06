import { Link, NavLink, Outlet, useMatch } from 'react-router-dom';
import { useApp } from '../lib/context';
import { ApiStatus } from './ApiStatus';
import { Disclaimer } from './Disclaimer';
import { Logo } from './ui';

export function Layout() {
  const { supabase, session } = useApp();
  const email = session?.user.email ?? '';
  // El editor de proyecto usa todo el ancho disponible.
  const wide = useMatch('/proyectos/:id') != null;
  const width = wide ? 'max-w-[1600px]' : 'max-w-5xl';
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div
          className={`mx-auto flex ${width} items-center justify-between gap-4 px-4 py-3 sm:px-6`}
        >
          <div className="flex items-center gap-3 sm:gap-6">
            <Link to="/" className="flex items-center gap-3 font-semibold">
              <Logo />
              <span className="hidden xl:inline">Simulador de líneas de producción</span>
            </Link>
            {session && (
              <nav className="flex items-center gap-1 text-sm">
                {[
                  ['/', 'Proyectos'],
                  ['/catalogo', 'Catálogo'],
                ].map(([to, label]) => (
                  <NavLink
                    key={to}
                    to={to!}
                    end={to === '/'}
                    className={({ isActive }) =>
                      `rounded-lg px-2.5 py-1.5 font-medium transition sm:px-3 ${
                        isActive
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-600 hover:bg-slate-100'
                      }`
                    }
                  >
                    {label}
                  </NavLink>
                ))}
              </nav>
            )}
          </div>
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
                  className="btn btn-secondary py-1.5 whitespace-nowrap"
                  onClick={() => supabase.auth.signOut()}
                >
                  <span className="sm:hidden">Salir</span>
                  <span className="hidden sm:inline">Cerrar sesión</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <Disclaimer width={width} />
      <main className={`mx-auto ${width} px-4 py-8 sm:px-6`}>
        <Outlet />
      </main>
    </div>
  );
}
