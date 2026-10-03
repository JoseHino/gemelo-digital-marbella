"""
Avisos meteorológicos (AEMET a través de Meteoalarm) e incidencias de tráfico de la DGT en Marbella.

- Avisos: feed Atom público de Meteoalarm para España; se quedan los de las zonas de Málaga
  (Marbella está en "Sol y Guadalhorce") que no hayan caducado -> data/avisos.json
- Tráfico: publicación DATEX II de situaciones de la DGT (Punto de Acceso Nacional); se quedan las
  que tienen algún punto en la caja de Marbella -> data/capas/trafico.geojson
Ninguna de las dos fuentes admite CORS, por eso se descargan aquí. Lo lanza .github/workflows/avisos.yml.
"""

import json, os, re, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "gemelo-digital-marbella"}
ZONAS = re.compile(r"Sol y Guadalhorce|M[aá]laga|Serran[ií]a de Ronda", re.I)
CAJA = (-5.08, 36.44, -4.72, 36.62)
ahora = datetime.now(timezone.utc)


def baja(url, t=120):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=t).read()


# ------------------------------------------------------------------ avisos (Meteoalarm)
NIVEL = {"yellow": "amarillo", "orange": "naranja", "red": "rojo", "green": "verde"}
FENOMENO = {"wind": "viento", "rain": "lluvia", "thunderstorm": "tormentas", "high-temperature": "temperaturas máximas",
            "high temperature": "temperaturas máximas", "low-temperature": "temperaturas mínimas", "low temperature": "temperaturas mínimas",
            "snow": "nieve", "fog": "niebla", "coastalevent": "fenómenos costeros", "coastal event": "fenómenos costeros",
            "forest-fire": "incendios forestales", "forest fire": "incendios forestales", "avalanches": "aludes", "rain-flood": "inundaciones",
            "flooding": "inundaciones", "dust": "polvo en suspensión"}
avisos, fallos = [], []
try:
    ns = {"a": "http://www.w3.org/2005/Atom", "cap": "urn:oasis:names:tc:emergency:cap:1.2"}
    raiz = ET.fromstring(baja("https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain"))
    for e in raiz.findall("a:entry", ns):
        area = e.findtext("cap:areaDesc", "", ns)
        if not ZONAS.search(area):
            continue
        fin = e.findtext("cap:expires", "", ns)
        if fin and datetime.fromisoformat(fin) < ahora:
            continue
        titulo = e.findtext("a:title", "", ns)
        m = re.match(r"(\w+)\s+(.+?)\s+Warning", titulo)
        nivel = NIVEL.get(m.group(1).lower(), m.group(1)) if m else ""
        fen = m.group(2).lower() if m else e.findtext("cap:event", "", ns)
        if nivel == "verde":
            continue
        avisos.append({"zona": area, "nivel": nivel, "fenomeno": FENOMENO.get(fen, fen),
                       "inicio": e.findtext("cap:onset", "", ns), "fin": fin})
except Exception as err:
    fallos.append("meteoalarm"); print("Meteoalarm:", err)

# ------------------------------------------------------------------ tráfico (DGT, DATEX II)
TIPO = {"Accident": "Accidente", "AbnormalTraffic": "Retención", "MaintenanceWorks": "Obras", "ConstructionWorks": "Obras",
        "RoadOrCarriagewayOrLaneManagement": "Corte o restricción", "EnvironmentalObstruction": "Obstáculo en la vía",
        "GeneralObstruction": "Obstáculo en la vía", "VehicleObstruction": "Vehículo detenido", "AnimalPresenceObstruction": "Animales en la vía",
        "PoorEnvironmentConditions": "Meteorología adversa", "WeatherRelatedRoadConditions": "Estado de la vía", "PublicEvent": "Evento",
        "DisturbanceActivity": "Incidencia", "SpeedManagement": "Limitación de velocidad", "NonWeatherRelatedRoadConditions": "Estado de la vía"}
GRAVEDAD = {"lowest": 1, "low": 1, "medium": 2, "high": 3, "highest": 3}
rasgos = []
try:
    xml = baja("https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v37.xml", 180).decode("utf8")
    for r in re.findall(r"<sit:situationRecord .*?</sit:situationRecord>", xml, re.S):
        pts = [(float(lo), float(la)) for la, lo in re.findall(r"<loc:latitude>([-\d.]+)</loc:latitude>\s*<loc:longitude>([-\d.]+)</loc:longitude>", r)]
        if not any(CAJA[0] <= x <= CAJA[2] and CAJA[1] <= y <= CAJA[3] for x, y in pts):
            continue
        if re.search(r"<com:validityStatus>(suspended|planned)</com:validityStatus>", r):
            continue
        tipo = re.search(r'xsi:type="sit:(\w+)"', r).group(1)
        txt = lambda pat: (re.search(pat, r) or [None, None])[1]
        causa = txt(r"<sit:causeType>(\w+)</sit:causeType>")
        km = re.findall(r"<lse:kilometerPoint>([\d.]+)</lse:kilometerPoint>", r)
        geom = {"type": "LineString", "coordinates": [list(p) for p in pts[:2]]} if len(pts) >= 2 and pts[0] != pts[1] \
            else {"type": "Point", "coordinates": list(pts[0])}
        rasgos.append({"type": "Feature", "geometry": geom, "properties": {
            "tipo": TIPO.get(tipo, TIPO.get((causa or "")[:1].upper() + (causa or "")[1:], "Incidencia")),
            "via": txt(r"<loc:roadName>([^<]+)</loc:roadName>"), "km": " – ".join(sorted(set(km), key=float)) or None,
            "municipio": txt(r"<lse:municipality>([^<]+)</lse:municipality>"),
            "gravedad": GRAVEDAD.get(txt(r"<sit:severity>(\w+)</sit:severity>"), 1),
            "desde": txt(r"<com:overallStartTime>([^<]+)</com:overallStartTime>")}})
    # el punto de cada incidencia, para el símbolo
    for f in list(rasgos):
        if f["geometry"]["type"] == "LineString":
            c = f["geometry"]["coordinates"]
            rasgos.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2]},
                           "properties": dict(f["properties"], punto=True)})
        else:
            f["properties"]["punto"] = True
except Exception as err:
    fallos.append("dgt"); print("DGT:", err)

marca = ahora.strftime("%Y-%m-%dT%H:%MZ")
if "meteoalarm" not in fallos:
    json.dump({"actualizado": marca, "avisos": avisos}, open(os.path.join(BASE, "data", "avisos.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
if "dgt" not in fallos:
    json.dump({"type": "FeatureCollection", "actualizado": marca, "features": rasgos},
              open(os.path.join(BASE, "data", "capas", "trafico.geojson"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
print(f"Avisos en Málaga: {len(avisos)} | incidencias de tráfico en Marbella: {sum(1 for f in rasgos if f['properties'].get('punto'))} | fallos: {fallos}")
