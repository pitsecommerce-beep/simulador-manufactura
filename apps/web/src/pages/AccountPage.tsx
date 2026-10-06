import { useState, type FormEvent } from 'react';
import { Message, PasswordField, Spinner } from '../components/ui';
import { useApp } from '../lib/context';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';

export function AccountPage() {
  const { supabase, session } = useApp();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) {
      setMessage({ ok: false, text: problem });
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    setMessage(
      error ? { ok: false, text: error.message } : { ok: true, text: 'Contraseña actualizada.' },
    );
    if (!error) {
      setPassword('');
      setConfirm('');
    }
  }

  return (
    <section className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mi cuenta</h1>
        <p className="mt-1 text-sm text-slate-500">{session?.user.email}</p>
      </div>
      <div className="card p-6">
        <h2 className="font-semibold">Cambiar contraseña</h2>
        <p className="mt-1 mb-5 text-sm text-slate-500">
          Si entraste con un enlace de invitación o de recuperación, define aquí tu contraseña.
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <PasswordField
            label="Nueva contraseña"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres.`}
            required
          />
          <PasswordField
            label="Confirmar contraseña"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {message && <Message kind={message.ok ? 'success' : 'error'}>{message.text}</Message>}
          <button className="btn btn-primary w-full" disabled={busy}>
            {busy && <Spinner />}
            Guardar contraseña
          </button>
        </form>
      </div>
    </section>
  );
}
