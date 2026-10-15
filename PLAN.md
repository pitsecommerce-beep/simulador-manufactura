# PLAN.md · Simulador de líneas de producción con robots ABB

Estado: **revisión 3, todas las decisiones tomadas (sección 18)**. Listo para iniciar la fase 1 tras confirmación.

---

## 1. Resumen

Aplicación web donde un usuario describe una línea de manufactura o empaque, un asistente de IA propone robots y componentes del catálogo, el usuario ajusta el layout en un lienzo 3D y el sistema simula la línea (eventos discretos + Monte Carlo), mostrando indicadores, código de control en ejecución, sensores y visión simulados.

Etapa 1: solo simulación. Etapa 2 (futura): ejecutar la misma lógica contra hardware físico. En esta etapa se deja listo el protocolo, la capa de seguridad y una demo con Web Serial.

---

## 2. Decisión de API: Node/TypeScript (Fastify)

Fastify es un framework para construir servidores HTTP (APIs) en Node.js, similar a Express pero más rápido y con validación de esquemas integrada. Es la pieza que recibe las peticiones del navegador, comprueba la sesión, consulta la base de datos y responde.

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

Tabla `jobs` en Postgres con `SELECT ... FOR UPDATE SKIP LOCKED`, reintentos y `LISTEN/NOTIFY`. Evita añadir Redis. La usa el cad-worker (`convert_cad`, `render_thumbnail`). El motor de línea ya no la usa: es un servicio HTTP interno (sección 22) porque el api no tiene `DATABASE_URL`. `train_policy` queda como contrato para un worker externo con GPU.

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

Herramientas: pnpm workspaces (TS), uv (Python), Ruff + mypy, ESLint + Prettier, Vitest, Pytest, Playwright (e2e mínimos). Ajustes hechos en la fase 1: sin Turborepo (innecesario con este tamaño), tests de RLS con Vitest contra Postgres local en vez de pgTAP, y la cola de trabajos Python vive en `packages/jobqueue-py`.

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

### 5.2 Datos de usuario (RLS por propietario y miembros)

- **projects**: `owner_id → auth.users`, `name`, `description`.
- **project_members**: `project_id`, `user_id → auth.users`, `role` (`viewer` | `editor`), `invited_by`. El propietario comparte un proyecto con cualquier usuario autenticado del equipo.
- **profiles**: `user_id`, `display_name`, `email` (para buscar a quién compartir; visible solo a autenticados).
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
- Todo usuario autenticado puede usar el simulador y crear proyectos.
- Datos de usuario: lectura si `auth.uid()` es propietario o miembro del proyecto; escritura si es propietario o miembro `editor`; borrar el proyecto y gestionar miembros solo el propietario. Se implementa con funciones `security definer` (`can_read_project`, `can_edit_project`) para evitar recursión en políticas.
- Registro de usuarios: abierto con correo y contraseña desde la web (con confirmación por correo de Supabase). También se puede invitar desde el panel de Supabase. Los proyectos son privados por RLS: un usuario nuevo solo ve los suyos y los que le compartan.
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

> El diseño vigente de la fase 4 está en las secciones 21 y 22. Esta sección es la visión general.

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

> El diseño vigente de la fase 9 está en la sección 23. Esta sección es la visión general.

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
| 2a | Catálogo con datos de ficha | `pnpm catalog:sql` genera un seed idempotente desde `catalog/*.json`; API y página de catálogo de solo lectura con la procedencia de cada dato (ver sección 19) |
| 2b | Pipeline CAD | Ingesta de archivos, worker STEP→GLB→URDF probado con STEP sintético generado por CadQuery, URLs firmadas, test de no-descarga |
| 3 | Lienzo 3D | Robots paramétricos desde la ficha, objetos paramétricos, ejes con límites, colores, guardar/cargar layouts, advertencias AABB/alcance/carga (ver sección 20). IK y personas/sensores pasan a fases posteriores |
| 4 | Motor de línea | Modelo de proceso en la escena (parte A), sim-worker HTTP con SimPy, Monte Carlo, indicadores con rangos, reproductor de eventos y comparación de corridas (parte B). Ver secciones 21 y 22 |
| 5 | Robots por ficha | Perfil trapezoidal, calibración con ciclos publicados, etiqueta ESTIMACIÓN en toda la UI |
| 6 | Personas | Agentes con turnos, descansos, errores, zonas de seguridad que afectan al robot |
| 7 | Sensores y visión | Sensores lógicos, cámara virtual con render y detección simulada |
| 8 | Código visible | RAPID/Python/Arduino generados, línea activa y E/S sincronizadas |
| 9 | Asistente IA | Chat lateral que propone layout y modelo de proceso con tools, vista previa, aceptar/descartar/deshacer, límites de uso (parte C). Ver sección 23 |
| 10 | Etapa 2 prep | Protocolo, capa de seguridad, demo Web Serial, modos realtime/acelerado, documento de diseño |

Al cerrar cada fase: resumen de qué funciona, qué falta y decisiones pendientes.

Tests obligatorios desde la fase en que aplica: alcance y carga (`domain`), paletizado (`domain`), indicadores (`sim-worker`, con casos analíticos tipo M/M/1 y línea en serie determinista), RLS (pgTAP), protección de descargas (API).

---

## 15. CI/CD

- `ci.yml` en cada PR y en `main`: `check-no-cad` → lint (ESLint, Prettier, Ruff) → typecheck (tsc, mypy) → tests (Vitest, Pytest, RLS contra Postgres de servicio) → build (web, api y las 4 imágenes Docker).
- Despliegue: integración web de Railway con GitHub. Cada servicio apunta a su carpeta del monorepo y se despliega al hacer push a `main`, con la opción "esperar a CI" activada para no desplegar si falla.
- Migraciones: se aplican a mano en Supabase > SQL Editor con `supabase/manual/apply_all.sql`, generado por `pnpm db:sql` a partir de `supabase/migrations`. El script es idempotente y registra cada migración en `app_migrations.applied`. El servicio `api` no aplica migraciones al desplegar ni necesita `DATABASE_URL`. `pnpm db:migrate` queda como alternativa local opcional y es compatible con el script manual.

