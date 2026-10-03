# Gemelo Digital de Marbella

**Web:** https://josehino.github.io/gemelo-digital-marbella/

Toda Marbella en 3D con datos oficiales abiertos, más los indicadores de los observatorios municipales.

## Qué incluye
- **Edificios 3D** de todo el municipio (Catastro, INSPIRE): unos 19.700 edificios y 97.000 cuerpos, con altura a partir del nº de plantas (3 m por planta), sobre relieve del terreno y ortofoto PNOA.
- **Colorear por**: uso, año de construcción, altura, nº de viviendas, % de viviendas turísticas (VUT) y calificación energética.
- **Ficha de cada edificio** (clic): uso, año, plantas, viviendas, superficie, VUT, certificado energético, foto de fachada del Catastro y enlaces.
- **Fondo marino**: relieve continuo tierra-mar (el mar deja de ser plano), fondo coloreado por profundidad, isóbatas (10–800 m), profundidad al pulsar en el mar y opción de exagerar el relieve ×3.
- **Capas**: mapa de calor de VUT y Ruta Accesible del casco antiguo.
- **Ahora en Marbella** (en vivo, cada 15 min, desde el navegador): temperatura, viento (levante/poniente), oleaje, temperatura del agua, calidad del aire e índice UV, de [Open-Meteo](https://open-meteo.com/) (sin clave).
- **Histórico y cruce de datos** (`historico.js`): al pulsar un dato del panel se abre su serie de 7 días, 30 días, 1 año o 3 años (17 variables de tiempo, mar y aire; ERA5, Copernicus Marine y CAMS a través de Open-Meteo). Se puede cruzar con otra variable: gráficos con el eje de tiempo compartido, dispersión con la correlación de Pearson o, si una es una dirección, la media por rumbo (levante/poniente); con desfase de días, opción de quitar la estacionalidad y descarga en CSV.
- **Evolución urbana**: deslizador y animación de 1900 a hoy que muestra los edificios construidos hasta cada año (año del Catastro), con la foto aérea de la época del IGN (vuelo americano de 1956, interministerial, nacional, SIGPAC y PNOA 2004-2024) y la gráfica de viviendas por año.
- **Potencial solar de cubierta** (modo de color y ficha): kWp instalables y % del consumo de las viviendas que cubrirían, con la producción de PVGIS para Marbella; señala los edificios con certificado E/F/G y buen potencial.
- **Riesgo de incendio forestal**: peligro diario de EFFIS (también como tarjeta en vivo), focos de calor de NASA FIRMS de los últimos 7 días, monte de OpenStreetMap con franjas de 100 y 400 m, y modo de color por distancia al monte.
- **Embalse de La Concepción** en el panel en vivo y en el histórico (reserva y lluvia en la presa), leído del [observatorio hídrico](https://josehino.github.io/observatorio-hidrico-concepcion/).
- **Simulación de subida del nivel del mar**: deslizador de 0 a 5 m y escenarios de 2100 (IPCC AR6), con el agua sobre el relieve y el recuento de edificios, viviendas y VUT afectados en la vista. Modelo de "bañera" calculado en el navegador a partir de `data/relieve.pmtiles` (protocolo `inunda://` en `app.js`): orientativo, no delimita zonas de riesgo.
- **Indicadores de los observatorios**: VUT, Turístico, Dashboard DTI, Tráfico, Ambiental y Residuos, con enlace a cada uno.

## Actualización (todo en GitHub Actions)
| Qué | Cuándo | Cómo |
|---|---|---|
| VUT por edificio y mapa de calor | Siempre al día | La web lee en vivo los datos del [mapa de VUT](https://josehino.github.io/mapa-vut-marbella/), que se actualiza cada día |
| Indicadores y capas de observatorios | Cada día, 07:45 | `observatorios.yml` → `scripts/sincronizar_observatorios.py` (si una fuente falla, conserva su último dato) |
| Base 3D de edificios | A mano, ~1 vez al año | **Actions → Base 3D (Catastro) → Run workflow**: descarga el Catastro de Marbella y genera `data/edificios.pmtiles` con tippecanoe |
| Batimetría y relieve tierra-mar | A mano, cuando EMODnet publique versión nueva | **Actions → Batimetría y relieve tierra-mar → Run workflow**: EMODnet (WCS) + Terrain Tiles → `data/relieve.pmtiles`, `data/batimetria.pmtiles`, `data/capas/isobatas.geojson`. **Ahora se genera en local**: usa el MBAR24 del IHM (16 m) de `fuentes/IHM/`, que no se sube al repositorio porque su licencia no permite redistribuirlo; el workflow se niega a sobrescribirlo salvo con `SOLO_EMODNET=1` |
| Focos de incendio | Cada 3 horas | `incendios.yml` → `scripts/focos_incendio.py` (ficheros públicos de NASA FIRMS, sin clave) → `data/capas/focos.geojson` |
| Monte y franjas de 100/400 m | A mano, ~1 vez al año, antes de la base 3D | `python scripts/construir_monte.py` (OpenStreetMap) → `data/capas/monte.geojson`, `franjas_monte.geojson`; la base 3D calcula con ellos la distancia de cada edificio al monte |
| Certificados energéticos | A mano, ~1 vez al año | `data/cee_parcela.json`, a partir del registro andaluz de certificados energéticos |

## Archivos
- `index.html`, `app.js`: la web (MapLibre GL + PMTiles).
- `data/edificios.pmtiles`: teselas vectoriales de los edificios. `data/resumen_base.json`: totales de la base.
- `data/observatorios.json`, `data/capas/`: indicadores y capas sincronizadas.
- `data/relieve.pmtiles` (terreno, codificación terrarium), `data/batimetria.pmtiles` (fondo coloreado), `data/capas/isobatas.geojson`.
- `scripts/construir_base.py`, `scripts/construir_batimetria.py`, `scripts/sincronizar_observatorios.py`.
