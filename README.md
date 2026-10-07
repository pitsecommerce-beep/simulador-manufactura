# Simulador de líneas de producción con robots ABB

Aplicación web para diseñar y simular líneas de manufactura y empaque con robots industriales. Ver [PLAN.md](PLAN.md) para la arquitectura completa, el esquema de datos y las fases.

> **Aviso.** Los resultados del simulador son **estimaciones** basadas en fichas técnicas publicadas. No son réplicas de RobotStudio ni garantías de rendimiento.

## Estado

| Fase | Estado |
|---|---|
| 1. Base: monorepo, CI, Auth, esquema con RLS, despliegue | ✅ |
| 2a. Catálogo con datos de ficha | ✅ |
| 2b. Pipeline CAD | pendiente |
| 3. Lienzo 3D con robots simplificados | ✅ |
| 4. Motor de línea: modelo de proceso, SimPy, indicadores, reproductor | ✅ |
| 9. Asistente de IA | en curso |
| 5 a 8 y 10 | pendiente |

## Estructura

```
apps/web               React + Vite + Tailwind (login, proyectos, catálogo, lienzo 3D con React Three Fiber)
apps/api               Fastify + TypeScript (auth Supabase, proyectos, salud)
services/sim-worker    Python, SimPy. Servicio HTTP interno del motor de línea (sin DATABASE_URL)
services/cad-worker    Python. Conversión STEP → GLB → URDF (fase 2)
packages/domain        Esquemas y reglas compartidos por web y api
packages/db            Generador del script SQL manual, ejecutor local y tests de RLS
packages/jobqueue-py   Cliente Python de la cola de trabajos (tabla public.jobs)
supabase/migrations    SQL versionado (esquema, RLS, buckets, cola)
supabase/manual        apply_all.sql generado para el SQL Editor de Supabase
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

Las migraciones se aplican a mano en el SQL Editor (ver [Migraciones manuales](#migraciones-manuales-sql-editor)). Como alternativa local opcional, con la cadena del *Session pooler*:

```bash
DATABASE_URL="<session pooler>" pnpm db:migrate
```

Ambos caminos registran lo aplicado en `app_migrations.applied` y son compatibles entre sí.

Arrancar servicios:

```bash
pnpm dev:api                                  # http://localhost:8080/health
pnpm dev:web                                  # http://localhost:5173
SIM_WORKER_TOKEN=dev-token-de-32-caracteres-minimo SUPABASE_URL=... SUPABASE_SECRET_KEY=... uv run sim-worker
DATABASE_URL="<session pooler>" uv run cad-worker   # solo fase 2b
```

Para que el api local use el motor: `SIM_WORKER_URL=http://localhost:8080` y el mismo `SIM_WORKER_TOKEN` en `.env`. Sin `SIM_WORKER_URL`, el botón Simular responde que el motor no está configurado.

```bash
```

## Tests

Los tests de migraciones, RLS y cola usan un Postgres local con un stub mínimo de Supabase (`supabase/tests/supabase-stub.sql`), nunca tu proyecto real.

```bash
docker compose up -d db-test
pnpm lint && pnpm typecheck && pnpm test && pnpm build
uv run ruff check . && uv run mypy packages/jobqueue-py/src services/*/src && uv run pytest packages/jobqueue-py services
```

Qué cubren hoy:

- **Motor de línea (Python)**: casos analíticos (M/M/1 contra ρ, L y W teóricos; línea en serie con tiempos fijos; bloqueo sin buffer; disponibilidad con fallas = MTBF/(MTBF+MTTR); scrap y OEE; ensamblaje por BOM; reparto por fracciones; cambio de pallet), reproducibilidad con semilla, takt solo con demanda, registro de eventos, servicio HTTP con token y escritura en Supabase.
- **Corridas (api)**: permisos, límites de réplicas y horizonte, modelo inválido, motor caído (502), corridas huérfanas y registro de eventos comprimido.
- **Modelo de proceso**: rutas sin salida, nodos inalcanzables, ciclos, buffers sin capacidad, repartos que no suman 1, BOM no cubierta, roles incompatibles, origen de cada tiempo (ficha, usuario o asistente), carga con gripper y zonas de seguridad.
- **Lienzo 3D**: robots paramétricos desde la ficha (alcance y rangos de eje), límites de ejes, alcance (esfera, delta y SCARA), carga nominal, colisiones AABB con giro, escena validada con Zod, guardado con control de versión (409) y RLS de `layouts`.
- **Catálogo**: el seed es idempotente, deja en null lo no publicado, guarda la fuente de cada dato y refleja los JSON; la API exige sesión y filtra; RLS impide escribir el catálogo.
- **Migraciones**: el ejecutor y el script manual `apply_all.sql` registran todas las migraciones, son idempotentes y compatibles entre sí; `apply_all.sql` está al día.
- **RLS**: todas las tablas de `public` tienen RLS; `anon` no lee nada; el catálogo es solo lectura; los metadatos de CAD original no son visibles; propietario, editor, lector y extraño tienen exactamente los permisos esperados; las tablas internas no son accesibles; los buckets son privados y sin políticas.
- **API**: verificación de JWT (vencido, otro emisor, firma alterada, rol anónimo), validación de entrada, compartir proyectos, CORS y límite de peticiones.
- **Anti-CAD**: detección por extensión y por contenido (STEP, IGES, GLB, glTF, STL, Parasolid, también comprimidos).
- **Cola de trabajos** (cad-worker): reparto sin duplicados, reintentos con espera, estados `unsupported` y `needs_mapping`.