---

## 16. Riesgos y limitaciones conocidas

| Riesgo | Impacto | Mitigación / alternativa |
|---|---|---|
| **Railway sin GPU** | No hay entrenamiento RL | Solo interfaz y cola; entrenar en un proveedor con GPU (Modal, RunPod, local) |
| **Supabase Free: 50 MB por archivo y 1 GB de Storage total** | Con ~15 modelos y sus variantes, los STEP originales pueden sumar varios GB y algunos superar 50 MB | Guardar los STEP comprimidos (gzip reduce STEP de 5x a 10x), subir datasheets y planos solo si caben, y un reporte de cuota en la ingesta. Si no alcanza: plan Pro o un bucket privado S3/R2 solo para originales |
| **Supabase Free: 500 MB de base de datos y pausa tras 7 días sin actividad** | Proyecto pausado, logs de eventos grandes | Logs de eventos en Storage (no en Postgres), limpieza de corridas antiguas, aviso en README para reactivar |
| **Cinemática cerrada** en IRB 360 (delta), IRB 460 e IRB 660 (paralelogramo) | URDF no representa cadenas cerradas | IRB 360 con cinemática delta analítica propia; IRB 460/660 con 4 ejes activos y eslabones pasivos como articulaciones `mimic`. El resto (brazos de 6 ejes, SCARA, cobots) usa URDF estándar |
| **CAD de robot de pintura** (IRB 52 / IRB 5500) | Puede no estar disponible para descarga | Se incluye solo si hay CAD; si no, queda en catálogo con specs y sin modelo 3D |
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

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (solo api y workers), `SUPABASE_JWT_SECRET`, `DATABASE_URL` (solo cad-worker, para la cola; y `pnpm db:migrate` local opcional), `SIM_WORKER_URL`, `SIM_WORKER_TOKEN`, `SIM_MAX_HORIZON_H`, `SIM_RUN_TIMEOUT_S`, `SIM_MAX_CONCURRENT_RUNS`, `AI_GLOBAL_DAILY_TOKEN_LIMIT`, `AI_PROVIDER`, `AI_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_DAILY_TOKEN_LIMIT`, `AI_DAILY_REQUEST_LIMIT`, `SIGNED_URL_TTL_SECONDS`, `SIM_MAX_REPLICATIONS`, `CAD_TESSELLATION_TOLERANCE`, `CAD_MAX_TRIANGLES_PER_LINK`, `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

---

## 18. Decisiones tomadas

1. **API**: Fastify con TypeScript.
2. **Supabase**: plan Free (ver riesgos de cuota en la sección 16).
3. **Despliegue**: integración web de Railway con GitHub; migraciones aplicadas a mano en el SQL Editor de Supabase antes de desplegar el código que las necesita.
4. **Secretos**: solo como variables en Railway.
5. **Robots del catálogo inicial** (todas las variantes disponibles de cada modelo):
   IRB 120, IRB 1100, IRB 1200, IRB 1300, IRB 1600, IRB 2600, IRB 4600, IRB 6700, IRB 460, IRB 660, IRB 360 FlexPicker, IRB 910SC, GoFa CRB 15000, SWIFTI CRB 1100, y un robot de pintura (IRB 52 o IRB 5500) si hay CAD.
6. **Idioma**: interfaz en español.
7. **Acceso**: todo usuario autenticado del equipo usa el simulador; los proyectos se comparten con usuarios autenticados (roles `viewer` y `editor`).
8. **Origen de CAD**: descarga directa desde ABB, hecha por el usuario (aceptar los términos del portal de ABB corresponde al usuario). El usuario coloca los archivos en `catalog/<robot_id>/` con su `source.json`; la ingesta hace el resto. Se entrega una plantilla de `manifest.json` con los 15 modelos y sus variantes para rellenar.
9. **Licencia**: repositorio privado, sin licencia abierta. Su único fin es el despliegue en Railway.

---

## 19. Diseño: fase 2a, catálogo con datos de ficha (sin CAD)

### 19.1 Archivos versionados

- Se versionan **solo** `catalog/manifest.json`, `catalog/<robot>/specs.json`, `catalog/<robot>/source.json`, `catalog_components/manifest_components.json`, `catalog_components/<categoría>/<id>/{specs,source}.json` y `catalog_components/standards/presets.json`.
- `.gitignore`: lista blanca explícita de esos nombres; todo lo demás bajo `catalog/` y `catalog_components/` sigue ignorado.
- `check-no-cad`: dentro de las carpetas de catálogo solo se permiten `README.md`, `examples/` y esos `.json`. Cualquier otro archivo (PDF, STEP, zip, DWG, imágenes, otros JSON) falla. Se añade test.
- Los JSON solo contienen metadatos (cifras, URLs públicas de ABB Library, hashes, términos). Ningún contenido de los PDF ni del CAD.

### 19.2 Formato real de los JSON (revisado)

14 robots, 40 variantes. Lo relevante para el seed:

| Fuente | Campos | Particularidades |
|---|---|---|
| `manifest.json` | `robot_id`, `name`, `family`, `application`, `status` (`ok`/`partial`), `product_page`, `notes` | `family` en 8 valores (Articulated small/medium/large, Collaborative, Delta, SCARA invertido, Palletizing 4-axis, Paint) |
| `specs.json` (robot) | `typical_application`, `extracted_from`, `extracted_at`, `extraction_note`, `notes`, `manual` | |
| `specs.json` (variante) | `variant`, `robot_id` (slug), `axes`, `reach_mm`, `payload_kg`, `armload_kg`, `robot_weight_kg`, `mounting[]`, `ip_rating`, `controller`, `repeatability{}`, `axis_data[]`, `cycle_times[]`, `sources{}`; opcionales `workspace_diameter_mm`, `max_tcp_speed_m_s`, `payload_note`, `extra{}` | `axes` puede ser texto (`"3 o 4"` en IRB 360) o null (IRB 5500). `reach_mm` es null en IRB 360 (publica diámetro de trabajo). Eje 3 del IRB 910INV en mm y m/s. `cycle_times` puede ser valor simple o tabla por variante con `mapping_uncertain`. `mounting` a veces es texto libre |
| `sources{}` | clave = grupo de campos unidos por `_` (ej. `reach_payload_mounting_ip_controller`, `axes_range`, `all`) → `{file, page, section}` | |
| `source.json` | `files[]` con `path`, `kind` (`datasheet`, `product_specification`, `cad_step`, `drawing_dwg_dxf`), `doc_id`, `revision`, `doc_date`, `title`, `url`, `library_page`, `accessed_at`, `sha256`, `size_bytes`, `license_terms` | |

### 19.3 Cambios de esquema (migración nueva `20261006000100_catalog_sheet_data.sql`)

La migración del catálogo ya aplicada no se toca. La nueva añade:

- **robots**: `application text`, `typical_application text`, `product_page text`, `data_status text` (`ok`/`partial`), `notes text[]`.
- **robot_specs**: `armload_kg`, `workspace_diameter_mm`, `max_tcp_speed_m_s`, `payload_note`, `axes_note` (texto original cuando `axes` no es un entero, ej. "3 o 4"), `repeatability jsonb` (detalle completo), `extra jsonb`, `notes text[]`. `repeatability_mm` = `pose_repeatability_mm` o `position_repeatability_mm` si existe; si no, null.
- **robot_documents** (nueva): `robot_id`, `path`, `kind`, `doc_id`, `revision`, `doc_date`, `title`, `url`, `library_page`, `accessed_at`, `sha256`, `size_bytes`, `license_terms`; único `(robot_id, path)`. Solo filas de documentos que respaldan datos (`datasheet`, `product_specification`); los CAD y planos se registrarán en `robot_assets` en la fase 2b, cuando existan en el bucket. RLS: lectura para autenticados, escritura solo `service_role`. Las URL son las públicas de ABB Library; no hay descarga desde la app.
- `axis_limits` pasa a guardar `{axis, min, max, unit: "deg"|"mm", max_speed, speed_unit}` tal como viene la ficha (necesario para el eje lineal del SCARA). Se documenta con `comment on column`.

### 19.4 Generador `pnpm catalog:sql`

- `packages/db/src/catalog-seed.ts` (mismo patrón que `bundle.ts`): lee los JSON, los valida con Zod (desconocidos → advertencia en consola, no error) y escribe `supabase/manual/seed_catalog.sql`. `--check` falla si no está al día; un test lo verifica.
- Un solo script transaccional (`begin … commit`) con `insert … on conflict (slug) do update` para `robots`, `robot_variants`, `robot_specs`, `robot_documents`; las variantes o documentos que ya no estén en los JSON se borran del robot correspondiente (el seed refleja exactamente los archivos).
- **Nulos**: todo campo ausente o null queda `null`. No se convierte texto a número salvo que el valor ya sea numérico. `"3 o 4"` → `axes_count = null`, `axes_note = '3 o 4'`.
- **Procedencia por dato**: `provenance` = `{ "<campo>": [{ "file", "page", "section", "doc_id", "revision" }] }`. Título, URL, fecha de consulta y términos de uso están en `robot_documents` y se unen por `file` = `path` (así no se repiten en cada dato). El campo se asocia a la clave de `sources` cuyos tokens lo contienen (`reach`, `payload`, `armload`, `mounting`, `ip`, `controller`, `repeatability`, `weight`, `axes`, `cycle_times`, `performance`, `variants`, `all`). Si ninguna clave lo cubre, el dato se guarda con procedencia `null` y la UI muestra "fuente no indicada".
- Componentes: tabla `component_documents` análoga, y columnas `type` y `notes` en `components`.
- `kinematic_type` se deriva de `family` (Articulated/Collaborative/Paint → `serial`; Palletizing 4-axis → `parallel_linkage`; Delta → `delta`; SCARA → `scara`). `manufacturer = 'ABB'` (todos vienen de ABB Library).
- Componentes (`catalog_components`) y `presets.json`: se cargan a `components`/`component_specs` (specs tal cual, con su fuente) y `object_types.presets`. No se muestran aún en la UI salvo los presets de pallet del lienzo.

### 19.5 API (solo lectura, sesión obligatoria, RLS con el JWT del usuario)

- `GET /v1/catalog/variants?q=&family=&application=&payload_min=&payload_max=&reach_min=&reach_max=` → lista plana de variantes con robot, familia, aplicación, alcance, carga, ejes. Los filtros numéricos excluyen las variantes con el dato en null (la UI lo indica).
- `GET /v1/catalog/variants/:slug` → robot, variante, specs completas, `provenance` y `documents`.
- `GET /v1/catalog/facets` → familias y aplicaciones disponibles, rangos de carga y alcance.

### 19.6 Web

- Menú "Catálogo". Página con buscador (modelo o variante), filtros por familia, aplicación, rango de carga y de alcance, y tarjetas o tabla de variantes.
- Ficha por variante (`/catalogo/:slug`): tabla de datos con un icono de fuente en cada fila (documento, página, sección, revisión, fecha de consulta, términos de uso); tabla de ejes; tiempos de ciclo con su condición (y aviso si `mapping_uncertain`); notas de extracción. Los null se muestran como **"No publicado"** con estilo distinto, nunca como 0 ni guion ambiguo. Aviso de estimación y de derechos de ABB.

### 19.7 Tests

- Seed: archivo al día; aplicar dos veces deja las mismas filas (idempotencia); campos ausentes quedan null (IRB 360 sin `reach_mm`, IRB 5500 sin ejes); `axes_note` y procedencia correctos; documentos con términos de uso.
- API: 401 sin sesión, filtros y detalle con repositorio falso, 404 de variante inexistente.
- RLS: autenticado lee catálogo y `robot_documents`; no puede insertar, actualizar ni borrar; `anon` no lee nada.

---

## 20. Diseño: fase 3, lienzo 3D con robots simplificados

### 20.1 Tecnología

`three`, `@react-three/fiber`, `@react-three/drei` (OrbitControls, TransformControls, Grid, Html). El lienzo se carga con `React.lazy` para no engordar el resto de la web. Unidades del modelo: milímetros; la escena 3D usa metros (factor 0.001). Eje Z hacia arriba en el modelo de datos.

### 20.2 Modelo de escena (`packages/domain/src/scene.ts`, validado con Zod)

```
SceneV1 = { schema: 1, objects: SceneObject[] }
SceneObject = {
  id, name, kind: 'robot' | 'pallet' | 'box' | 'table' | 'conveyor',
  position: [x, y] (mm), elevation (mm), rotation_deg (giro sobre Z), color '#rrggbb',
  params: según kind,
  served_by?: id de robot (para validar alcance y carga)
}
robot.params  = { variant_slug, joints: number[] (deg o mm por eje), mounting: 'floor' }
pallet.params = { preset: 'eur'|'gma'|'1200x1000'|'custom', length_mm, width_mm, height_mm }
box.params    = { length_mm, width_mm, height_mm, mass_kg | null }
table.params  = { length_mm, width_mm, height_mm }
conveyor.params = { length_mm, width_mm, height_mm }
```

Se guarda en `layouts.scene` del layout actual (`is_current`). `object_instances` queda para cuando la simulación lo necesite (fase 4); no se duplica ahora.

### 20.3 Guardar y cargar

- `GET /v1/projects/:id/layout` → layout actual (o una escena vacía si no existe).
- `PUT /v1/projects/:id/layout` con `{ scene, version }`: valida con Zod, actualiza en sitio el layout actual y sube `version` en 1. Si `version` no coincide → 409 ("otro usuario guardó cambios; recarga"). Si no existe layout, lo crea con versión 1.
- Usa el JWT del usuario, así que RLS decide: propietario y editor guardan, lector solo lee (la UI desactiva edición para lectores). No hace falta migración: las políticas de `layouts` ya existen.

### 20.4 Robots paramétricos (`packages/domain/src/robot-model.ts`)

Funciones puras que, a partir de `robot_specs`, devuelven una cadena de eslabones (longitudes, ejes de giro, límites) que el lienzo dibuja con cilindros y cajas.

- **Datos de ficha usados**: `reach_mm` (o `workspace_diameter_mm`), `axis_limits` (rango y unidad por eje), `axes_count`, `payload_kg`.
- **Proporciones de eslabones**: no se publican en las fichas. Se usan proporciones fijas por familia (ej. serie de 6 ejes: altura de hombro 0.35·R, brazo 0.45·R, antebrazo 0.45·R, muñeca 0.10·R, ajustadas para que el alcance máximo sea exactamente R). Son un supuesto de visualización, documentado en el código y en la UI.
- **Serie (6 ejes, cobots, pintura)**: base, hombro, brazo, antebrazo, muñeca y herramienta.
- **4 ejes de paletizado (IRB 460/660)**: cadena serie con la muñeca forzada a horizontal (simula el paralelogramo).
- **Delta (IRB 360)**: base hexagonal en altura, tres brazos y plataforma; la plataforma se mueve dentro de un cilindro de diámetro `workspace_diameter_mm` (la altura del volumen no se publica: se dibuja como disco y se avisa).
- **SCARA invertido (IRB 910INV)**: montado en techo, dos brazos horizontales (R repartido 50/50), eje 3 lineal con carrera de la ficha (mm), eje 4 de giro.
- **Sin ejes publicados (IRB 5500)**: se dibuja un bloque con su alcance, sin sliders, con la advertencia "ejes no publicados".
- **Sliders por eje**: limitados a `[min, max]` de la ficha. Si un eje no tiene rango publicado, el slider queda desactivado con "rango no publicado".
- **Envolvente**: esfera de radio R centrada en el hombro (serie y 4 ejes), cilindro (delta), anillo con altura igual a la carrera (SCARA). Semitransparente, se activa por robot.
- Rótulo fijo en el lienzo: "Representación simplificada generada desde la ficha técnica. No es el CAD real".

### 20.5 Objetos paramétricos

- **Pallets**: EUR 1200×800, GMA 1219×1016, 1200×1000 (dimensiones de `presets.json`) y personalizado. La altura solo está publicada para EUR (144 mm); para los demás el campo empieza vacío y se debe capturar (se marca "altura no publicada"). Ver pregunta 2.
- **Cajas** (con masa opcional), **mesas** y **bandas transportadoras**: medidas editables en mm.
- Todos se colocan sobre el piso o encima de otro objeto (`elevation`).

### 20.6 Interacción

- Panel izquierdo: lista de objetos y botón "Añadir" (robot desde el catálogo con buscador, o tipo de objeto).
- Lienzo: piso con cuadrícula de 100 mm / 1 m, cámara orbital, clic para seleccionar (contorno resaltado), gizmo para mover sobre el piso y girar sobre Z, con ajuste opcional a la cuadrícula.
- Panel derecho del objeto seleccionado: nombre, posición, giro, color, medidas, "atendido por" (robot), sliders de ejes y casilla de envolvente.
- Barra superior: Guardar (con estado "cambios sin guardar"), deshacer simple, contador de advertencias.

### 20.7 Validaciones (`packages/domain/src/validate.ts`, puras)

- **Alcance**: para cada objeto con `served_by`, distancia horizontal y vertical desde el centro de la envolvente del robot al punto más cercano de la cara superior del objeto. Si supera R → "Pallet 1 fuera del alcance de IRB 1300-7/1.4 (excede 230 mm)". Delta y SCARA usan su envolvente propia. Con alcance no publicado → aviso "no se puede validar".
- **Carga**: cajas con `served_by` y `mass_kg` > `payload_kg` → advertencia. Masa o carga desconocida → aviso informativo. Solo se compara el valor nominal (sin curva de carga).
- **Colisiones (AABB)**: cajas delimitadoras alineadas a los ejes del mundo, calculadas con la rotación de cada objeto. Para robots se usa la base (huella) y no el brazo. Contacto exacto (apoyado encima) no cuenta. Se informan los pares que se solapan.
- Panel de advertencias visible y objetos implicados resaltados en ámbar.

### 20.8 Tests

- Dominio: alcance (dentro, fuera, borde, alcance null, delta y SCARA), carga (bajo, sobre, desconocida), AABB (solapado, tocándose, separado, con rotación de 90°), validación Zod de escenas, generación de cadenas por familia y límites de sliders.
- API: GET/PUT de layout, 409 por versión, 400 por escena inválida, 403 a lector.
- RLS: editor guarda layout, lector no, extraño no lo ve.

### 20.9 Decisiones confirmadas

1. Proporciones fijas por familia, marcadas en la UI como "supuesto visual".
2. Altura de pallets GMA y 1200×1000 vacía y obligatoria; la ayuda "EUR publicado: 144 mm" no se guarda.
3. Los componentes se cargan ya en el seed, sin UI.

### 20.10 Preguntas originales

1. **Proporciones de eslabones**: como las fichas no publican longitudes de eslabón, ¿aceptas proporciones fijas por familia, marcadas como supuesto visual?
2. **Altura de pallets GMA y 1200×1000**: no está publicada en `presets.json`. ¿Campo vacío obligatorio (propuesta) o un valor por defecto editable marcado como supuesto?
3. **Componentes**: ¿los cargo ya en el seed (sin UI) o los dejo para cuando haya objetos de catálogo en el lienzo?

---

## 21. Diseño: parte A, modelo de proceso (base de las fases 4 y 9)

### 21.1 Principio

El flujo de producción vive en la misma escena (`layouts.scene`) que el lienzo, ligado a los objetos colocados. No hace falta migración: es `jsonb`. La escena pasa a `schema: 2`; al leer una escena `schema: 1` se convierte sola (proceso vacío), así que los layouts guardados siguen funcionando.

Cada parámetro de tiempo o tasa lleva su **origen**:

| Origen | Significado | Cómo se muestra |
|---|---|---|
| `catalog` | Tiempo de ciclo publicado en la ficha (con su condición de medición, ej. "25/305/25 mm, 1 kg") | Fuente del catálogo, como en la ficha |
| `user` | Lo capturó el usuario | Etiqueta **"Supuesto del usuario"** |
| `assistant` | Lo propuso el asistente de IA (parte C) | Etiqueta **"Supuesto del asistente"**, hasta que el usuario lo confirme |

Nunca hay un valor por defecto escondido: si un tiempo no viene de la ficha, el campo empieza vacío y la validación exige capturarlo.

### 21.2 Modelo (`packages/domain/src/process.ts`, Zod)

```
Distribución (segundos):
  fixed {value} | exponential {mean} | normal {mean, sd} (truncada en 0)
  | triangular {min, mode, max} | uniform {min, max} | lognormal {mean, sd}

