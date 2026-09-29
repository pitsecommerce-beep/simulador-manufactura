# PLAN.md · Simulador de líneas de producción con robots ABB

Estado: **borrador pendiente de aprobación**. No se escribirá código hasta que se confirme este plan.

---

## 1. Resumen

Aplicación web donde un usuario describe una línea de manufactura o empaque, un asistente de IA propone robots y componentes del catálogo, el usuario ajusta el layout en un lienzo 3D y el sistema simula la línea (eventos discretos + Monte Carlo), mostrando indicadores, código de control en ejecución, sensores y visión simulados.

Etapa 1: solo simulación. Etapa 2 (futura): ejecutar la misma lógica contra hardware físico. En esta etapa se deja listo el protocolo, la capa de seguridad y una demo con Web Serial.

---

## 2. Decisión de API: Node/TypeScript (Fastify)

Se elige **Fastify + TypeScript**. Motivos:

1. **Un solo dominio compartido con el frontend.** Las validaciones de alcance, carga útil, AABB, patrones de paletizado y perfiles trapezoidales deben ejecutarse en el lienzo (advertencias en vivo al arrastrar) y en la API (tool calling del asistente, validación al guardar). Con TS se escriben una vez en `packages/domain` y las usan `web` y `api`. Con FastAPI habría que duplicarlas en dos lenguajes y mantenerlas sincronizadas.
2. **Esquemas únicos.** Zod define layouts, specs y el log de eventos; de ahí se genera JSON Schema, que a su vez genera modelos Pydantic para los workers Python. Una fuente de verdad, tres consumidores.
3. **SDKs de IA maduros** en TS para Anthropic y OpenAI, con tool calling y streaming.
4. **Lo pesado ya está en Python** (SimPy, CadQuery/OCP), aislado en workers. La API solo orquesta, valida y firma URLs; no necesita el ecosistema científico.

Costo aceptado: dos lenguajes en el monorepo. Se mitiga con esquemas generados y tests de contrato.

---

## 3. Arquitectura

```
                 ┌──────────────────────────── Railway ────────────────────────────┐
 Navegador       │                                                                 │
 (React/R3F) ───►│  web (Vite estático) ──► api (Fastify) ──► Supabase Postgres    │
     │           │                             │   ▲            (tabla jobs)        │
     │           │                             │   │                 ▲   ▲          │
     │           │                             ▼   │                 │   │          │
     │           │                       Anthropic / OpenAI     sim-worker cad-worker│
     │           │                                               (SimPy)  (CadQuery) │
     │           └─────────────────────────────────────────────────────────────────┘
     │                                          │
     └── URLs firmadas (TTL corto) ─────► Supabase Storage (bucket derived)
```

### Servicios (Railway)

| Servicio | Tecnología | Responsabilidad |
|---|---|---|
| `web` | React, TS, Vite, R3F, urdf-loader, Tailwind, Zustand | UI, lienzo 3D, reproductor del log de eventos, panel de código, chat |
| `api` | Fastify, TS, Zod, supabase-js | Auth (verifica JWT de Supabase), CRUD, validación, firma de URLs, orquestación de IA, encolado de trabajos, límites de uso |
| `sim-worker` | Python 3.12, SimPy, NumPy, Pydantic | Consume trabajos `simulate`, corre réplicas Monte Carlo, escribe log de eventos y métricas |
| `cad-worker` | Python 3.12, CadQuery/OCP, trimesh, Docker | Consume trabajos `convert_cad`: STEP → GLB por eslabón → URDF |

### Cola de trabajos

Tabla `jobs` en Postgres con `SELECT ... FOR UPDATE SKIP LOCKED`, reintentos y `LISTEN/NOTIFY`. Evita añadir Redis. Tipos: `convert_cad`, `simulate`, `render_thumbnail`, `train_policy` (este último se acepta y se marca como `unsupported` en etapa 1; queda la interfaz lista para un worker con GPU externo).

### Flujo de simulación

1. El usuario guarda layout + escenario. La API valida y encola `simulate` con N réplicas y semillas.
2. `sim-worker` ejecuta SimPy sin gráficos. Produce:
   - `events.jsonl` (una réplica representativa) en Storage: `{t, entity_id, type, payload}`.
   - Métricas por réplica y agregadas (min, p5, media, p95, max) en `simulation_metrics`.
