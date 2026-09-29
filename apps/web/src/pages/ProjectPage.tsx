import type { MemberRole, Project, ProjectAccess, ProjectMember } from '@sim/domain';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../lib/context';

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

  if (!data) return <p className="text-slate-500">{error ?? 'Cargando…'}</p>;
  const isOwner = data.access === 'owner';

  return (
    <section className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-slate-500 hover:underline">
          ← Proyectos
        </Link>
        <h1 className="text-2xl font-semibold">{data.project.name}</h1>
        {data.access && <p className="text-sm text-slate-600">Tu rol: {ROLE_LABEL[data.access]}</p>}
      </div>

      <div className="rounded border border-dashed bg-white p-6 text-center text-slate-500">
        El lienzo 3D y la simulación llegan en las fases 3 y 4.
      </div>

      <div>
        <h2 className="mb-2 font-semibold">Miembros</h2>
        {data.members.length === 0 ? (
          <p className="text-sm text-slate-500">Solo tú tienes acceso.</p>
        ) : (
          <ul className="divide-y rounded border bg-white">
            {data.members.map((m) => (
              <li key={m.user_id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>{m.display_name ?? m.email ?? m.user_id}</span>
                <span className="flex items-center gap-3">
                  {ROLE_LABEL[m.role]}
                  {isOwner && (
                    <button
                      className="text-red-600 hover:underline"
                      onClick={() => onRemove(m.user_id)}
                    >
                      Quitar
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isOwner && (
        <form onSubmit={onShare} className="flex flex-wrap gap-2">
          <input
            type="email"
            aria-label="Correo del miembro"
            placeholder="correo@empresa.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1 rounded border px-3 py-2"
            required
          />
          <select
            aria-label="Rol"
            value={role}
            onChange={(e) => setRole(e.target.value as MemberRole)}
            className="rounded border px-3 py-2"
          >
            <option value="viewer">Lector</option>
            <option value="editor">Editor</option>
          </select>
          <button className="rounded bg-slate-900 px-4 py-2 text-white">Compartir</button>
        </form>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