scene.process = {
  product: { name, bom: [{ item, qty }] }          // BOM simple: componentes por unidad
  nodes: [ ...uno por objeto con rol en el proceso... ]
  routes: [{ id, from, to, item | null, share | null }]
}

Roles de nodo (node.object_id apunta a un objeto del lienzo):
  source   en banda, mesa, pallet o caja: item, interarrival (Distribución + origen), lote
  station  en robot, banda o mesa (manual): cycle (Distribución + origen), capacidad (unidades
           en paralelo), operación process | assemble (consume la BOM), scrap_rate (+ origen),
           failures { mtbf_s, mttr_s, distribuciones } | null (+ origen)
  buffer   en banda o mesa: capacity (entero >= 1), transfer (Distribución, tiempo de recorrido)
  sink     en pallet o mesa: units_per_pallet (pallet lleno), pallet_change (Distribución)
```

- **Rutas**: flechas de un nodo a otro. `item` restringe qué pasa por la ruta (para ensamblaje). `share` reparte el flujo cuando un nodo tiene varias salidas (deben sumar 1).
- **Bloqueo**: una estación que termina y no tiene espacio aguas abajo queda **bloqueada** con la pieza (bloqueo tras servicio). Entre estaciones sin buffer explícito la capacidad es 0: es una decisión explícita, no un supuesto escondido.
- **Ensamblaje**: una estación `assemble` espera a tener en sus entradas los componentes de la BOM y produce una unidad de producto.

### 21.3 Validación (`validateProcess`, pura)

Errores (impiden simular):
- Ruta a un nodo inexistente, de un `sink`, hacia un `source`, o rol incompatible con el tipo de objeto (un robot no puede ser buffer).
- **Ruta sin salida**: algún nodo no llega a ningún `sink`.
- Nodo inalcanzable desde un `source`.
- **Ciclos** en el grafo de rutas (el retrabajo queda para después).
- **Buffer sin capacidad** o con capacidad no entera o menor que 1.
- Estación sin tiempo de ciclo, fuente sin tasa de llegada, `sink` sin unidades por pallet.
- Reparto (`share`) que no suma 1 o que falta en un nodo con varias salidas.
- Estación `assemble` cuyas entradas no aportan todos los componentes de la BOM.
- Parámetros fuera de rango (tiempos negativos, `scrap_rate` fuera de [0, 1), MTTR sin MTBF).

Advertencias (se puede simular):
- Parámetros con origen `user` o `assistant` ("supuesto").
- Robot usado como estación cuya ficha publica tiempos de ciclo, pero el usuario usó otro valor.
- Estación de robot cuya carga (pieza + gripper) excede la carga útil (reutiliza `validateScene`).

### 21.4 Objetos nuevos en la escena

| Tipo | Medidas | Ligado al catálogo | Validaciones |
|---|---|---|---|
| `gripper` | Se monta en un robot (`mounted_on`) | `component_slug` de `catalog_components/grippers` | Su peso publicado (si existe) se suma a la carga del robot; si no está publicado, se avisa |
| `sensor` | Posición y orientación | `component_slug` de `sensors` | Se dibuja con un volumen simple; la lógica de detección llega en la fase 7 |
| `fence` | Largo, alto, grosor | Opcional (`fences`) | Entra en colisiones AABB |
| `safety_zone` | Rectángulo en el piso | No | No colisiona; avisa si la envolvente de un robot la invade |

Las medidas iniciales de valla y zona son editables y no se presentan como dato de fabricante. Para elegir componentes, la API agrega `GET /v1/catalog/components` (solo lectura, con sesión).

### 21.5 Lienzo

- **Modo flujo** en la barra: muestra las flechas de las rutas. Para conectar: clic en el objeto origen y luego en el destino (o desde el panel, con "Conectar a…").
- Panel del objeto seleccionado: sección **"Proceso"** con rol, parámetros, distribución (selector con sus campos) y origen. Los robots con ciclo publicado ofrecen "Usar ciclo de la ficha" con su condición de medición.
- Panel **"Validación del flujo"**, junto al de alcance, carga y colisiones.

### 21.6 Tests de la parte A

Rutas sin salida, nodos inalcanzables, ciclos, buffer sin capacidad o fraccionaria, repartos que no suman 1, BOM no cubierta, roles incompatibles, conversión de escenas `schema: 1`, limpieza de rutas al borrar un objeto, carga con gripper (con y sin peso publicado) y orígenes de los parámetros.

---

## 22. Diseño: parte B, motor de línea (fase 4)

### 22.1 Arquitectura sin `DATABASE_URL`

```
web ──► api (Fastify) ──HTTP privado──► sim-worker (Python, SimPy)
         │ valida, crea la corrida            │ simula en segundo plano
         │ (supabase-js + clave secreta)      │ escribe estado y métricas en PostgREST
         ▼                                    │ y el registro de eventos en Storage
      Supabase ◄──────────────────────────────┘ (clave secreta)