3. El lienzo 3D descarga el log con URL firmada y lo reproduce con un reloj controlable (pausa, velocidad x1..x1000, salto a t).
4. El panel de código resalta la instrucción activa según los eventos `code.line` del log.

### Sincronía reloj / 3D

El motor es de eventos discretos; el 3D interpola entre eventos (ej. `robot.move_start` con perfil trapezoidal conocido → pose en cualquier t). El navegador no simula, solo reproduce.

---

## 4. Estructura del monorepo

```
/
├─ apps/
│  ├─ web/                  React + R3F
│  └─ api/                  Fastify
├─ services/
│  ├─ sim-worker/           Python, SimPy
│  └─ cad-worker/           Python, CadQuery, Dockerfile
├─ packages/
│  ├─ domain/               TS: esquemas Zod, validaciones, paletizado, cinemática, perfiles
│  ├─ protocol/             JSON Schema: log de eventos, órdenes por articulación (etapa 2)
│  └─ synthetic/            Generadores de robots/componentes sintéticos (TS + Python)
├─ tools/
│  ├─ ingest/               Script de ingesta del catálogo (TS)
│  └─ check-no-cad/         Chequeo anti-CAD (CI + pre-commit)
├─ supabase/
│  ├─ migrations/           SQL versionado
│  ├─ seed.sql              Datos sintéticos
│  └─ tests/                Tests RLS (pgTAP)
├─ catalog/                 IGNORADO por git (solo README.md y ejemplo sintético)
├─ catalog_components/      IGNORADO por git (idem)
├─ .github/workflows/
├─ .env.example
├─ PLAN.md
└─ README.md
```

Herramientas: pnpm workspaces + Turborepo (TS), uv (Python), Ruff + mypy, ESLint + Prettier, Vitest, Pytest, Playwright (e2e mínimos), pgTAP.

---

## 5. Esquema de datos (Supabase Postgres)

Convenciones: `id uuid pk`, `created_at`, `updated_at`. Todos los datos de ficha técnica son **nullable**; `null` significa "no publicado", nunca 0 ni estimado. Cada dato de ficha lleva procedencia.

### 5.1 Catálogo (lectura para autenticados, escritura solo `service_role`)

- **robots**: `id`, `slug`, `manufacturer`, `model`, `family`, `is_synthetic bool`, `status`.
- **robot_variants**: `robot_id`, `variant_code`, `reach_mm`, `payload_kg` (variantes tipo IRB 6700-200/2.60).
- **robot_specs**: `variant_id`, `axes_count`, `reach_mm`, `payload_kg`, `weight_kg`, `repeatability_mm`, `mounting_allowed text[]`, `ip_rating`, `controller`, `axis_limits jsonb` (por eje: `min_deg`, `max_deg`, `max_speed_dps`), `published_cycle_times jsonb` (valor + condición de medición, ej. ciclo 25/305/25 mm con 1 kg), `provenance jsonb` (por campo: `source_file`, `page`, `retrieved_at`).
- **robot_assets**: `variant_id`, `kind` (`original_cad`, `derived_glb`, `urdf`, `datasheet`, `drawing`, `thumbnail`), `bucket`, `path`, `sha256`, `bytes`, `source_url`, `license_terms`, `terms_url`, `retrieved_at`, `usage_restrictions`, `link_name` (para GLB por eslabón).
- **components** / **component_specs** / **component_assets**: misma idea. `category` (sensor, cámara, gripper, banda, valla, cortina de luz...). `component_specs.specs jsonb` validado por categoría (rango de detección, FOV, resolución, etc.) + `provenance`.
- **object_types**: tipos paramétricos generados por código (`pallet`, `box`, `table`, `conveyor`, `gripper_suction`, `fence`, `light_curtain`, `safety_zone`, `part`, `feeder`, `person`, ...) con `param_schema jsonb` y `presets jsonb`.

### 5.2 Datos de usuario (RLS por propietario)

