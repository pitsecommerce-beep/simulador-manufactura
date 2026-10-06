import type { Project } from '@sim/domain';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Message, Spinner } from '../components/ui';
import { useApp } from '../lib/context';

export function ProjectsPage() {
  const { api, session } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    try {
      await api.createProject(name.trim());
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Proyectos</h1>
        <p className="mt-1 text-sm text-slate-500">
          Tus líneas de producción y las que otros compartieron contigo.
        </p>
      </div>

      <form onSubmit={onCreate} className="card flex flex-col gap-3 p-4 sm:flex-row">
        <input
          aria-label="Nombre del proyecto"
          placeholder="Nombre del nuevo proyecto"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input flex-1"
          required
          maxLength={200}
        />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy && <Spinner />}
          Crear proyecto
        </button>
      </form>

      {error && <Message kind="error">{error}</Message>}

      {projects === null ? (
        !error && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Cargando…
          </p>
        )
      ) : projects.length === 0 ? (
        <div className="card border-dashed p-10 text-center">
          <p className="font-medium">Aún no tienes proyectos</p>
          <p className="mt-1 text-sm text-slate-500">
            Crea el primero arriba o pide a alguien que comparta uno contigo.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const mine = p.owner_id === session?.user.id;
            return (
              <li key={p.id}>
                <Link
                  to={`/proyectos/${p.id}`}
                  className="card group flex h-full flex-col gap-3 p-5 transition hover:-translate-y-0.5 hover:border-brand-500 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 font-semibold text-brand-700 uppercase">
                      {p.name.slice(0, 1)}
                    </span>
                    <span
                      className={`badge ${mine ? 'bg-slate-100 text-slate-600' : 'bg-brand-50 text-brand-700'}`}
                    >
                      {mine ? 'Propietario' : 'Compartido contigo'}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium group-hover:text-brand-700">{p.name}</p>
                    {p.description && (
                      <p className="mt-1 line-clamp-2 text-sm text-slate-500">{p.description}</p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
