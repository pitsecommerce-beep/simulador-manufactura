import { useState, type FormEvent } from 'react';
import { useApp } from '../lib/context';

export function LoginPage() {
  const { supabase } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  async function onForgot() {
    setError(null);
    if (!email) {
      setError('Escribe tu correo para enviarte el enlace.');
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/cuenta`,
    });
    // No se revela si el correo existe.
    if (error) setError('No se pudo enviar el enlace. Intenta más tarde.');
    else
      setInfo('Si el correo pertenece al equipo, recibirás un enlace para definir tu contraseña.');
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError('Correo o contraseña incorrectos.');
  }

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-lg border bg-white p-6 shadow-sm">
      <h1 className="mb-1 text-xl font-semibold">Iniciar sesión</h1>
      <p className="mb-4 text-sm text-slate-600">
        El acceso es solo por invitación. Pide a un administrador que te invite desde Supabase.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block text-sm">
          Correo
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          Contraseña
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {info && <p className="text-sm text-emerald-700">{info}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        <button
          type="button"
          onClick={onForgot}
          className="w-full text-sm text-slate-600 hover:underline"
        >
          ¿Olvidaste tu contraseña?
        </button>
      </form>
    </div>
  );
}
