import type { MemberRole, Project, ProjectAccess, ProjectMember } from '@sim/domain';
import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Message, Spinner } from '../components/ui';
import { useApp } from '../lib/context';

// El editor 3D (three.js) se descarga solo al abrir un proyecto.
const LayoutEditor = lazy(() => import('../editor/LayoutEditor'));

const ROLE_LABEL: Record<ProjectAccess, string> = {
  owner: 'Propietario',
  editor: 'Editor',
  viewer: 'Lector',
};

export function ProjectPage() {
  const { id = '' } = useParams();
  const { api } = useApp();
  const [data, setData] = useState<{
    project: Project;
    members: ProjectMember[];
    access: ProjectAccess | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('viewer');

  const load = useCallback(() => {
    api
      .getProject(id)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [api, id]);
  useEffect(load, [load]);

  async function onShare(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.shareProject(id, email, role);
      setEmail('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onRemove(userId: string) {
    try {
      await api.removeMember(id, userId);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!data)
    return error ? (
      <Message kind="error">{error}</Message>
    ) : (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Cargando…
      </p>
    );
  const isOwner = data.access === 'owner';

  return (
    <section className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-700">
          ← Proyectos
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{data.project.name}</h1>
          {data.access && (
            <span className="badge bg-brand-50 text-brand-700">
              Tu rol: {ROLE_LABEL[data.access]}
            </span>
          )}
        </div>
        {data.project.description && (
          <p className="mt-1 text-sm text-slate-500">{data.project.description}</p>
        )}
      </div>

      <Suspense
        fallback={
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Cargando editor…
          </p>
        }
      >
        <LayoutEditor
          projectId={id}
          canEdit={data.access === 'owner' || data.access === 'editor'}
        />
      </Suspense>

      <div className="card p-6">
        <h2 className="font-semibold">Miembros</h2>
        <p className="mt-1 mb-4 text-sm text-slate-500">
          Los lectores pueden ver el proyecto; los editores también pueden modificarlo.
        </p>
        {data.members.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
            Solo tú tienes acceso.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {data.members.map((m) => {
              const label = m.display_name ?? m.email ?? m.user_id;
              return (
                <li
                  key={m.user_id}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 uppercase">
                      {label.slice(0, 1)}
                    </span>
                    <span className="truncate">{label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="badge bg-slate-100 text-slate-600">{ROLE_LABEL[m.role]}</span>
                    {isOwner && (
                      <button className="btn btn-danger" onClick={() => onRemove(m.user_id)}>
                        Quitar
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {isOwner && (
          <form onSubmit={onShare} className="mt-5 flex flex-col gap-3 sm:flex-row">
            <input
              type="email"
              aria-label="Correo del miembro"
              placeholder="correo@empresa.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input flex-1"
              required
            />
            <select
              aria-label="Rol"
              value={role}
              onChange={(e) => setRole(e.target.value as MemberRole)}
              className="input sm:w-36"
            >
              <option value="viewer">Lector</option>
              <option value="editor">Editor</option>
            </select>
            <button className="btn btn-primary">Compartir</button>
          </form>
        )}
        {error && (
          <div className="mt-4">
            <Message kind="error">{error}</Message>
          </div>
        )}
      </div>
    </section>
  );
}
