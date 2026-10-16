import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SimRun } from '@sim/domain';
import { afterEach, expect, it, vi } from 'vitest';
import type { Api } from '../src/lib/api';
import { AppProvider } from '../src/lib/context';
import { SimulationPanel } from '../src/sim/SimulationPanel';

const sb = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe() {} } } }),
  },
} as unknown as SupabaseClient;

const run = (status: SimRun['status'], progress: number | null = null): SimRun => ({
  id: 'run-1',
  project_id: 'p1',
  name: 'Turno',
  status,
  replications: 5,
  seed: 1,
  progress,
  error: null,
  summary: null,
  input: null,
  layout_version: 1,
  engine_version: null,
  events_path: status === 'succeeded' ? 'runs/run-1/events.json.gz' : null,
  created_at: new Date().toISOString(),
  started_at: null,
  finished_at: null,
});

afterEach(() => vi.useRealTimers());

it('muestra el progreso mientras simula y reproduce sola al terminar', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const listRuns = vi
    .fn()
    .mockResolvedValueOnce({ runs: [] })
    .mockResolvedValueOnce({ runs: [run('running', 0.4)] })
    .mockResolvedValue({ runs: [run('succeeded')] });
  const api = {
    listRuns,
    createRun: vi.fn().mockResolvedValue({ run: run('queued') }),
    getRun: vi.fn().mockResolvedValue({ run: run('succeeded'), metrics: [] }),
  } as unknown as Api;
  const onActive = vi.fn();
  const onFinished = vi.fn();
  render(
    <AppProvider supabase={sb} api={api}>
      <SimulationPanel
        projectId="p1"
        canEdit
        dirty={false}
        flowErrors={0}
        onPlay={() => {}}
        onActive={onActive}
        onFinished={onFinished}
      />
    </AppProvider>,
  );
  await screen.findByText('Aún no hay corridas.');
  fireEvent.click(screen.getByRole('button', { name: 'Simular' }));
  await waitFor(() =>
    expect(onActive).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'queued' })),
  );
  await act(async () => vi.advanceTimersByTime(3100));
  await waitFor(() =>
    expect(onActive).toHaveBeenLastCalledWith(expect.objectContaining({ progress: 0.4 })),
  );
  expect(onFinished).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(3100));
  await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  expect(onFinished.mock.calls[0]![0]).toMatchObject({ id: 'run-1', status: 'succeeded' });
  expect(onActive).toHaveBeenLastCalledWith(null);
});