- **projects**: `owner_id → auth.users`, `name`, `description`.
- **layouts**: `project_id`, `version`, `scene jsonb` (validado con Zod), `is_current`.
- **object_instances**: `layout_id`, `object_type_id` | `robot_variant_id` | `component_id`, `params jsonb`, `transform jsonb`, `color`, `links jsonb` (conexiones lógicas: valla→robot, sensor→estación).
- **scenarios**: `project_id`, `layout_id`, `config jsonb` (turnos, mezcla de productos, BOM, fallas MTBF/MTTR, duración, réplicas, semillas, modo `realtime|accelerated`).
- **simulation_runs**: `scenario_id`, `status`, `replications`, `seed`, `engine_version`, `events_path`, `started_at`, `finished_at`, `error`.
- **simulation_metrics**: `run_id`, `replication` (null = agregado), `metric`, `scope` (línea/estación), `value`, `min`, `mean`, `max`, `p5`, `p95`, `unit`, `is_estimate bool`.
- **generated_code**: `project_id`, `target` (`rapid`, `python`, `arduino`), `entity_id`, `source text`, `source_map jsonb` (línea ↔ evento), `generator` (`template`|`ai`), `ai_conversation_id`.
- **ai_conversations**: `project_id`, `owner_id`, `provider`, `model`, `messages jsonb`, `tool_calls jsonb`, `tokens_in`, `tokens_out`.

### 5.3 Tablas adicionales (propuestas)

- **jobs**: cola descrita en la sección 3.
- **ai_usage**: contador diario por usuario para límites (tokens y solicitudes).
- **asset_access_log**: registro de cada URL firmada emitida (usuario, asset, ttl).

### 5.4 RLS

- RLS activada en **todas** las tablas; una migración de prueba falla si alguna tabla de `public` no la tiene.
- Catálogo: `select` para `authenticated`; sin `insert/update/delete` para clientes.
- `robot_assets` / `component_assets`: el cliente **no** puede leer filas `kind = 'original_cad'` (política con filtro). Las rutas de Storage nunca se exponen directamente; la API firma.
- Datos de usuario: `owner_id = auth.uid()` (directo o vía `projects`).
- `jobs`, `ai_usage`, `asset_access_log`: sin acceso de cliente; solo `service_role`.

### 5.5 Storage

| Bucket | Público | Acceso cliente | Contenido |
|---|---|---|---|
| `catalog-originals` | no | **ninguno** (sin políticas) | STEP, datasheets PDF, planos |
| `catalog-derived` | no | solo vía URL firmada emitida por la API (TTL 5 min) | GLB simplificado, URDF, miniaturas |
| `sim-artifacts` | no | URL firmada, solo propietario | `events.jsonl`, reportes |

No existe endpoint de descarga de originales. Un test recorre las rutas registradas en Fastify y falla si alguna referencia `catalog-originals`.

---

## 6. Protección de CAD de terceros

- `.gitignore`: `*.step *.stp *.iges *.igs *.sldprt *.sldasm *.x_t *.x_b *.sat *.3dxml *.catpart *.jt *.prt *.stl *.obj *.fbx *.glb *.gltf`, más `catalog/**` y `catalog_components/**` (salvo `README.md` y `examples/`).
- `tools/check-no-cad`: busca por extensión **y por firma de contenido** (cabecera `ISO-10303-21`, magic `glTF`, etc.) en archivos versionados. Corre en pre-commit (husky/lefthook) y como primer job de CI. Excepción explícita: GLB sintéticos de test generados en tiempo de ejecución (no se versionan).
- Los datos de términos de uso se guardan por archivo en `*_assets`.
- README con aviso de que los derechos de almacenamiento y uso deben validarse con cada fabricante antes de uso comercial.

---

## 7. Ingesta del catálogo

`pnpm ingest --catalog ./catalog --components ./catalog_components [--dry-run]`

1. Lee `manifest.json`, valida cada `specs.json` y `source.json` con Zod (campos faltantes → `null`, nunca inventados; campos desconocidos → advertencia).
2. Calcula SHA-256 de cada archivo. Si el hash ya existe en `*_assets`, no resube (idempotente). Si cambió, versiona.
3. Sube originales a `catalog-originals`, upsert en tablas por `slug`.
4. Registra `license_terms`, `source_url`, `retrieved_at` por archivo desde `source.json`. Sin `source.json` → el archivo se rechaza.
5. Encola `convert_cad` para CAD nuevos o modificados.
6. Carga `standards/presets.json` en `object_types.presets`.
7. Imprime un reporte: creados, sin cambios, rechazados, datos nulos por robot.

---

## 8. Pipeline de CAD (cad-worker)

