"""
Focos activos de incendio de los últimos 7 días alrededor de Marbella (NASA FIRMS, sin clave).

Junta los ficheros públicos de Europa de los satélites VIIRS (Suomi NPP, NOAA-20, NOAA-21) y MODIS,
se queda con los de la caja de la Costa del Sol occidental y su serranía y escribe
data/capas/focos.geojson. Lo lanza .github/workflows/incendios.yml cada pocas horas.
Un foco es una anomalía térmica: puede ser un incendio, una quema agrícola o una industria.
"""

import csv, io, json, os, urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(BASE, "data", "capas", "focos.geojson")
CAJA = (-5.60, 36.20, -4.30, 36.95)     # oeste, sur, este, norte
URL = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/"
FICHEROS = {"VIIRS Suomi NPP": "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_7d.csv",
            "VIIRS NOAA-20": "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv",
            "VIIRS NOAA-21": "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_7d.csv",
            "MODIS": "modis-c6.1/csv/MODIS_C6_1_Europe_7d.csv"}
CONFIANZA = {"l": "baja", "low": "baja", "n": "nominal", "nominal": "nominal", "h": "alta", "high": "alta"}

rasgos, fallos = [], []
for sat, ruta in FICHEROS.items():
    try:
        txt = urllib.request.urlopen(urllib.request.Request(URL + ruta, headers={"User-Agent": "gemelo-digital-marbella"}),
                                     timeout=120).read().decode()
    except Exception as e:
        fallos.append(sat); print(f"{sat}: {e}"); continue
    n = 0
    for f in csv.DictReader(io.StringIO(txt)):
        lon, lat = float(f["longitude"]), float(f["latitude"])
        if not (CAJA[0] <= lon <= CAJA[2] and CAJA[1] <= lat <= CAJA[3]):
            continue
        c = str(f.get("confidence", "")).lower()
        conf = CONFIANZA.get(c) or ("alta" if c.isdigit() and int(c) >= 80 else "baja" if c.isdigit() and int(c) < 30 else "nominal")
        hora = f["acq_time"].zfill(4)
        rasgos.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
                       "properties": {"fecha": f"{f['acq_date']}T{hora[:2]}:{hora[2:]}Z", "satelite": sat, "confianza": conf,
                                      "frp": float(f["frp"]) if f.get("frp") else None, "dia": f.get("daynight") == "D"}})
        n += 1
    print(f"{sat}: {n} focos en la zona")

if len(fallos) == len(FICHEROS) and os.path.exists(SALIDA):
    raise SystemExit("FIRMS no responde: se conserva el último fichero")
rasgos.sort(key=lambda r: r["properties"]["fecha"], reverse=True)
json.dump({"type": "FeatureCollection", "actualizado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "fallos": fallos, "features": rasgos}, open(SALIDA, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(rasgos)} focos -> {SALIDA}")
