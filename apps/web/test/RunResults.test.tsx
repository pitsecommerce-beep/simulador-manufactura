import { render, screen } from '@testing-library/react';
import type { SimMetric, SimRun } from '@sim/domain';
import { expect, it } from 'vitest';
import { RunCompare } from '../src/sim/RunCompare';
import { RunResults } from '../src/sim/RunResults';

const m = (
  metric: string,
  mean: number,
  ci: [number, number] | null,
  scope = 'line',
  unit = 'u/h',
): SimMetric => ({
  metric,
  scope,
  label: null,
  unit,
  replication: null,
  value: mean,
  min: mean - 5,
  mean,
  max: mean + 5,
  p5: mean - 4,
  p95: mean + 4,
  ci_low: ci?.[0] ?? null,
  ci_high: ci?.[1] ?? null,
});

const run = (name: string, takt: number | null): SimRun => ({
  id: name,
  project_id: 'p',
  name,
  status: 'succeeded',
  replications: 10,
  seed: 1,
  progress: 1,
  error: null,
  summary: {
    bottleneck: { node: 'st', name: 'Mesa', busy_failed: 0.9, second: null },
    assumptions: ['Mesa: ciclo 8 s (supuesto del usuario)'],
    notes: [],
    representative_replication: 0,
    takt_time_s: takt,
  },
  input: null,
  layout_version: 1,
  engine_version: 'test',
  events_path: null,
  created_at: '2026-10-07T00:00:00Z',
  started_at: null,
  finished_at: null,
});

it('muestra indicadores con rango, aviso de estimación, supuestos y takt sin demanda', () => {
  render(<RunResults run={run('A', null)} metrics={[m('throughput_per_hour', 300, [290, 310])]} />);
  expect(screen.getByRole('note')).toHaveTextContent(/No son garantías de rendimiento/);
  expect(screen.getByText('300 u/h')).toBeInTheDocument();
  expect(screen.getByText(/IC 95 % 290 a 310/)).toBeInTheDocument();
  expect(screen.getByText('requiere demanda')).toBeInTheDocument();
  expect(screen.getByText(/Cuello de botella:/).parentElement).toHaveTextContent(
    /Mesa \(ocupada o en falla 90 %/,
  );
  expect(screen.getByText('Mesa: ciclo 8 s (supuesto del usuario)')).toBeInTheDocument();
});

it('avisa cuando el tiempo de ciclo supera el takt', () => {
  render(
    <RunResults run={run('A', 10)} metrics={[m('line_cycle_time_s', 12, null, 'line', 's/u')]} />,
  );
  expect(screen.getByText(/No alcanza la demanda/)).toBeInTheDocument();
});

it('compara dos corridas y distingue diferencias concluyentes de las que no lo son', () => {
  const a = {
    run: run('A', null),
    metrics: [m('throughput_per_hour', 300, [295, 305]), m('wip_avg', 3, [2.5, 3.5], 'line', 'u')],
  };
  const b = {
    run: run('B', null),
    metrics: [
      m('throughput_per_hour', 280, [275, 285]),
      m('wip_avg', 3.2, [2.8, 3.6], 'line', 'u'),
    ],
  };
  render(<RunCompare a={a} b={b} />);
  expect(screen.getByText('B empeora')).toBeInTheDocument(); // producción baja y los IC no se solapan
  expect(screen.getByText(/no concluyente/)).toBeInTheDocument(); // WIP con IC solapados
});
