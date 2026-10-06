export const MIN_PASSWORD_LENGTH = 10;

/** Devuelve el problema de la contraseña o null si es válida. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password !== confirm) return 'Las contraseñas no coinciden.';
  return null;
}
