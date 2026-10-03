"""
Monte (vegetación forestal) de Marbella y alrededores y franjas de 100 y 400 m a su alrededor.

Fuente: OpenStreetMap (Overpass): landuse=forest, natural=wood, natural=scrub y natural=heath.
Escribe:
  - data/capas/monte.geojson          polígonos de monte (simplificados a 5 m)
  - data/capas/franjas_monte.geojson  franja de 0-100 m y de 100-400 m alrededor del monte (fuera de él);
                                      400 m es la "zona de influencia forestal" de la Ley 5/1999 de Andalucía
construir_base.py lo usa para calcular la distancia de cada edificio al monte.
Cambia poco: se ejecuta a mano (o desde base3d.yml antes de la base 3D).
"""

import json, os, sys, time, urllib.parse, urllib.request
from shapely.geometry import LineString, Polygon, box, mapping, shape
from shapely.ops import polygonize, transform, unary_union
from pyproj import Transformer

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAPAS = os.path.join(BASE, "data", "capas")
BBOX = (36.40, -5.12, 36.68, -4.70)          # sur, oeste, norte, este (Marbella y sus sierras)
SERVIDORES = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
CONSULTA = f"""[out:json][timeout:180];
(
  way["landuse"="forest"]({','.join(map(str, BBOX))});
  way["natural"~"^(wood|scrub|heath)$"]({','.join(map(str, BBOX))});
  relation["landuse"="forest"]({','.join(map(str, BBOX))});
  relation["natural"~"^(wood|scrub|heath)$"]({','.join(map(str, BBOX))});
);
out geom;"""

a_utm = Transformer.from_crs(4326, 25830, always_xy=True).transform
a_geo = Transformer.from_crs(25830, 4326, always_xy=True).transform


def descarga():
    datos = urllib.parse.urlencode({"data": CONSULTA}).encode()
    for intento in range(4):
        for url in SERVIDORES:
            try:
                req = urllib.request.Request(url, data=datos, headers={"User-Agent": "gemelo-digital-marbella"})
                return json.load(urllib.request.urlopen(req, timeout=240))
            except Exception as e:
                print(f"Overpass {url}: {e}", flush=True)
        time.sleep(20 * (intento + 1))
    sys.exit("No se ha podido descargar el monte de OpenStreetMap")


def poligonos(elementos):
    out = []
    for el in elementos:
        if el["type"] == "way" and len(el.get("geometry", [])) >= 4:
            c = [(p["lon"], p["lat"]) for p in el["geometry"]]
            if c[0] == c[-1]:
                out.append(Polygon(c).buffer(0))
        elif el["type"] == "relation":
            exter, inter = [], []
            for m in el.get("members", []):
                if m["type"] == "way" and len(m.get("geometry", [])) >= 2:
                    (inter if m.get("role") == "inner" else exter).append(LineString([(p["lon"], p["lat"]) for p in m["geometry"]]))
            ext = unary_union(list(polygonize(unary_union(exter)))) if exter else None
            if ext is not None and not ext.is_empty:
                if inter:
                    ext = ext.difference(unary_union(list(polygonize(unary_union(inter)))))
                out.append(ext.buffer(0))
    return [p for p in out if not p.is_empty]


def escribe(nombre, rasgos):
    ruta = os.path.join(CAPAS, nombre)
    json.dump({"type": "FeatureCollection", "features": rasgos}, open(ruta, "w", encoding="utf8"), separators=(",", ":"))
    print(f"{nombre}: {os.path.getsize(ruta) / 1e6:.1f} MB")


def red(g, d=6):
    def r(c):
        return [r(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], d), round(c[1], d)]
    m = mapping(g)
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


if __name__ == "__main__":
    d = descarga()
    polis = poligonos(d["elements"])
    print(f"Polígonos de monte en OSM: {len(polis)}", flush=True)
    recorte = transform(a_utm, box(BBOX[1], BBOX[0], BBOX[3], BBOX[2]))
    monte = unary_union([transform(a_utm, p) for p in polis]).intersection(recorte)
    monte = monte.buffer(0).simplify(5)
    monte = unary_union([g for g in getattr(monte, "geoms", [monte]) if g.area >= 2000])   # fuera manchas < 0,2 ha
    print(f"Superficie de monte: {monte.area / 1e6:.1f} km²", flush=True)
    f100 = monte.buffer(100).difference(monte).simplify(5)
    f400 = monte.buffer(400).difference(monte.buffer(100)).simplify(10)
    escribe("monte.geojson", [{"type": "Feature", "properties": {}, "geometry": red(transform(a_geo, monte), 5)}])
    escribe("franjas_monte.geojson", [
        {"type": "Feature", "properties": {"franja": 100}, "geometry": red(transform(a_geo, f100), 5)},
        {"type": "Feature", "properties": {"franja": 400}, "geometry": red(transform(a_geo, f400), 5)}])
