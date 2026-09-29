# Simulador de líneas de producción con robots ABB

Aplicación web para diseñar y simular líneas de manufactura y empaque con robots industriales. Ver [PLAN.md](PLAN.md) para la arquitectura completa, el esquema de datos y las fases.

> **Aviso.** Los resultados del simulador son **estimaciones** basadas en fichas técnicas publicadas. No son réplicas de RobotStudio ni garantías de rendimiento.

## Estado

| Fase | Estado |
|---|---|
| 1. Base: monorepo, CI, Auth, esquema con RLS, despliegue | ✅ |
| 2. Ingesta de catálogo y pipeline CAD | pendiente |
| 3 a 10 | pendiente |

## Estructura

```
apps/web               React + Vite + Tailwind (login, proyectos, compartir)
apps/api               Fastify + TypeScript (auth Supabase, proyectos, salud)
services/sim-worker    Python, SimPy. Consume la cola de trabajos
services/cad-worker    Python. Conversión STEP → GLB → URDF (fase 2)
packages/domain        Esquemas y reglas compartidos por web y api
packages/db            Ejecutor de migraciones y tests de RLS
packages/jobqueue-py   Cliente Python de la cola de trabajos (tabla public.jobs)
supabase/migrations    SQL versionado (esquema, RLS, buckets, cola)
tools/check-no-cad     Chequeo que impide subir CAD de terceros
```

## Requisitos

- Node 22.18 o superior (ejecuta TypeScript directamente) y pnpm 10 (`corepack enable`)
- Python 3.11+ y [uv](https://docs.astral.sh/uv/)
- Docker (solo para el Postgres de tests y para construir imágenes)

## Desarrollo local

```bash
pnpm install              # instala dependencias y activa el hook pre-commit anti-CAD
uv sync --all-packages    # entorno Python de los workers
cp .env.example .env      # rellena las claves de tu proyecto Supabase
```

Aplicar migraciones a tu proyecto Supabase (también lo hace Railway en cada despliegue):

```bash
DATABASE_URL="<session pooler>" pnpm db:migrate
```

Arrancar servicios:

```bash
pnpm dev:api                                  # http://localhost:8080/health
pnpm dev:web                                  # http://localhost:5173
DATABASE_URL="<session pooler>" uv run sim-worker
DATABASE_URL="<session pooler>" uv run cad-worker
```

## Tests

Los tests de migraciones, RLS y cola usan un Postgres local con un stub mínimo de Supabase (`supabase/tests/supabase-stub.sql`), nunca tu proyecto real.

```bash
docker compose up -d db-test
pnpm lint && pnpm typecheck && pnpm test && pnpm build
uv run ruff check . && uv run mypy packages/jobqueue-py/src services/*/src && uv run pytest packages/jobqueue-py services
```

Qué cubren hoy:

- **RLS**: todas las tablas de `public` tienen RLS; `anon` no lee nada; el catálogo es solo lectura; los metadatos de CAD original no son visibles; propietario, editor, lector y extraño tienen exactamente los permisos esperados; las tablas internas no son accesibles; los buckets son privados y sin políticas.
- **API**: verificación de JWT (vencido, otro emisor, firma alterada, rol anónimo), validación de entrada, compartir proyectos, CORS y límite de peticiones.
- **Anti-CAD**: detección por extensión y por contenido (STEP, IGES, GLB, glTF, STL, Parasolid, también comprimidos).
- **Cola de trabajos**: reparto sin duplicados, reintentos con espera, estados `unsupported` y `needs_mapping`.

## Configurar Supabase (plan Free)

1. Crea el proyecto en [supabase.com](https://supabase.com).
2. **Authentication > Sign In / Providers**: desactiva *Allow new users to sign up*. El acceso es solo por invitación.
3. **Authentication > URL Configuration**: *Site URL* = URL pública del servicio web. En *Redirect URLs* añade `https://<web>/cuenta` y `http://localhost:5173/**`.
4. **Authentication > Users > Invite user** para cada miembro del equipo. Al abrir el enlace entran a *Mi cuenta* y definen su contraseña.
5. **Project Settings > API Keys**: copia la clave publicable y la secreta.
6. **Connect > Session pooler**: copia la cadena de conexión para `DATABASE_URL`. No uses el *Transaction pooler* (no admite LISTEN/NOTIFY).

Límites del plan Free a tener en cuenta: 50 MB por archivo, 1 GB de Storage, 500 MB de base de datos, y el proyecto **se pausa tras 7 días sin actividad** (se reactiva desde el panel).

## Desplegar en Railway

Cada servicio se despliega desde este repositorio con la integración de GitHub de Railway.

1. **New Project > Deploy from GitHub repo** y elige este repositorio. Crea 4 servicios desde el mismo repo: `web`, `api`, `sim-worker`, `cad-worker`.
2. En cada servicio, **Settings**:
   - *Root Directory*: vacío (la raíz del repo; los Dockerfiles la necesitan).
   - *Config-as-code / Railway config file*: `apps/web/railway.json`, `apps/api/railway.json`, `services/sim-worker/railway.json` o `services/cad-worker/railway.json`.
   - *Branch*: `main`, con **Wait for CI** activado para no desplegar si GitHub Actions falla.
3. **Variables** por servicio (ver `.env.example`):

   | Servicio | Variables |
   |---|---|
   | api | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `CORS_ORIGINS` (URL del web), opcional `SUPABASE_JWT_SECRET` |
   | web | `API_URL` (URL del api), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` |
   | sim-worker, cad-worker | `DATABASE_URL` |

4. **Networking > Generate Domain** en `web` y `api`. Después pon la URL del api en `API_URL` del web y la del web en `CORS_ORIGINS` del api.

El servicio `api` aplica las migraciones pendientes en su *pre-deploy* antes de arrancar. Si una migración falla, el despliegue se detiene y la versión anterior sigue activa.

Comprobación: `https://<api>/health` debe responder `"supabase":"ok"` y el web debe mostrar *Supabase conectado* en la cabecera.

## CAD de fabricantes: reglas y derechos

- **Ningún CAD, ficha PDF ni plano de fabricante se sube a este repositorio.** `.gitignore` los excluye y `tools/check-no-cad` falla en el pre-commit y en CI si detecta alguno, aunque tenga otra extensión.
- Los originales se guardan en el bucket privado `catalog-originals` de Supabase, sin acceso desde el navegador y sin endpoint de descarga.
- El navegador solo recibe versiones convertidas y simplificadas, mediante URLs firmadas de corta duración y solo con sesión iniciada.
- Cada archivo registra en la base de datos su fuente, fecha y términos de uso.
- **Los derechos de almacenamiento y uso de los CAD deben validarse con cada fabricante (ABB y demás) antes de cualquier uso comercial.**
- El desarrollo y los tests usan robots sintéticos generados por código, así que el repositorio funciona sin ningún CAD real.

## Decisiones técnicas de la fase 1

- **Sin paso de compilación en Node**: la API y los scripts se ejecutan como TypeScript directamente (Node 22.18+); `tsc` solo verifica tipos.
- **Cola de trabajos en Postgres** (`public.jobs`, `SKIP LOCKED`, `LISTEN/NOTIFY`) en lugar de Redis.
- **Tests de RLS con Vitest** contra Postgres local en vez de pgTAP, para no depender del CLI de Supabase en CI.
- **Configuración del web en tiempo de ejecución** (`/config.js`), así la misma imagen sirve en cualquier entorno.