```

- **sim-worker como servicio HTTP interno** (FastAPI + uvicorn) en la red privada de Railway (`sim-worker.railway.internal`), sin dominio público. Escucha en IPv6 (`::`), que es lo que exige la red privada de Railway; si el sistema no tiene IPv6 (desarrollo local) usa `0.0.0.0`, y `SIM_WORKER_HOST` lo fuerza.
- La api lo llama con un token compartido (`SIM_WORKER_TOKEN`). El worker responde `202` y simula en un proceso aparte (`ProcessPoolExecutor`), con `SIM_MAX_CONCURRENT_RUNS` corridas a la vez.
- El worker guarda estado, métricas y eventos en Supabase por HTTPS con la clave secreta (PostgREST y Storage). No necesita conexión directa a Postgres.
- **Alternativas descartadas**:
  - *Cola en Postgres (`public.jobs`)*: necesita `DATABASE_URL`, que no tenemos.
  - *Simular dentro de la api*: obligaría a reescribir el motor en TypeScript en lugar de SimPy, y una corrida larga bloquearía la api.
  - *Edge Functions de Supabase*: corren en Deno, sin Python.
- **Corridas huérfanas**: si el worker se reinicia, una corrida `running` se marca como `failed` ("el motor se reinició") cuando supera `SIM_RUN_TIMEOUT_S`. Esto se revisa al listar corridas.
- El `cad-worker` sigue como está (cola con `DATABASE_URL`); no forma parte de esta fase.

### 22.2 Flujo de una corrida

1. `POST /v1/projects/:id/runs` (propietario o editor) con `{ name, horizon_h, warmup_h, replications, seed, demand_per_hour | null }`. La api:
   - carga el layout actual, valida escena y proceso (`validateProcess`) y rechaza con 400 si hay errores;
   - limita `replications` a `SIM_MAX_REPLICATIONS` y `horizon_h` a `SIM_MAX_HORIZON_H`;
   - crea un `scenario` con la configuración y un `simulation_run` (`queued`) con la **foto** de la escena (los resultados quedan ligados a lo que se simuló, aunque el layout cambie después);
   - envía el modelo compilado al worker.
2. El worker marca `running`, simula, escribe `simulation_metrics`, sube el registro de eventos y marca `succeeded` o `failed` con el error.
3. La web consulta `GET /v1/projects/:id/runs/:runId` cada pocos segundos mientras la corrida está en curso.
4. `GET /v1/projects/:id/runs` lista corridas; `GET …/runs/:runId/events` devuelve el registro de eventos (la api lo lee de Storage tras comprobar con RLS que el usuario puede ver la corrida).

### 22.3 Motor (SimPy)

- Recursos SimPy por estación (capacidad = unidades en paralelo) y `Store` con capacidad por buffer.
- Bloqueo tras servicio; fallas como procesos que interrumpen la estación (MTBF y MTTR). Ver la pregunta 3 sobre cómo se mide el MTBF.
- Calentamiento: las estadísticas se reinician al terminar `warmup_h`.
- **Semillas**: réplica *i* usa `Random(hash(seed, i, flujo))`, con un flujo independiente por fuente, estación y falla. Misma semilla y mismo modelo producen exactamente los mismos resultados.
- Las réplicas corren en paralelo dentro del proceso de la corrida.

### 22.4 Indicadores

Por réplica y agregados (mínimo, promedio, máximo, p5, p95 e intervalo de confianza al 95 % de la media):

| Indicador | Definición |
|---|---|
| Producción por hora | Unidades buenas que llegan a un `sink` / horas medidas (sin calentamiento) |
| Total ensamblado o empacado | Unidades buenas; pallets llenos completados |
| Tiempo de ciclo de la línea | 3600 / producción por hora (s por unidad) |
| Tiempo de flujo | Promedio desde que una unidad entra hasta que sale (s) |
| Takt time | 3600 / demanda por hora. **Solo si el usuario captura la demanda** (no se supone) |
| Utilización por estación | Fracción del tiempo ocupada; también bloqueada, en espera y en falla |
| Cuello de botella | Estación con mayor fracción ocupada + en falla. Se indica el criterio y la segunda estación más cercana |
| WIP | Unidades en el sistema, promedio (y ocupación promedio por buffer) |
| OEE por estación y de la línea | Disponibilidad × rendimiento × calidad. Disponibilidad = 1 − falla; rendimiento = (ciclo ideal × unidades) / tiempo operando, con ciclo ideal = media del ciclo; calidad = buenas / (buenas + scrap). OEE de la línea = el del cuello de botella |
| Scrap | Unidades descartadas por estación y total |

Cada métrica guarda `is_estimate = true` y su origen de datos. Los supuestos usados (parámetros con origen `user` o `assistant`) se listan junto a los resultados.

### 22.5 Registro de eventos y reproducción

- Réplica representativa: la de producción por hora más cercana a la media.
- Eventos `{t, kind: 'state', node, state}` y `{t, kind: 'move', unit, from, to, dur}` de una ventana de reproducción (por defecto, los primeros 30 min tras el calentamiento, con un tope de 200 000 eventos). Se guardan comprimidos en `sim-artifacts/runs/<run_id>/events.json.gz`.
- En el lienzo, barra de reproducción con reproducir, pausar, velocidad (1× a 120×) y línea de tiempo. Las unidades se mueven como cajas pequeñas por las rutas (interpolación lineal entre objetos) y cada estación cambia de color: **ocupada** (verde), **bloqueada** (ámbar), **en espera** (gris) y **en falla** (rojo).

### 22.6 Resultados y comparación

- Página de resultados en el proyecto, con tarjetas de indicadores (valor promedio y rango mín–máx), tabla por estación y cuello de botella resaltado.
- **Comparar dos corridas**: tabla lado a lado con la diferencia y si los intervalos se solapan ("diferencia no concluyente").
- Aviso fijo: **"Resultados estimados con supuestos y datos de ficha. No son garantías de rendimiento."**

### 22.7 Cambios de esquema (migración nueva)

- `simulation_runs`: `name`, `input jsonb` (foto de la escena y configuración), `summary jsonb` (cuello de botella, supuestos, notas), `layout_version int`, `progress numeric`.
- `simulation_metrics`: `ci_low`, `ci_high`, `label text` (nombre legible del alcance, ej. la estación).
- Sin cambios de RLS: los miembros leen y escriben solo la api y el worker con la clave secreta.

### 22.8 Railway

Servicio `sim-worker` (el que ya existe, con nueva configuración): Dockerfile con `uvicorn`, `railway.json` con healthcheck `/health`, sin dominio público.

| Servicio | Variables nuevas |
|---|---|
| sim-worker | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SIM_WORKER_TOKEN`, `SIM_MAX_REPLICATIONS`, `SIM_MAX_CONCURRENT_RUNS`. Ya no usa `DATABASE_URL` |
| api | `SIM_WORKER_URL=http://sim-worker.railway.internal:8080`, `SIM_WORKER_TOKEN` (el mismo), `SIM_MAX_REPLICATIONS`, `SIM_MAX_HORIZON_H`, `SIM_RUN_TIMEOUT_S` |

