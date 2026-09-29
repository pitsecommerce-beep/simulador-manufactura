import { useState, type FormEvent } from 'react';
import { useApp } from '../lib/context';

const MIN_LENGTH = 10;

export function AccountPage() {
  const { supabase, session } = useApp();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_LENGTH) {
      setMessage({
        ok: false,
        text: `La contraseña debe tener al menos ${MIN_LENGTH} caracteres.`,
      });
      return;
    }
    if (password !== confirm) {
      setMessage({ ok: false, text: 'Las contraseñas no coinciden.' });
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    setMessage(
      error ? { ok: false, text: error.message } : { ok: true, text: 'Contraseña actualizada.' },
    );
    if (!error) {
      setPassword('');
      setConfirm('');
    }
  }

  return (
    <section className="max-w-sm">
      <h1 className="mb-1 text-2xl font-semibold">Mi cuenta</h1>
      <p className="mb-4 text-sm text-slate-600">{session?.user.email}</p>
      <p className="mb-4 text-sm text-slate-600">
        Si entraste con un enlace de invitación o de recuperación, define aquí tu contraseña.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block text-sm">
          Nueva contraseña
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            required
          />
        </label>
        <label className="block text-sm">
          Confirmar contraseña
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            required
          />
        </label>
        {message && (
          <p
            role="status"
            className={`text-sm ${message.ok ? 'text-emerald-700' : 'text-red-600'}`}
          >
            {message.text}
          </p>
        )}
        <button className="rounded bg-slate-900 px-4 py-2 text-white">Guardar contraseña</button>
      </form>
    </section>
  );
}