1. Descarga STEP del bucket privado.
2. Lee el ensamblaje con OCP/CadQuery. **Separación por eslabones**: los STEP de fabricante no siempre traen eslabones separados. Estrategia en orden: (a) un archivo STEP por eslabón si el fabricante lo publica así; (b) sólidos nombrados en el ensamblaje; (c) archivo `cad/links.json` escrito a mano que mapea sólidos → `base, link1..link6` y ejes de articulación. Si nada aplica, el trabajo termina en `needs_mapping` y la UI lo indica.
3. Teselado con tolerancia configurable, decimación (trimesh / meshoptimizer) hasta un presupuesto de triángulos por eslabón, compresión Draco/meshopt.
4. Genera URDF con límites de `robot_specs.axis_limits`. Si un límite es `null`, la articulación queda marcada como "sin límite publicado" y el IK la trata como no validable (advertencia en UI), no se inventa un valor.
5. Genera miniatura (render offscreen con pyrender/trimesh) para el asistente.
6. Sube a `catalog-derived` y registra en `robot_assets`.

Robots sintéticos: `packages/synthetic` genera robots de 6 ejes con geometría primitiva (cilindros y cajas), URDF y specs completos marcados `is_synthetic = true`. Todo el repo y la CI funcionan solo con ellos.

---

## 9. Dominio compartido (`packages/domain`)

- **Alcance**: distancia de la base al punto objetivo contra `reach_mm` de la variante + comprobación por IK numérico con límites de eje.
- **Carga útil**: masa de pieza + gripper contra `payload_kg`. Sin curva de carga publicada, solo se valida el valor nominal y se muestra ese matiz.
- **Colisiones**: AABB entre instancias y contra zonas de seguridad. Sin física.
- **Paletizado**: patrones columna, entrelazado y pinwheel; cajas por capa, capas por altura máxima, límite por peso; tiempo de llenado = cajas × tiempo de ciclo estimado del robot.
- **Perfil trapezoidal** por eje: `v_max` de la ficha; aceleración configurable por escenario con valor por defecto documentado como supuesto. El tiempo del movimiento lo marca el eje más lento. Todo resultado lleva `is_estimate = true`.
- **Calibración**: si hay `published_cycle_times`, se ajusta la aceleración supuesta para reproducir el ciclo publicado bajo su condición de medición y se muestra el error residual.
- **IK en navegador**: solver numérico (Damped Least Squares) sobre la cadena URDF, respetando límites.

---

## 10. Motor de simulación (sim-worker)

- Entidades: estación, buffer, robot, banda, persona, sensor, alimentador, salida, pieza (con atributos y BOM).
- Procesos: rutas de producto, ensamblaje por BOM, fallas (MTBF/MTTR con distribuciones), paros planificados, turnos, descansos, scrap y retrabajo.
- Personas: tiempos de tarea con distribución, velocidad de desplazamiento, tasa de error; al entrar en zona de seguridad el robot reduce velocidad o se detiene según configuración.
- Sensores: eventos lógicos (proximidad, presión, fin de carrera, cámara con detección simulada: verdad de terreno + ruido + probabilidad de falso negativo según parámetros).
- Monte Carlo: N réplicas con semillas reproducibles, en paralelo con `multiprocessing`, límite de N y de duración por plan.
- Indicadores: producción/h, tiempo de ciclo, takt, utilización por estación, cuello de botella (estación con mayor utilización y bloqueo aguas arriba), WIP, OEE (disponibilidad × rendimiento × calidad), scrap, ensamblado/empacado. Siempre con min, media, max y p5/p95.
- Modos: `accelerated` (lo más rápido posible) y `realtime` (reloj de pared, `simpy.rt.RealtimeEnvironment`) pensado para etapa 2.

---

## 11. Código y lógica visibles

- Generación por plantillas deterministas: RAPID para robots (MoveJ/MoveL, WaitDI, SetDO, rutinas de paletizado), Python/Arduino para sensores y lógica auxiliar.
- `source_map`: cada instrucción se asocia a un evento del motor; el reproductor resalta la línea activa y muestra señales de E/S en una tabla sincronizada.
- La IA puede proponer cambios al código, pero el motor solo ejecuta el modelo lógico interno. Aviso visible: el RAPID generado es ilustrativo y no ha sido validado en un controlador real.

---

