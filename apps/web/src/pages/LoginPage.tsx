import { useState, type FormEvent } from 'react';
import { Field, Logo, Message, PasswordField, Spinner } from '../components/ui';
import { useApp } from '../lib/context';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';

type Mode = 'login' | 'signup';
type Feedback = { kind: 'error' | 'success'; text: string } | null;

function signUpError(message: string): string {
  if (/already registered|already exists/i.test(message))
    return 'Ese correo ya tiene una cuenta. Inicia sesión.';
  if (/password/i.test(message)) return 'La contraseña no cumple los requisitos de seguridad.';
  return 'No se pudo crear la cuenta. Intenta más tarde.';
}

export function LoginPage() {
  const { supabase } = useApp();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setFeedback(null);
    setPassword('');
    setConfirm('');
  }

  async function onForgot() {
    setFeedback(null);
    if (!email) {
      setFeedback({ kind: 'error', text: 'Escribe tu correo para enviarte el enlace.' });
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/cuenta`,
    });
    // No se revela si el correo existe.
    setFeedback(
      error
        ? { kind: 'error', text: 'No se pudo enviar el enlace. Intenta más tarde.' }
        : {
            kind: 'success',
            text: 'Si el correo tiene cuenta, recibirás un enlace para definir tu contraseña.',
          },
    );
  }

  async function onLogin() {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) return;
    setFeedback({
      kind: 'error',
      text: /not confirmed/i.test(error.message)
        ? 'Confirma tu correo con el enlace que te enviamos antes de entrar.'
        : 'Correo o contraseña incorrectos.',
    });
  }

  async function onSignUp() {
    const problem = passwordProblem(password, confirm);
    if (problem) {
      setFeedback({ kind: 'error', text: problem });
      return;
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) {
      setFeedback({ kind: 'error', text: signUpError(error.message) });
      return;
    }
    // Con confirmación de correo activa no hay sesión hasta abrir el enlace.
    if (!data.session) {
      switchMode('login');
      setFeedback({
        kind: 'success',
        text: `Te enviamos un correo a ${email}. Abre el enlace para activar tu cuenta.`,
      });
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      await (mode === 'login' ? onLogin() : onSignUp());
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === 'login';

  return (
    <div className="mx-auto grid max-w-4xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm md:mt-8 md:grid-cols-2">
      <aside className="hidden flex-col justify-between bg-linear-to-br from-brand-600 to-brand-700 p-10 text-white md:flex">
        <div>
          <Logo className="h-11 w-11 bg-white/15" />
          <h2 className="mt-6 text-2xl leading-tight font-semibold">
            Diseña y simula líneas de manufactura y empaque
          </h2>
          <p className="mt-3 text-sm text-brand-100">
            Coloca robots, define escenarios y estima tiempos de ciclo y capacidad antes de
            invertir.
          </p>
        </div>
        <ul className="mt-10 space-y-3 text-sm text-brand-50">
          <li>• Proyectos privados que puedes compartir con tu equipo</li>
          <li>• Catálogo de robots con datos de fichas técnicas</li>
          <li>• Escenarios y simulación por eventos</li>
        </ul>
      </aside>

      <div className="p-8 sm:p-10">
        <div className="mb-6 flex items-center gap-3 md:hidden">
          <Logo />
          <span className="font-semibold">Simulador de líneas</span>
        </div>

        <div role="tablist" className="mb-6 grid grid-cols-2 rounded-xl bg-slate-100 p-1 text-sm">
          {(['login', 'signup'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => switchMode(m)}
              className={`rounded-lg py-2 font-medium transition ${
                mode === m
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {m === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}
            </button>
          ))}
        </div>

        <h1 className="text-xl font-semibold">
          {isLogin ? 'Bienvenido de nuevo' : 'Crea tu cuenta'}
        </h1>
        <p className="mt-1 mb-6 text-sm text-slate-500">
          {isLogin
            ? 'Entra con tu correo y contraseña.'
            : 'Solo necesitas un correo y una contraseña.'}
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Correo"
            type="email"
            required
            autoComplete="email"
            placeholder="tu@empresa.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <PasswordField
            label="Contraseña"
            required
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={isLogin ? undefined : `Mínimo ${MIN_PASSWORD_LENGTH} caracteres.`}
          />
          {!isLogin && (
            <PasswordField
              label="Confirmar contraseña"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
          {feedback && <Message kind={feedback.kind}>{feedback.text}</Message>}
          <button type="submit" disabled={busy} className="btn btn-primary w-full">
            {busy && <Spinner />}
            {isLogin ? (busy ? 'Entrando…' : 'Entrar') : busy ? 'Creando…' : 'Crear cuenta'}
          </button>
          {isLogin && (
            <button type="button" onClick={onForgot} className="btn btn-ghost w-full">
              ¿Olvidaste tu contraseña?
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