### 22.9 Estado de la implementación

- Hecho tal como está diseñado, con dos precisiones:
  - Una fuente que no puede entregar espera (no se acumulan llegadas fuera del sistema). Para modelar una cola infinita se pone un buffer grande después de la fuente.
  - Con más de una unidad en paralelo, las fallas usan el tiempo de operación de la estación en conjunto.
- El sim-worker dejó de consumir la cola `jobs` (sus trabajos `ping` y `train_policy` se retiraron con el servicio).

### 22.10 Tests de la parte B

- **Analíticos**: M/M/1 con buffer amplio (utilización ρ, WIP L = ρ/(1−ρ) y producción = λ, dentro de una tolerancia con muchas réplicas); línea en serie con tiempos fijos (producción = 1 / ciclo máximo, utilización = ciclo / ciclo máximo, cuello de botella correcto); línea con buffer 0 y bloqueo; disponibilidad con fallas fijas = MTBF / (MTBF + MTTR).
- **Reproducibilidad**: misma semilla, mismos resultados; semilla distinta, resultados distintos.
- Indicadores (OEE, takt solo con demanda, scrap), límites de réplicas y horizonte, token del worker, escritura en Supabase con cliente falso, endpoints de corridas (permisos, 400 por proceso inválido), RLS de lectura y reproductor (interpolación de eventos).

