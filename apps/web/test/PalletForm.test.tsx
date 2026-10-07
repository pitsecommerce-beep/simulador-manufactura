import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PalletForm } from '../src/editor/dialogs';

it('EUR trae su altura publicada; GMA exige capturarla y muestra la ayuda sin guardarla', () => {
  const onAdd = vi.fn();
  render(<PalletForm onAdd={onAdd} onClose={() => {}} />);
  const add = screen.getByRole('button', { name: 'Añadir pallet' });
  expect(screen.getByLabelText(/Alto/)).toHaveValue(144);
  expect(add).toBeEnabled();

  fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'gma' } });
  expect(screen.getByLabelText(/Largo/)).toHaveValue(1219);
  expect(screen.getByLabelText(/Alto/)).toHaveValue(null);
  expect(screen.getAllByText('EUR publicado: 144 mm').length).toBeGreaterThan(0);
  expect(add).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/Alto/), { target: { value: '150' } });
  fireEvent.click(add);
  expect(onAdd).toHaveBeenCalledWith({
    kind: 'pallet',
    preset: 'gma',
    length_mm: 1219,
    width_mm: 1016,
    height_mm: 150,
  });
});
