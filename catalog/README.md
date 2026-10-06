# catalog/

Catálogo de robots. **Solo se versionan los metadatos JSON** (`manifest.json` y, por robot, `specs.json` y `source.json`): cifras de ficha, URLs públicas, hashes y términos de uso. `.gitignore` y `tools/check-no-cad` impiden subir CAD, fichas PDF, zips o planos de fabricantes al repositorio.

`pnpm catalog:sql` convierte estos JSON en `supabase/manual/seed_catalog.sql` (ver README principal).

Estructura:

```
catalog/
├─ manifest.json
└─ <robot_id>/
   ├─ specs.json      datos de ficha técnica (lo no publicado va como null)
   ├─ source.json     URL de origen, fecha de descarga y términos de uso de cada archivo
   ├─ datasheet.pdf
   ├─ cad/            STEP de cada variante
   └─ drawings/
```

Los archivos se descargan manualmente desde el portal de ABB, aceptando sus términos. La ingesta los sube al bucket privado `catalog-originals` de Supabase y registra fuente y términos de uso en la base de datos.