---

## 23. Diseño: parte C, asistente de IA (fase 9)

### 23.1 Proveedor

- `apps/api/src/ai/provider.ts`: interfaz `AiProvider` (un turno con historial, herramientas y uso de tokens). Primera implementación: Anthropic con el SDK oficial `@anthropic-ai/sdk`. OpenAI se agrega después con la misma interfaz.
- Variables: `AI_PROVIDER` (`anthropic`), `AI_MODEL` (**obligatoria**, el código no fija ningún modelo; sin ella el asistente responde "no configurado"), `ANTHROPIC_API_KEY`, `AI_DAILY_REQUEST_LIMIT`, `AI_DAILY_TOKEN_LIMIT`, `AI_GLOBAL_DAILY_TOKEN_LIMIT`, opcional `AI_EFFORT` (esfuerzo de razonamiento, `low` a `max`).
- Valor de ejemplo en el README: `AI_MODEL=claude-sonnet-5-5`; `claude-opus-5-5` para layouts más complejos.
- Bucle de herramientas propio en la api (máximo 8 vueltas por mensaje), con elección de herramienta `auto` y `strict: true` en los esquemas (los modelos actuales rechazan forzar una herramienta). El historial se guarda y se reenvía tal cual, sin editarlo, como piden los modelos actuales para conservar su razonamiento entre turnos.

