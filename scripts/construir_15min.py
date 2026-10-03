"""
Ciudad de 15 minutos: tiempo a pie desde cada edificio hasta el servicio más cercano de cada tipo.

- Red peatonal y servicios: OpenStreetMap (Overpass).
- Pendiente: cota de cada nodo leída de data/relieve.pmtiles (z14); velocidad con la función de Tobler
  (5 km/h en llano, más lenta cuesta arriba y en bajadas fuertes). El tiempo es el del edificio AL servicio.
- Edificios: centro de cada parcela del Catastro (build/catastro, el mismo GML que construir_base.py).
Escribe data/quince_parcela.json {rc: [min_salud, min_farmacia, min_colegio, min_super, min_bus, min_parque, min_playa]}
(minutos enteros; null si más de 60) y data/quince_resumen.json. construir_base.py lo mete en las teselas.
Depende de Overpass, que a veces falla: se ejecuta a mano (~1 vez al año), como construir_monte.py.
"""

import io, json, math, os, sys, time, urllib.parse, urllib.request, zipfile
import numpy as np
import pyogrio
from pyproj import Transformer
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree
from PIL import Image

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(BASE, "build", "catastro")
URL_CAT = "https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/29/29069-MARBELLA/A.ES.SDGC.BU.29069.zip"
BBOX = (36.44, -5.08, 36.60, -4.72)       # sur, oeste, norte, este: el término municipal con margen
SERVIDORES = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
MAX_MIN = 60
SNAP_MAX = 250                              # m; un servicio a más distancia de la red no se enlaza

# tipos de servicio: (clave, nombre, consulta Overpass dentro de la caja)
TIPOS = [
    ("salud", "Centro de salud u hospital", 'nwr["amenity"~"^(hospital|clinic|doctors)$"]{b};nwr["healthcare"~"^(hospital|clinic|centre|doctor)$"]{b};'),
    ("farmacia", "Farmacia", 'nwr["amenity"="pharmacy"]{b};'),
    ("colegio", "Colegio o escuela infantil", 'nwr["amenity"~"^(school|kindergarten)$"]{b};'),
    ("super", "Supermercado o tienda de alimentación", 'nwr["shop"~"^(supermarket|convenience|greengrocer|grocery|bakery|butcher)$"]{b};'),
    ("bus", "Parada de autobús", 'nwr["highway"="bus_stop"]{b};nwr["public_transport"="platform"]["bus"="yes"]{b};'),
    ("parque", "Parque o zona verde", 'nwr["leisure"~"^(park|playground|garden)$"]["access"!~"private"]{b};'),
    ("playa", "Playa", 'nwr["natural"="beach"]{b};'),
]

a_utm = Transformer.from_crs(4326, 25830, always_xy=True).transform


def overpass(q):
    datos = urllib.parse.urlencode({"data": q}).encode()
    for intento in range(4):
        for url in SERVIDORES:
            try:
                req = urllib.request.Request(url, data=datos, headers={"User-Agent": "gemelo-digital-marbella"})
                return json.load(urllib.request.urlopen(req, timeout=300))["elements"]
            except Exception as e:
                print(f"Overpass {url}: {e}", flush=True)
        time.sleep(30 * (intento + 1))
    sys.exit("Overpass no responde")


# ------------------------------------------------------------------ cota (relieve del gemelo, z14 terrarium)
from pmtiles.reader import Reader, MmapSource
_f = open(os.path.join(BASE, "data", "relieve.pmtiles"), "rb")
_rel = Reader(MmapSource(_f))
_cache = {}


def cota(lon, lat, z=14):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    k = (int(x), int(y))
    if k not in _cache:
        t = _rel.get(z, *k)
        _cache[k] = None if t is None else np.asarray(Image.open(io.BytesIO(t)).convert("RGB"), dtype=np.float64)
    a = _cache[k]
    if a is None:
        return 0.0
    s = a.shape[0]
    px, py = min(s - 1, int((x % 1) * s)), min(s - 1, int((y % 1) * s))
    r, g, b = a[py, px]
    return r * 256 + g + b / 256 - 32768


# ------------------------------------------------------------------ red peatonal
print("Descargando la red peatonal (OSM)...", flush=True)
caja = ",".join(map(str, BBOX))
vias = overpass(f'[out:json][timeout:300];way["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|raceway)$"]'
                f'["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"]({caja});out geom;')
idx, coords, aristas = {}, [], []
for w in vias:
    geo, nds = w.get("geometry"), w.get("nodes")
    if not geo or not nds:
        continue
    ids = []
    for nid, p in zip(nds, geo):
        if nid not in idx:
            idx[nid] = len(coords); coords.append((p["lon"], p["lat"]))
        ids.append(idx[nid])
    aristas += list(zip(ids[:-1], ids[1:]))
