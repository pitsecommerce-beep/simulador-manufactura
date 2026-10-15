import { fireEvent, render, screen } from '@testing-library/react';
import type { Timed } from '@sim/domain';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { TimedField } from '../src/editor/fields';

function Harness({
  initial,
  options = [],
}: {
  initial: Timed | null;
  options?: { value_s: number; note: string }[];
}) {
  const [v, setV] = useState<Timed | null>(initial);
  return (
    <>
      <TimedField
        label="Tiempo de ciclo"
        value={v}
        onChange={setV}
        options={options}
        hint="obligatorio"
      />
      <output data-testid="value">{JSON.stringify(v)}</output>
    </>
  );
}

const value = () => JSON.parse(screen.getByTestId('value').textContent!) as Timed | null;

it('empieza vacío y obligatorio; al capturarlo queda como supuesto del usuario', () => {
  render(<Harness initial={null} />);
  expect(screen.getByText(/Sin capturar: obligatorio/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/Valor/), { target: { value: '8' } });
  expect(value()).toEqual({ dist: { type: 'fixed', value: 8 }, origin: 'user', note: null });
  expect(screen.getByText('Supuesto del usuario')).toBeInTheDocument();
});

it('una distribución solo se aplica cuando todos sus parámetros están capturados', () => {
  render(<Harness initial={null} />);
  fireEvent.change(screen.getByLabelText('Tiempo de ciclo: distribución'), {
    target: { value: 'triangular' },
  });
  fireEvent.change(screen.getByLabelText(/Mín/), { target: { value: '4' } });
  fireEvent.change(screen.getByLabelText(/Moda/), { target: { value: '5' } });
  expect(value()).toBeNull();
  fireEvent.change(screen.getByLabelText(/Máx/), { target: { value: '9' } });
  expect(value()).toEqual({
    dist: { type: 'triangular', min: 4, mode: 5, max: 9 },
    origin: 'user',
    note: null,
  });
});

it('ofrece el ciclo publicado en la ficha con su condición y lo marca como dato del catálogo', () => {
  render(
    <Harness
      initial={null}
      options={[{ value_s: 0.54, note: '1 kg picking cycle 25 x 300 x 25 mm' }]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Usar 0.54 s/ }));
  expect(value()).toEqual({
    dist: { type: 'fixed', value: 0.54 },
    origin: 'catalog',
    note: '1 kg picking cycle 25 x 300 x 25 mm',
  });
  expect(screen.getByText('Ficha del catálogo')).toBeInTheDocument();
});
