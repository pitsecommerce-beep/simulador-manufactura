import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import type { Api } from '../src/lib/api';
import { AppProvider } from '../src/lib/context';
import { LoginPage } from '../src/pages/LoginPage';

function fakeSupabase(signInError: unknown = null) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: vi.fn().mockResolvedValue({ error: signInError }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
    },
  } as unknown as SupabaseClient & { auth: Record<string, ReturnType<typeof vi.fn>> };
}

function renderLogin(sb: SupabaseClient) {
  render(
    <AppProvider supabase={sb} api={{} as Api}>
      <LoginPage />
    </AppProvider>,
  );
}

it('muestra un error genérico si las credenciales fallan', async () => {
  const sb = fakeSupabase({ message: 'Invalid login credentials' });
  renderLogin(sb);
  fireEvent.change(screen.getByLabelText('Correo'), { target: { value: 'a@b.mx' } });
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Correo o contraseña incorrectos.');
  expect(sb.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.mx', password: 'x' });
});

it('pide el correo antes de enviar el enlace de recuperación', async () => {
  const sb = fakeSupabase();
  renderLogin(sb);
  fireEvent.click(screen.getByRole('button', { name: '¿Olvidaste tu contraseña?' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Escribe tu correo/);
  fireEvent.change(screen.getByLabelText('Correo'), { target: { value: 'a@b.mx' } });
  fireEvent.click(screen.getByRole('button', { name: '¿Olvidaste tu contraseña?' }));
  await waitFor(() => expect(sb.auth.resetPasswordForEmail).toHaveBeenCalled());
});