## Migraciones manuales (SQL Editor)

El esquema vive en `supabase/migrations/*.sql`. El api no aplica migraciones al desplegar; se aplican a mano:

1. Genera el script con todas las migraciones:

   ```bash
   pnpm db:sql      # escribe supabase/manual/apply_all.sql
   ```

2. Abre `supabase/manual/apply_all.sql`, copia el archivo **completo** y pégalo en **Supabase > SQL Editor > New query > Run**. Solo aplica las migraciones que falten (puedes correrlo varias veces) y al final muestra la lista de migraciones aplicadas.
3. Aplícalo **antes** de desplegar el código que necesita esas tablas o columnas.
4. **No edites una migración ya aplicada.** Crea una nueva (`AAAAMMDDhhmmss_nombre.sql`). Si el script detecta que una migración aplicada cambió, se detiene con un error.

`apply_all.sql` es generado y se versiona. Un test falla si no está al día; también puedes comprobarlo con `pnpm --filter @sim/db sql --check`.

## Catálogo de robots (seed manual)

Los datos de ficha viven en `catalog/` y `catalog_components/` (solo `manifest.json`, `specs.json`, `source.json` y `standards/presets.json`; PDFs, CAD, zips y planos siguen prohibidos por `.gitignore` y `check-no-cad`).

1. Si cambias algún JSON, regenera el seed:

   ```bash
   pnpm catalog:sql   # escribe supabase/manual/seed_catalog.sql
   ```

2. Aplica antes las migraciones pendientes (`apply_all.sql`, sección anterior).
3. Pega `supabase/manual/seed_catalog.sql` completo en **SQL Editor > Run**. Es idempotente y deja el catálogo igual a los JSON: lo que no está publicado queda `NULL`. Al final muestra el conteo de robots, variantes, documentos y componentes.

Un test falla si `seed_catalog.sql` no está al día (`pnpm --filter @sim/db catalog:sql --check`).

## Configurar Supabase (plan Free)

