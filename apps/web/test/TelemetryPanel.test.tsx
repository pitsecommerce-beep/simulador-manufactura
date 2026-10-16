import { fireEvent, render, screen, within } from '@testing-library/react';
import { buildRobotModel, Scene, type EventLog, type SimEvent } from '@sim/domain';
import { describe, expect, it, vi } from 'vitest';
import { buildAnimation } from '../src/sim/animation';
import { PlayerBar } from '../src/sim/PlayerBar';
import { TelemetryPanel } from '../src/sim/TelemetryPanel';

const deg = (axis: number, min: number, max: number) => ({
  axis,
  min,
  max,
  unit: 'deg',
  max_speed: 300,
  speed_unit: 'deg/s',
});
const model = buildRobotModel({
  kinematic_type: 'serial',
  axes_count: 6,
  reach_mm: 1400,
  workspace_diameter_mm: null,
  payload_kg: 7,
  axis_limits: [
    deg(1, -180, 180),
    deg(2, -95, 155),
    deg(3, -210, 69),
    deg(4, -230, 230),
    deg(5, -130, 130),
    deg(6, -400, 400),
  ],
});
const fixed = (value: number) => ({ dist: { type: 'fixed', value }, origin: 'user', note: null });
const scene = Scene.parse({
  schema: 2,
  objects: [
    {
      id: 'in',
      name: 'Banda',
      kind: 'conveyor',
      position: [0, 700],
      color: '#475569',
      params: { length_mm: 1200, width_mm: 400, height_mm: 500 },
    },
    {
      id: 'r',
      name: 'Robot 1',
      kind: 'robot',
      position: [0, 0],
      color: '#f97316',
      params: { variant_slug: 'irb', wrist_camera: true },
    },
    {
      id: 'p',
      name: 'Pallet',
      kind: 'pallet',
      position: [0, -700],
      color: '#c08a4a',
      params: { preset: 'eur', length_mm: 1200, width_mm: 800, height_mm: 144 },
    },
  ],
  process: {
    product: { name: 'Caja', size_mm: { length_mm: 300, width_mm: 200, height_mm: 200 } },
    nodes: [
      { role: 'source', object_id: 'in', item: 'Caja', interarrival: fixed(4) },
      { role: 'station', object_id: 'r', cycle: fixed(4) },
      { role: 'sink', object_id: 'p', units_per_pallet: 10 },
    ],
    routes: [
      { id: 'a', from: 'in', to: 'r' },
      { id: 'b', from: 'r', to: 'p' },
    ],
  },
});
const events: SimEvent[] = [[0, 'st', 'r', 'idle']];
for (let k = 0; k < 5; k++) {
  const t = 1 + k * 4;
  events.push(
    [t, 'at', k + 1, 'in'],
    [t, 'at', k + 1, 'r'],
    [t, 'st', 'r', 'busy'],
    [t + 4, 'done', k + 1, 'r'],
    [t + 4, 'at', k + 1, 'p'],
    [t + 4, 'pal', 'p', k + 1],
    [t + 4, 'gone', k + 1],
  );
}
events.sort((a, b) => a[0] - b[0]);
const log: EventLog = {
  version: 2,
  start_s: 0,
  end_s: 30,
  replication: 0,
  truncated: false,
  events,
};
const data = buildAnimation(scene, log, () => model, new Map());

describe('telemetría de los robots', () => {
  it('muestra una fila por eje con comandado y ejecutado, y salta al instante elegido', () => {
    const onSeek = vi.fn();
    render(<TelemetryPanel data={data} t={3} onSeek={onSeek} />);
    expect(screen.getByRole('option', { name: 'Robot 1' })).toBeInTheDocument();
    // Cuatro ejes visibles y el resto detrás de "Mostrar los 6 ejes".
    expect(screen.getAllByRole('img', { name: /Gráfica de eje\d_deg/ })).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: /Mostrar los 6 ejes/ }));
    expect(screen.getAllByRole('img', { name: /Gráfica de eje\d_deg/ })).toHaveLength(6);
    expect(screen.getByText('-180 a 180 °')).toBeInTheDocument();
    expect(screen.getByText('Ciclos').nextSibling).toHaveTextContent('5');
    // Eventos de la garra con su hora; clic lleva a ese instante.
    const list = screen.getByText('Eventos').closest('div')!.parentElement!;
    const first = within(list).getByText('Cerrar garra (unidad 1)');
    fireEvent.click(first);
    expect(onSeek).toHaveBeenCalledWith(1 + 0.12 * 4);
    // Modo velocidad: una fila por eje con su máximo publicado.
    fireEvent.click(screen.getByRole('button', { name: 'Velocidad' }));
    expect(screen.getAllByText(/máx 300 °\/s/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeInTheDocument();
    expect(screen.getByText(/no del controlador real/)).toBeInTheDocument();
  });
});

describe('barra de reproducción', () => {
  it('ofrece mapa de calor, cámara de la herramienta y avisa que la animación es representativa', () => {
    const onHeat = vi.fn();
    const onCamera = vi.fn();
    render(
      <PlayerBar
        log={log}
        name="Corrida"
        t={2}
        playing={false}
        speed={5}
        heat={false}
        cameras={[{ id: 'r', name: 'Robot 1' }]}
        camera={null}
        warnings={['IRB no alcanza Banda']}
        onSeek={() => {}}
        onToggle={() => {}}
        onSpeed={() => {}}
        onHeat={onHeat}
        onCamera={onCamera}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('Mapa de calor'));
    expect(onHeat).toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByLabelText('Cámara'), { target: { value: 'r' } });
    expect(onCamera).toHaveBeenCalledWith('r');
    expect(screen.getByText(/Animación representativa/)).toBeInTheDocument();
    expect(screen.getByText('1 advertencia')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '0.5×' })).toBeInTheDocument();
  });
});
