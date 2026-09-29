-- Buckets de Storage, todos privados.
-- No se crean políticas sobre storage.objects para estos buckets: sin política no hay
-- acceso de cliente. La API emite URLs firmadas de corta duración (service_role) solo
-- para catalog-derived y sim-artifacts. catalog-originals no tiene ruta de descarga.
--
-- Límite por archivo: 50 MB (máximo del plan Free de Supabase). Los STEP se suben
-- comprimidos con gzip por el script de ingesta.

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('catalog-originals', 'catalog-originals', false, 52428800),
  ('catalog-derived', 'catalog-derived', false, 52428800),
  ('sim-artifacts', 'sim-artifacts', false, 52428800)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;