1. Crea el proyecto en [supabase.com](https://supabase.com).
2. **Authentication > Sign In / Providers**: deja activos *Allow new users to sign up* y el proveedor *Email*. Con *Confirm email* activado, el usuario confirma su correo antes de entrar. Si prefieres acceso solo por invitación, desactiva el registro y usa *Users > Invite user*.
3. **Authentication > URL Configuration**: *Site URL* = URL pública del servicio web. En *Redirect URLs* añade `https://<web>/**` y `http://localhost:5173/**` (confirmación de registro y recuperación de contraseña).
4. Los usuarios se registran desde la web con correo y contraseña. Opcional: **Authentication > Users > Invite user**; al abrir el enlace entran a *Mi cuenta* y definen su contraseña.
5. **Project Settings > API Keys**: copia la clave publicable y la secreta.
6. **SQL Editor**: aplica `supabase/manual/apply_all.sql` (ver la sección anterior).
7. **Connect > Session pooler**: copia la cadena de conexión para `DATABASE_URL` de los workers. No uses el *Transaction pooler* (no admite LISTEN/NOTIFY).

Límites del plan Free a tener en cuenta: 50 MB por archivo, 1 GB de Storage, 500 MB de base de datos, y el proyecto **se pausa tras 7 días sin actividad** (se reactiva desde el panel).

## Desplegar en Railway

Cada servicio se despliega desde este repositorio con la integración de GitHub de Railway.

1. **New Project > Deploy from GitHub repo** y elige este repositorio. Crea 4 servicios desde el mismo repo: `web`, `api`, `sim-worker`, `cad-worker`.
2. En cada servicio, **Settings**:
   - *Root Directory*: vacío (la raíz del repo; los Dockerfiles la necesitan).
   - *Config-as-code > Railway Config File*: ruta **absoluta** desde la raíz del repo, según el servicio:

     | Servicio | Railway Config File |
     |---|---|
     | web | `/apps/web/railway.json` |
     | api | `/apps/api/railway.json` |
     | sim-worker | `/services/sim-worker/railway.json` |
     | cad-worker | `/services/cad-worker/railway.json` |

     Sin esta ruta, Railway ignora el Dockerfile y usa su detector automático (Railpack), que falla con *No start command detected*.
   - *Branch*: `main`, con **Wait for CI** activado para no desplegar si GitHub Actions falla.
3. **Variables** por servicio (ver `.env.example`):

   | Servicio | Variables |
   |---|---|
   | api | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `CORS_ORIGINS` (URL del web), `SIM_WORKER_URL`, `SIM_WORKER_TOKEN`, opcionales `SUPABASE_JWT_SECRET`, `SIM_MAX_REPLICATIONS`, `SIM_MAX_HORIZON_H`, `SIM_RUN_TIMEOUT_S` |
   | web | `API_URL` (URL del api), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` |
   | sim-worker | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SIM_WORKER_TOKEN`, `PORT=8080`, opcionales `SIM_MAX_REPLICATIONS`, `SIM_MAX_CONCURRENT_RUNS` (ver sección siguiente) |
   | cad-worker | `DATABASE_URL` (solo cuando llegue la fase 2b; mientras tanto puedes dejarlo sin desplegar) |

4. **Networking > Generate Domain** en `web` y `api`. Después pon la URL del api en `API_URL` del web y la del web en `CORS_ORIGINS` del api.

### Motor de línea (sim-worker)

El sim-worker es un servicio HTTP **interno**: solo lo llama el api por la red privada de Railway. No necesita `DATABASE_URL`: guarda resultados en Supabase por HTTPS con la clave secreta.

1. En el servicio `sim-worker` (o crea uno nuevo desde este repo): *Root Directory* vacío y *Railway Config File* `/services/sim-worker/railway.json`.
2. **No** generes dominio público. En *Settings > Networking* verifica que tenga *Private Networking*; su nombre interno será `sim-worker.railway.internal` (si el servicio tiene otro nombre, ajústalo en `SIM_WORKER_URL`).
3. Genera un token compartido, por ejemplo con `openssl rand -hex 32`.
4. Variables del **sim-worker**:

   | Variable | Valor |
   |---|---|
   | `SUPABASE_URL` | la misma del api |
   | `SUPABASE_SECRET_KEY` | la misma del api |
   | `SIM_WORKER_TOKEN` | el token del paso 3 |
   | `PORT` | `8080` |
   | `SIM_MAX_REPLICATIONS` | `50` (opcional) |
   | `SIM_MAX_CONCURRENT_RUNS` | `1` (opcional; corridas simultáneas, cada una usa un núcleo) |

5. Variables del **api**:

   | Variable | Valor |
   |---|---|
   | `SIM_WORKER_URL` | `http://sim-worker.railway.internal:8080` |
   | `SIM_WORKER_TOKEN` | el mismo token |
   | `SIM_MAX_REPLICATIONS` | `50` (opcional, igual o menor que en el worker) |
   | `SIM_MAX_HORIZON_H` | `720` (opcional) |
   | `SIM_RUN_TIMEOUT_S` | `1800` (opcional; tras ese tiempo una corrida sin terminar se marca como fallida) |

6. Si el sim-worker tenía `DATABASE_URL` o `POLL_SECONDS` de la fase 1, puedes borrarlas: ya no se usan.
7. Comprobación: en *Deployments* del sim-worker el healthcheck `/health` debe pasar. En la web, en un proyecto con flujo válido y layout guardado, pulsa **Simular**: la corrida pasa de *En cola* a *Simulando* y a *Terminada*.

Si el log de build dice `using build driver railpack` en vez de construir el Dockerfile, el servicio no está leyendo su configuración:

- Borra cualquier *Custom Build Command* y *Custom Start Command* del servicio (Railway los crea solo si importa el monorepo automáticamente).
- Revisa la ruta del punto 2.
- Como respaldo, añade la variable `RAILWAY_DOCKERFILE_PATH` con la ruta del Dockerfile (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `services/sim-worker/Dockerfile` o `services/cad-worker/Dockerfile`). Esa variable obliga a Railway a usar el Dockerfile.
- Solo hacen falta 4 servicios. Si Railway creó otros (por ejemplo `@sim/db`, `@sim/domain` o `check-no-cad`), elimínalos.

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
- **Cola de trabajos en Postgres** (`public.jobs`, `SKIP LOCKED`, `LISTEN/NOTIFY`) para el cad-worker. El motor de línea no la usa: es un servicio HTTP interno porque el api no tiene `DATABASE_URL` (PLAN.md, sección 22).
- **Tests de RLS con Vitest** contra Postgres local en vez de pgTAP, para no depender del CLI de Supabase en CI.
- **Configuración del web en tiempo de ejecución** (`/config.js`), así la misma imagen sirve en cualquier entorno.
