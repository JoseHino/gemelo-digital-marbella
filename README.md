# Gemelo Digital de Marbella

**Web:** https://josehino.github.io/gemelo-digital-marbella/

Toda Marbella en 3D con datos oficiales abiertos, más los indicadores de los observatorios municipales.

## Qué incluye
- **Edificios 3D** de todo el municipio (Catastro, INSPIRE): unos 19.700 edificios y 97.000 cuerpos, con altura a partir del nº de plantas (3 m por planta), sobre relieve del terreno y ortofoto PNOA.
- **Colorear por**: uso, año de construcción, altura, nº de viviendas, % de viviendas turísticas (VUT) y calificación energética.
- **Ficha de cada edificio** (clic): uso, año, plantas, viviendas, superficie, VUT, certificado energético, foto de fachada del Catastro y enlaces.
- **Capas**: mapa de calor de VUT y Ruta Accesible del casco antiguo.
- **Indicadores de los observatorios**: VUT, Turístico, Dashboard DTI, Tráfico, Ambiental y Residuos, con enlace a cada uno.

## Actualización (todo en GitHub Actions)
| Qué | Cuándo | Cómo |
|---|---|---|
| VUT por edificio y mapa de calor | Siempre al día | La web lee en vivo los datos del [mapa de VUT](https://josehino.github.io/mapa-vut-marbella/), que se actualiza cada día |
| Indicadores y capas de observatorios | Cada día, 07:45 | `observatorios.yml` → `scripts/sincronizar_observatorios.py` (si una fuente falla, conserva su último dato) |
| Base 3D de edificios | A mano, ~1 vez al año | **Actions → Base 3D (Catastro) → Run workflow**: descarga el Catastro de Marbella y genera `data/edificios.pmtiles` con tippecanoe |
| Certificados energéticos | A mano, ~1 vez al año | `data/cee_parcela.json`, a partir del registro andaluz de certificados energéticos |

## Archivos
- `index.html`, `app.js`: la web (MapLibre GL + PMTiles).
- `data/edificios.pmtiles`: teselas vectoriales de los edificios. `data/resumen_base.json`: totales de la base.
- `data/observatorios.json`, `data/capas/`: indicadores y capas sincronizadas.
- `scripts/construir_base.py`, `scripts/sincronizar_observatorios.py`.