## 12. Asistente de IA

- Capa `LLMProvider` con implementaciones `anthropic` y `openai`. Variables: `AI_PROVIDER`, `AI_MODEL`, `AI_MAX_TOKENS`, `AI_TIMEOUT_MS`. Ningún nombre de modelo en el código.
- Herramientas (tool calling), todas validadas con Zod en la API:
  `search_catalog`, `get_robot_specs`, `get_component_specs`, `validate_reach`, `validate_payload`, `compute_palletizing`, `create_layout`, `update_layout`, `generate_code`, `run_simulation`.
- Reglas del sistema: solo afirmar datos devueltos por herramientas; si un dato es `null`, decir que no está publicado. Post-validación: las cifras de la respuesta se contrastan con los resultados de herramientas del turno y se marca en la UI cualquier cifra no respaldada.
- Miniaturas: la respuesta incluye IDs de assets; la UI pide URLs firmadas.
- Límites: por usuario/día (solicitudes y tokens) en `ai_usage`, rate limit por IP en Fastify, manejo de errores y reintentos con backoff, conversaciones guardadas.

---

## 13. Preparación para etapa 2

- **Protocolo** (`packages/protocol`): JSON por línea.
  `{"v":1,"seq":12,"cmd":"joint","joints":[{"i":1,"deg":35.0,"dps":40.0}],"state":"run"}` y respuestas `{"seq":12,"ack":true,"pos":[...],"fault":null}`. Estados `idle|run|hold|estop`.
- **Capa de seguridad**: rechaza o recorta órdenes fuera de límites de eje, velocidad y zona de trabajo; emite aviso y pasa a `hold`. Se prueba de forma aislada.
- **Destino intercambiable**: interfaz `JointTarget` con `VirtualRobotTarget` (lienzo 3D) y `SerialTarget` (Web Serial). La lógica no cambia, solo el destino.
- **Demo Web Serial**: sketch Arduino de ejemplo que lee potenciómetros y envía órdenes; el robot virtual las ejecuta a través de la capa de seguridad. Solo Chrome/Edge.
- **RL**: tabla `jobs` acepta `train_policy` y documenta el contrato de entrada/salida; ejecución fuera de Railway.

---

## 14. Fases y criterios de aceptación

| # | Fase | Entregable verificable |
|---|---|---|
| 1 | Base | Monorepo, CI verde (lint, tests, build, anti-CAD), migraciones con RLS y tests pgTAP, login con Supabase, "hello world" desplegado en Railway leyendo de Supabase |
| 2 | Ingesta y CAD | Ingesta idempotente con robots sintéticos, worker STEP→GLB→URDF probado con STEP sintético generado por CadQuery, URLs firmadas, test de no-descarga |
| 3 | Lienzo 3D | Colocar robots/objetos/personas/sensores, IK con límites, colores, guardar/cargar layouts, advertencias AABB/alcance/carga |
| 4 | Motor de línea | SimPy con estaciones, buffers, BOM, fallas, Monte Carlo, dashboard con rangos, reproductor de eventos |
| 5 | Robots por ficha | Perfil trapezoidal, calibración con ciclos publicados, etiqueta ESTIMACIÓN en toda la UI |
| 6 | Personas | Agentes con turnos, descansos, errores, zonas de seguridad que afectan al robot |
| 7 | Sensores y visión | Sensores lógicos, cámara virtual con render y detección simulada |
| 8 | Código visible | RAPID/Python/Arduino generados, línea activa y E/S sincronizadas |
| 9 | Asistente IA | Chat con tools, miniaturas, validaciones, iteración, límites de uso |
| 10 | Etapa 2 prep | Protocolo, capa de seguridad, demo Web Serial, modos realtime/acelerado, documento de diseño |

Al cerrar cada fase: resumen de qué funciona, qué falta y decisiones pendientes.

Tests obligatorios desde la fase en que aplica: alcance y carga (`domain`), paletizado (`domain`), indicadores (`sim-worker`, con casos analíticos tipo M/M/1 y línea en serie determinista), RLS (pgTAP), protección de descargas (API).

---

## 15. CI/CD

