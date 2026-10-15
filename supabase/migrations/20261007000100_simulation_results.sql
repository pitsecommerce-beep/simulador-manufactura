-- Fase 4: corridas del motor de línea. Las escriben la api y el sim-worker con la clave
-- secreta (service_role); los miembros del proyecto solo leen (políticas existentes).

alter table public.simulation_runs
  add column name text check (name is null or length(name) between 1 and 200),
  -- Foto de lo simulado: escena, modelo compilado y configuración. Los resultados quedan
  -- ligados a ella aunque el layout cambie después.
  add column input jsonb check (input is null or jsonb_typeof(input) = 'object'),
  -- Cuello de botella, supuestos usados y notas del motor.
  add column summary jsonb check (summary is null or jsonb_typeof(summary) = 'object'),
  add column layout_version int,
  add column progress numeric check (progress is null or (progress >= 0 and progress <= 1));

create index on public.simulation_runs (project_id, created_at desc);

alter table public.simulation_metrics
  add column ci_low numeric,
  add column ci_high numeric,
  -- Nombre legible del alcance (por ejemplo, la estación).
  add column label text;
