import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { useApp } from './lib/context';
import { AccountPage } from './pages/AccountPage';
import { CatalogPage } from './pages/CatalogPage';
import { CatalogVariantPage } from './pages/CatalogVariantPage';
import { LoginPage } from './pages/LoginPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';

export function App() {
  const { session, loading } = useApp();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        <Spinner />
        <span className="ml-2 text-sm">Cargando…</span>
      </div>
    );
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          {session ? (
            <>
              <Route index element={<ProjectsPage />} />
              <Route path="proyectos/:id" element={<ProjectPage />} />
              <Route path="catalogo" element={<CatalogPage />} />
              <Route path="catalogo/:slug" element={<CatalogVariantPage />} />
              <Route path="cuenta" element={<AccountPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          ) : (
            <Route path="*" element={<LoginPage />} />
          )}
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