### 23.2 Endpoint y herramientas

`POST /v1/projects/:id/assistant` (solo propietario o editor; lector 403) con `{ conversation_id | null, message, current_scene }`. `current_scene` es la escena que el usuario tiene en el editor, aunque no esté guardada, para poder iterar ("agrega otra banda").

| Herramienta | Qué hace (siempre con el JWT del usuario y RLS) |
|---|---|
| `search_catalog` | Busca variantes con los filtros del catálogo |
| `get_variant` | Ficha completa con procedencia; los datos no publicados llegan como `null` |
| `list_components` | Componentes del catálogo por categoría |
| `propose_scene` | Recibe layout + modelo de proceso. La api valida el esquema, que cada `variant_slug` y `component_slug` exista, alcance, carga, AABB y flujo, y devuelve la propuesta con id y advertencias |
| `validate_scene` | Las mismas validaciones sobre una escena, sin registrarla como propuesta |
| `run_simulation` | Opcional: corrida rápida (pocas réplicas, horizonte corto) con espera máxima de 60 s; si tarda más, devuelve "sin estimación" |

Reglas del asistente (system prompt), reforzadas en código:
- Solo usa robots y componentes que existan en el catálogo; `propose_scene` rechaza slugs inexistentes.
- La escena guarda referencias al catálogo, nunca cifras de ficha copiadas por el modelo: alcance, carga y rangos siempre se leen del catálogo.
- Los tiempos que proponga el asistente quedan con origen `assistant` ("supuesto del asistente").
- Antes de responder valida (`propose_scene` ya valida) y, si hay errores, corrige y vuelve a proponer. Al final explica sus supuestos y qué datos no están publicados.

