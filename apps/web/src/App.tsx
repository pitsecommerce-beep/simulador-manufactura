import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { useApp } from './lib/context';
import { AccountPage } from './pages/AccountPage';
import { LoginPage } from './pages/LoginPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';

export function App() {
  const { session, loading } = useApp();
  if (loading) return <p className="p-6 text-slate-500">Cargando…</p>;
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          {session ? (
            <>
              <Route index element={<ProjectsPage />} />
              <Route path="proyectos/:id" element={<ProjectPage />} />
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
