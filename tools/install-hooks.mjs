// Activa los hooks de git versionados en .githooks (se ejecuta en `pnpm install`).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (process.env.CI || !existsSync('.git')) process.exit(0);
try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
} catch {
  // Sin git disponible: no es un error para instalar dependencias.
}
