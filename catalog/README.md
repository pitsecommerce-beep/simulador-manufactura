# catalog/

Carpeta local para la ingesta del catálogo de robots. **Su contenido no se versiona**: `.gitignore` y el chequeo `tools/check-no-cad` impiden subir CAD, fichas PDF o planos de fabricantes al repositorio.

Estructura esperada (el script de ingesta llega en la fase 2):

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