coords = np.array(coords)
xy = np.column_stack(a_utm(coords[:, 0], coords[:, 1]))
z = np.array([cota(lo, la) for lo, la in coords])
print(f"Red: {len(coords)} nodos, {len(aristas)} tramos", flush=True)

# tiempo de cada tramo en los dos sentidos (Tobler: v = 6·e^(-3,5·|pendiente + 0,05|) km/h)
a = np.array(aristas)
d = np.hypot(*(xy[a[:, 1]] - xy[a[:, 0]]).T)
d = np.maximum(d, 0.5)
dz = z[a[:, 1]] - z[a[:, 0]]
pend = np.clip(dz / np.maximum(d, 15), -0.5, 0.5)       # pendiente suavizada en tramos muy cortos


def minutos(p):
    return d / (6000 * np.exp(-3.5 * np.abs(p + 0.05)) / 60)


fil = np.concatenate([a[:, 0], a[:, 1]])
col = np.concatenate([a[:, 1], a[:, 0]])
t = np.concatenate([minutos(pend), minutos(-pend)])
G = csr_matrix((t, (fil, col)), shape=(len(coords),) * 2)
GT = G.T.tocsr()                                         # para ir del servicio hacia atrás: tiempos edificio -> servicio
arbol = cKDTree(xy)

# ------------------------------------------------------------------ edificios (centro de cada parcela)
gml_bp = os.path.join(TMP, "A.ES.SDGC.BU.29069.buildingpart.gml")
if not os.path.exists(gml_bp):
    os.makedirs(TMP, exist_ok=True)
    req = urllib.request.Request(URL_CAT, headers={"User-Agent": "Mozilla/5.0"})
    zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req, timeout=600).read())).extractall(TMP)
partes = pyogrio.read_dataframe(gml_bp, columns=["localId", "numberOfFloorsAboveGround"])
partes = partes[partes["numberOfFloorsAboveGround"].fillna(0).astype(int) > 0]
partes["rc"] = partes["localId"].str.split("_").str[0]
centros = partes.dissolve(by="rc").geometry.centroid
assert partes.crs.is_projected
bxy = np.column_stack([centros.x, centros.y])
bdist, bnodo = arbol.query(bxy)
print(f"Parcelas: {len(bxy)}", flush=True)

# ------------------------------------------------------------------ servicios y tiempos
resultado = np.full((len(bxy), len(TIPOS)), np.nan)
resumen = {"tipos": [[k, n] for k, n, _ in TIPOS], "servicios": {}}
for j, (clave, nombre, q) in enumerate(TIPOS):
    els = overpass(f"[out:json][timeout:180];({q.replace('{b}', '(' + caja + ')')});out geom;")
    pts = []
    for e in els:
        if e["type"] == "node":
            pts.append((e["lon"], e["lat"]))
        elif "geometry" in e:                            # vías: sus vértices (cuenta el borde del parque o de la playa)
            g = e["geometry"]
            pts += [(p["lon"], p["lat"]) for p in g[:: max(1, len(g) // 40)]]
        elif "members" in e:
            for m in e["members"]:
                pts += [(p["lon"], p["lat"]) for p in (m.get("geometry") or [])[::10]]
    if not pts:
        print(f"{nombre}: sin datos"); continue
    pts = np.array(pts)
    pxy = np.column_stack(a_utm(pts[:, 0], pts[:, 1]))
    sd, sn = arbol.query(pxy)
    ok = sd <= SNAP_MAX
    # dijkstra multiorigen: un nodo ficticio unido a todos los servicios con su coste de acceso
    fuentes = np.unique(sn[ok])
    tt = dijkstra(GT, directed=True, indices=fuentes, min_only=True, limit=MAX_MIN)
    m = tt[bnodo] + bdist / 80                           # + llegar del edificio a la red (a 4,8 km/h)
    resultado[:, j] = np.where(m <= MAX_MIN, m, np.nan)
    resumen["servicios"][clave] = int(len(els))
    print(f"{nombre}: {len(els)} en OSM, {int(ok.sum())} puntos enlazados; mediana {np.nanmedian(resultado[:, j]):.1f} min", flush=True)

salida = {}
for rc, fila in zip(centros.index, resultado):
    salida[rc] = [None if np.isnan(v) else int(round(v)) for v in fila]
json.dump(salida, open(os.path.join(BASE, "data", "quince_parcela.json"), "w"), separators=(",", ":"))
quince = np.sum(resultado <= 15, axis=1)
resumen["parcelas"] = len(bxy)
resumen["por_n_servicios"] = {int(k): int((quince == k).sum()) for k in range(len(TIPOS) + 1)}
json.dump(resumen, open(os.path.join(BASE, "data", "quince_resumen.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
print("Parcelas por nº de servicios a 15 min o menos:", resumen["por_n_servicios"])
