import type {
  CatalogFacets,
  CatalogQuery,
  CatalogVariant,
  CatalogVariantDetail,
  MemberRole,
  Project,
  ProjectAccess,
  ProjectMember,
} from '@sim/domain';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Health {
  status: string;
  service: string;
  version: string;
  supabase: 'ok' | 'error';
}

export function createApi(baseUrl: string, getToken: () => Promise<string | null>) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getToken();
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new ApiError(0, 'No se pudo conectar con la API');
    }
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.message ?? `Error ${res.status}`);
    return body as T;
  }

  return {
    health: () => request<Health>('/health'),
    listProjects: () => request<{ projects: Project[] }>('/v1/projects'),
    createProject: (name: string, description?: string) =>
      request<{ project: Project }>('/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name, description }),
      }),
    getProject: (id: string) =>
      request<{ project: Project; members: ProjectMember[]; access: ProjectAccess | null }>(
        `/v1/projects/${id}`,
      ),
    shareProject: (id: string, email: string, role: MemberRole) =>
      request<{ user_id: string; role: MemberRole }>(`/v1/projects/${id}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, role }),
      }),
    removeMember: (id: string, userId: string) =>
      request<void>(`/v1/projects/${id}/members/${userId}`, { method: 'DELETE' }),
    listCatalog: (query: Partial<Record<keyof CatalogQuery, string | number>> = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query))
        if (v !== '' && v != null) params.set(k, String(v));
      const qs = params.toString();
      return request<{ variants: CatalogVariant[]; total: number }>(
        `/v1/catalog/variants${qs ? `?${qs}` : ''}`,
      );
    },
    catalogFacets: () => request<CatalogFacets>('/v1/catalog/facets'),
    getCatalogVariant: (slug: string) =>
      request<CatalogVariantDetail>(`/v1/catalog/variants/${encodeURIComponent(slug)}`),
  };
}

export type Api = ReturnType<typeof createApi>;