### 23.3 Guardado y aceptación

- Cada intercambio se guarda en `ai_conversations` (mensajes, llamadas a herramientas, tokens, propuestas).
- **Nada se escribe en `layouts`.** Aceptar aplica la propuesta al editor; queda como "cambios sin guardar" y el usuario guarda con el botón de siempre. Ver la pregunta 1.
- **Límites por usuario y día** en `ai_usage` y **tope global diario** de tokens, con una función atómica `public.consume_ai_usage(...)` que solo puede ejecutar la clave secreta. Si se supera, el asistente responde con un mensaje claro (qué límite y que se reinicia a medianoche UTC), sin error.

### 23.4 UI

- Panel lateral de chat en el editor (se abre con "Asistente").
- Cada propuesta se dibuja en la cuadrícula como **vista previa diferenciada**: objetos semitransparentes con borde punteado violeta, superpuestos a la escena actual.
- Junto a la propuesta:
  - robots y componentes elegidos, con miniatura y enlace a su ficha;
  - advertencias de validación;
  - producción estimada si se simuló, con su rango;
  - botones **Aceptar (reemplazar)**, **Aceptar (fusionar)**, **Descartar** y **Deshacer** (vuelve a la escena previa a la última aceptación).
- **Miniaturas**: todavía no hay renders de CAD (llegan en la fase 2b), así que la miniatura es un ícono paramétrico de la familia del robot generado por código. Se indica así en la UI.

### 23.5 Cambios de esquema (migración nueva)

- `ai_conversations`: `proposals jsonb` (propuestas con id, escena, advertencias, estado `pending | accepted | discarded`).
- Función `public.consume_ai_usage(user_id, requests, tokens_in, tokens_out, request_limit, token_limit)`: `security definer`, ejecutable solo por `service_role`.

### 23.6 Costo aproximado (se detallará en el README)

Un mensaje del usuario suele implicar de 3 a 6 llamadas al modelo (búsquedas, propuesta, corrección), con unos 40 000 a 80 000 tokens de entrada acumulados y 5 000 a 10 000 de salida.

| Modelo | Precio (entrada / salida por millón de tokens) | Costo aproximado por mensaje |
|---|---|---|
| `claude-opus-5-5` | USD 4 / 20 | USD 0.25 a 0.50 |
| `claude-sonnet-5-5` | USD 2 / 10 | USD 0.12 a 0.25 |

El caché de prompts (instrucciones y herramientas fijas) reduce la entrada repetida. Los límites diarios acotan el gasto: con 30 mensajes por usuario al día y Sonnet, el máximo ronda los USD 7.5 por usuario, y el tope global de tokens limita el total de la app.

### 23.7 Tests de la parte C

Con un proveedor falso que reproduce respuestas guionizadas (sin llamadas reales): validación de propuestas (slug inexistente, escena inválida, corrección en una segunda vuelta), límites de uso (429 y conteo), permisos (lector 403, extraño 404), que ninguna ruta del asistente escribe en `layouts`, conversaciones guardadas y "no configurado" sin `AI_MODEL`.

### 23.8 Decisiones confirmadas

1. **Aceptar** aplica la propuesta al editor; se guarda con el botón Guardar de siempre.
2. **Takt time**: campo opcional "Demanda (unidades/h)" por corrida; sin él, el takt se muestra como "requiere demanda".
3. **Fallas**: MTBF medido sobre tiempo de operación.
4. **Modelo**: el README usa `claude-sonnet-5-5` como valor de ejemplo de `AI_MODEL`, con una nota de que `claude-opus-5-5` sirve para layouts más complejos. Los identificadores se verifican en la documentación oficial antes de documentarlos.
5. **Límites**: `AI_DAILY_REQUEST_LIMIT=30` y `AI_DAILY_TOKEN_LIMIT=1000000` por usuario y día, más un tope global `AI_GLOBAL_DAILY_TOKEN_LIMIT` (ejemplo: 5 000 000) para toda la app. Al alcanzar cualquier límite, el asistente responde con un mensaje claro (cuál límite y cuándo se reinicia) en lugar de fallar.
