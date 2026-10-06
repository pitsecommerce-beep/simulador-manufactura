# catalog_components/

Carpeta local para la ingesta de componentes (sensores, cámaras, grippers, bandas, etc.). Igual que en `catalog/`, **solo se versionan los metadatos JSON** (`manifest_components.json`, `standards/presets.json` y `specs.json`/`source.json` de cada componente). `pnpm catalog:sql` los carga en `components`, `component_specs`, `component_documents` y `object_types`.

```
catalog_components/
├─ standards/presets.json
└─ <categoria>/<id>/
   ├─ specs.json
   ├─ source.json
   ├─ datasheet.pdf
   └─ cad/
```
