import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import type { Api } from '../src/lib/api';
import { AppProvider } from '../src/lib/context';
import { LoginPage } from '../src/pages/LoginPage';

function fakeSupabase(
  signInError: unknown = null,
  signUp: { data: unknown; error: unknown } = { data: { session: null }, error: null },
) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: vi.fn().mockResolvedValue({ error: signInError }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
      signUp: vi.fn().mockResolvedValue(signUp),
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

function fillSignUp(password: string, confirm = password) {
  fireEvent.click(screen.getByRole('tab', { name: 'Crear cuenta' }));
  fireEvent.change(screen.getByLabelText('Correo'), { target: { value: 'nuevo@b.mx' } });
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirmar contraseña'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));
}

it('valida la contraseña antes de registrar', async () => {
  const sb = fakeSupabase();
  renderLogin(sb);
  fillSignUp('corta');
  expect(await screen.findByRole('alert')).toHaveTextContent(/al menos 10 caracteres/);
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'unaclave-larga' } });
  fireEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Las contraseñas no coinciden.');
  expect(sb.auth.signUp).not.toHaveBeenCalled();
});

it('registra con correo y contraseña y pide confirmar el correo', async () => {
  const sb = fakeSupabase();
  renderLogin(sb);
  fillSignUp('unaclave-larga');
  expect(await screen.findByRole('status')).toHaveTextContent(/Te enviamos un correo a nuevo@b.mx/);
  expect(sb.auth.signUp).toHaveBeenCalledWith(
    expect.objectContaining({ email: 'nuevo@b.mx', password: 'unaclave-larga' }),
  );
  expect(screen.getByRole('tab', { name: 'Iniciar sesión' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

it('avisa si el correo ya tiene cuenta', async () => {
  const sb = fakeSupabase(null, { data: {}, error: { message: 'User already registered' } });
  renderLogin(sb);
  fillSignUp('unaclave-larga');
  expect(await screen.findByRole('alert')).toHaveTextContent(/ya tiene una cuenta/);
});
