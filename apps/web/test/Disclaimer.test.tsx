import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Disclaimer } from '../src/components/Disclaimer';

it('muestra el aviso de estimaciones', () => {
  render(<Disclaimer />);
  expect(screen.getByRole('note')).toHaveTextContent(/ESTIMACIONES/);
  expect(screen.getByRole('note')).toHaveTextContent(/RobotStudio/);
});
