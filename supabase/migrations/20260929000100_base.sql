-- Base: esquemas auxiliares y funciones comunes.
-- Convención: todas las tablas de `public` tienen RLS. Las funciones auxiliares de
-- políticas viven en `private`, que no se expone por la Data API de Supabase.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Mantiene updated_at al día.
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Anon no debe tocar nada en public: todo el simulador requiere sesión.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
