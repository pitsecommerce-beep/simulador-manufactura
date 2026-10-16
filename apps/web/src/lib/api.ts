import type {
  AssistantConversation,
  AssistantReply,
  AssistantStatus,
  CatalogComponent,
  CatalogFacets,
  CatalogQuery,
  CatalogVariant,
  CatalogVariantDetail,
  LayoutDoc,
  MemberRole,
  Project,
  ProjectAccess,
  ProjectMember,
  ProcessIssue,
  RunConfig,
  Scene,
  SimMetric,
  SimRun,
  EventLog,
  ProposalStatus,
} from '@sim/domain';

export class ApiError extends Error {
  readonly status: number;
  /** Problemas del modelo de proceso cuando la api rechaza una corrida. */
  readonly issues: ProcessIssue[];
  constructor(status: number, message: string, issues: ProcessIssue[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
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
    if (!res.ok)
      throw new ApiError(res.status, body.message ?? `Error ${res.status}`, body.issues ?? []);
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
    getLayout: (projectId: string) => request<LayoutDoc>(`/v1/projects/${projectId}/layout`),
    saveLayout: (projectId: string, scene: Scene, version: number | null) =>
      request<LayoutDoc>(`/v1/projects/${projectId}/layout`, {
        method: 'PUT',
        body: JSON.stringify({ scene, version }),
      }),
    createRun: (projectId: string, config: RunConfig) =>
      request<{ run: SimRun }>(`/v1/projects/${projectId}/runs`, {
        method: 'POST',
        body: JSON.stringify(config),
      }),
    listRuns: (projectId: string) => request<{ runs: SimRun[] }>(`/v1/projects/${projectId}/runs`),
    getRun: (projectId: string, runId: string) =>
      request<{ run: SimRun; metrics: SimMetric[] }>(`/v1/projects/${projectId}/runs/${runId}`),
    getRunEvents: (projectId: string, runId: string) =>
      request<EventLog>(`/v1/projects/${projectId}/runs/${runId}/events`),
    listComponents: () => request<{ components: CatalogComponent[] }>('/v1/catalog/components'),
    catalogFacets: () => request<CatalogFacets>('/v1/catalog/facets'),
    assistantStatus: () => request<AssistantStatus>('/v1/assistant/status'),
    askAssistant: (
      projectId: string,
      body: { conversation_id: string | null; message: string; current_scene: Scene },
    ) =>
      request<AssistantReply>(`/v1/projects/${projectId}/assistant`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listConversations: (projectId: string) =>
      request<{ conversations: { id: string; title: string | null; updated_at: string }[] }>(
        `/v1/projects/${projectId}/assistant/conversations`,
      ),
    getConversation: (projectId: string, id: string) =>
      request<{ conversation: AssistantConversation }>(
        `/v1/projects/${projectId}/assistant/conversations/${id}`,
      ),
    setProposalStatus: (
      projectId: string,
      conversationId: string,
      proposalId: string,
      status: ProposalStatus,
    ) =>
      request<{ conversation: AssistantConversation }>(
        `/v1/projects/${projectId}/assistant/conversations/${conversationId}/proposals/${proposalId}`,
        { method: 'PATCH', body: JSON.stringify({ status }) },
      ),
    getCatalogVariant: (slug: string) =>
      request<CatalogVariantDetail>(`/v1/catalog/variants/${encodeURIComponent(slug)}`),
  };
}

export type Api = ReturnType<typeof createApi>;