- `ci.yml` en cada PR: `check-no-cad` → lint (ESLint, Ruff) → typecheck (tsc, mypy) → tests (Vitest, Pytest, pgTAP con Supabase CLI local) → build (web, api, imágenes Docker de workers).
- `deploy.yml` en `main`: despliegue a Railway por servicio con `RAILWAY_TOKEN` (secret de GitHub), luego `supabase db push` con `SUPABASE_ACCESS_TOKEN`.
- Alternativa más simple: usar la integración nativa de Railway con GitHub (despliegue al hacer push) y dejar en Actions solo las migraciones. A decidir.

---

## 16. Riesgos y limitaciones conocidas

| Riesgo | Impacto | Mitigación / alternativa |
|---|---|---|
| **Railway sin GPU** | No hay entrenamiento RL | Solo interfaz y cola; entrenar en un proveedor con GPU (Modal, RunPod, local) |
| **Límite de tamaño en Supabase Storage** (plan Free: 50 MB por archivo; Pro: configurable, mayor) | STEP de robots grandes pueden superar 50 MB | Plan Pro, o comprimir antes de subir (gzip del STEP), o almacén alternativo (S3/R2 privado) para originales |
| **Conversión CAD lenta y con mucha memoria** | Un STEP complejo puede tardar minutos y usar varios GB de RAM | Trabajo asíncrono, tolerancia de teselado ajustable, límites de RAM en el servicio, reintentos; opción de convertir localmente con el mismo contenedor y subir solo derivados |
| **Imagen Docker de CadQuery/OCP pesada** (~1-2 GB) | Builds lentos en Railway | Imagen base propia cacheada en GHCR |
| **Timeouts HTTP de Railway** | Peticiones largas cortadas | Todo lo largo es trabajo en cola; el cliente consulta estado o usa Supabase Realtime |
| **Separación de eslabones en STEP** | Puede requerir mapeo manual | `links.json` por robot; estado `needs_mapping` visible |
| **Fichas sin aceleraciones ni trayectorias** | Tiempos de ciclo inexactos | Todo marcado como estimación; calibración con ciclos publicados; aviso: no es RobotStudio |
| **Derechos sobre CAD de fabricantes** | Uso comercial no autorizado | Bucket privado, sin descarga, términos por archivo, aviso en README |
| **Alucinaciones del asistente** | Datos falsos sobre robots | Solo datos vía tools, post-validación de cifras, `null` = no publicado |
| **Costos de IA** | Gasto descontrolado | Límites por usuario, tope global configurable |
| **Web Serial solo en Chromium** | Demo no funciona en Firefox/Safari | Documentado; detección de soporte en UI |
| **Rendimiento 3D** con muchos objetos | FPS bajos | Instancing, LOD, presupuesto de triángulos en conversión |
| **Réplicas Monte Carlo en CPU compartida** | Tiempos largos | Límite de réplicas por plan, paralelismo por proceso, escalar el worker horizontalmente |

---

## 17. Variables de entorno (resumen, detalle en `.env.example`)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (solo api y workers), `SUPABASE_JWT_SECRET`, `DATABASE_URL` (conexión directa para la cola), `AI_PROVIDER`, `AI_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_DAILY_TOKEN_LIMIT`, `AI_DAILY_REQUEST_LIMIT`, `SIGNED_URL_TTL_SECONDS`, `SIM_MAX_REPLICATIONS`, `CAD_TESSELLATION_TOLERANCE`, `CAD_MAX_TRIANGLES_PER_LINK`, `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

---

## 18. Decisiones que necesito de ti

1. **API en Fastify/TS** (sección 2): ¿de acuerdo?
2. **Plan de Supabase**: ¿Free o Pro? Afecta al tamaño máximo de archivos CAD.
3. **Despliegue**: ¿GitHub Actions con `RAILWAY_TOKEN` o integración nativa de Railway con GitHub?
4. **Proyectos de Supabase y Railway**: ¿ya existen? Necesitaré que configures los secretos en GitHub y Railway (yo no los veré ni los guardaré en el repo).
5. **Robots reales iniciales**: ¿qué modelos ABB tendrás disponibles primero (ej. IRB 1200, IRB 460, IRB 6700)? Mientras tanto uso sintéticos.
6. **Idioma de la UI**: propongo español con textos centralizados para traducir después.
7. **Compartir proyectos entre usuarios**: ¿solo propietario en etapa 1 o equipos/organizaciones?
8. **Licencia del repositorio** (MIT, privado sin licencia, otra).
