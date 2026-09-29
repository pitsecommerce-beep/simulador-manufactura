import type { Project } from '@sim/domain';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/context';

export function ProjectsPage() {
  const { api, session } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');

  const load = useCallback(() => {
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch((e: Error) => setError(e.message));
  }, [api]);

  useEffect(load, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createProject(name);
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">Proyectos</h1>
      <form onSubmit={onCreate} className="mb-6 flex gap-2">
        <input
          aria-label="Nombre del proyecto"
          placeholder="Nombre del nuevo proyecto"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border px-3 py-2"
          required
          maxLength={200}
        />
        <button className="rounded bg-slate-900 px-4 py-2 text-white">Crear</button>
      </form>
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {projects === null ? (
        <p className="text-slate-500">Cargando…</p>
      ) : projects.length === 0 ? (
        <p className="text-slate-500">Aún no tienes proyectos ni te han compartido ninguno.</p>
      ) : (
        <ul className="divide-y rounded border bg-white">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-3">
              <Link to={`/proyectos/${p.id}`} className="font-medium hover:underline">
                {p.name}
              </Link>
              <span className="text-xs text-slate-500">
                {p.owner_id === session?.user.id ? 'Propietario' : 'Compartido contigo'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
