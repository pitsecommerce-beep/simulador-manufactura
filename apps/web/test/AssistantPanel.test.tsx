import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  emptyScene,
  type AiProposal,
  type AssistantConversation,
  type AssistantReply,
} from '@sim/domain';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../src/assistant/AssistantPanel';
import { ApiError, type Api } from '../src/lib/api';
import { AppProvider } from '../src/lib/context';

const sb = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe() {} } } }),
  },
} as unknown as SupabaseClient;

const proposal: AiProposal = {
  id: '11111111-1111-4111-8111-111111111111',
  created_at: '2026-10-16T10:00:00Z',
  summary: 'Celda con un IRB 460',
  scene: emptyScene(),
  warnings: [
    {
      kind: 'reach',
      level: 'warning',
      objects: ['p'],
      message: 'Pallet está fuera del alcance de Robot (excede 120 mm).',
    },
  ],
  process_issues: [],
  assumptions: ['Banda de 2 m (supuesto)'],
  robots: [
    {
      slug: 'irb-460-110-2-4',
      variant_code: 'IRB 460-110/2.4',
      model: 'IRB 460',
      family: 'Palletizing 4-axis',
      kinematic_type: 'parallel_linkage',
    },
  ],
  components: [],
  estimate: {
    run_id: 'r',
    replications: 5,
    horizon_h: 8,
    throughput_per_hour: { mean: 355, low: 345, high: 359 },
    bottleneck: 'Robot',
  },
  status: 'pending',
};

const conversation = (over: Partial<AssistantConversation> = {}): AssistantConversation => ({
  id: '22222222-2222-4222-8222-222222222222',
  project_id: 'p1',
  title: 'Paletizado',
  model: 'claude-sonnet-5-5',
  transcript: [
    { role: 'user', text: 'Paletizado de cajas', at: '' },
    { role: 'assistant', text: 'Te propongo un IRB 460.', at: '', proposal_ids: [proposal.id] },
  ],
  proposals: [proposal],
  tokens_in: 0,
  tokens_out: 0,
  updated_at: '',
  ...over,
});

function setup(api: Partial<Api>, canEdit = true) {
  const full = {
    assistantStatus: vi.fn().mockResolvedValue({
      configured: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      limits: { requests_per_day: 30, tokens_per_day: 1_000_000 },
    }),
    listConversations: vi.fn().mockResolvedValue({ conversations: [] }),
    ...api,
  } as unknown as Api;
  const props = {
    onPreview: vi.fn(),
    onAccept: vi.fn(),
    onUndo: vi.fn(),
    onClose: vi.fn(),
  };
  const scene = emptyScene();
  render(
    <AppProvider supabase={sb} api={full}>
      <MemoryRouter>
        <AssistantPanel
          projectId="p1"
          canEdit={canEdit}
          scene={scene}
          previewId={null}
          canUndo={false}
          {...props}
        />
      </MemoryRouter>
    </AppProvider>,
  );
  return { api: full, props, scene };
}

describe('panel del asistente', () => {
  it('envía la escena actual, muestra la propuesta y la acepta fusionándola', async () => {
    const reply: AssistantReply = {
      conversation: conversation(),
      proposals: [proposal],
      limit: null,
    };
    const askAssistant = vi.fn().mockResolvedValue(reply);
    const setProposalStatus = vi.fn().mockResolvedValue({
      conversation: conversation({ proposals: [{ ...proposal, status: 'accepted' }] }),
    });
    const { props, scene } = setup({ askAssistant, setProposalStatus });

    fireEvent.change(await screen.findByLabelText('Mensaje al asistente'), {
      target: { value: 'Paletizado de cajas' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByText('Te propongo un IRB 460.')).toBeInTheDocument();
    expect(askAssistant).toHaveBeenCalledWith('p1', {
      conversation_id: null,
      message: 'Paletizado de cajas',
      current_scene: scene,
    });
    // La propuesta nueva se muestra en la cuadrícula.
    expect(props.onPreview).toHaveBeenCalledWith(proposal);
    expect(screen.getByRole('link', { name: 'IRB 460-110/2.4' })).toHaveAttribute(
      'href',
      '/catalogo/irb-460-110-2-4',
    );
    expect(screen.getByText('355 u/h')).toBeInTheDocument();
    expect(screen.getByText(/rango 345 a 359/)).toBeInTheDocument();
    expect(screen.getByText(/fuera del alcance/)).toBeInTheDocument();
    expect(screen.getAllByText(/Ícono paramétrico/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Aceptar (fusionar)' }));
    await waitFor(() => expect(props.onAccept).toHaveBeenCalledWith(proposal, 'merge'));
    expect(setProposalStatus).toHaveBeenCalledWith(
      'p1',
      conversation().id,
      proposal.id,
      'accepted',
    );
    expect(await screen.findByText('Aceptada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aceptar (reemplazar)' })).toBeNull();
  });

  it('muestra el mensaje del límite diario sin tratarlo como error', async () => {
    const askAssistant = vi
      .fn()
      .mockRejectedValue(
        new ApiError(429, 'Alcanzaste el límite de 30 mensajes al asistente por día.'),
      );
    setup({ askAssistant });
    fireEvent.change(await screen.findByLabelText('Mensaje al asistente'), {
      target: { value: 'otra' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/límite de 30 mensajes/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('avisa cuando el asistente no está configurado y no muestra el formulario', async () => {
    setup({
      assistantStatus: vi
        .fn()
        .mockResolvedValue({ configured: false, provider: null, model: null, limits: null }),
    });
    expect(await screen.findByText(/no está configurado/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Mensaje al asistente')).toBeNull();
  });

  it('un lector no puede escribir al asistente', async () => {
    setup({}, false);
    expect(await screen.findByText(/Solo el propietario y los editores/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Mensaje al asistente')).toBeNull();
  });
});
