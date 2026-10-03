"""
Base 3D del Gemelo Digital de Marbella: edificios del Catastro (INSPIRE).

Descarga el conjunto de edificios de Marbella (municipio catastral 29069) del servicio
ATOM del Catastro, une cada cuerpo de edificio (BuildingPart, con su nº de plantas) con
los atributos de su edificio (uso, año, viviendas, superficie) y con la calificación
energética de la parcela, y escribe build/edificios.geojsonseq (EPSG:4326) para
convertirlo en teselas vectoriales con tippecanoe (ver .github/workflows/base3d.yml).

Además calcula, por parcela:
  - potencial fotovoltaico de cubierta: superficie en planta × fracción aprovechable × kWp/m², con la
    producción por kWp de PVGIS (JRC) para Marbella, y % del consumo eléctrico de sus viviendas que cubriría;
  - distancia al monte (data/capas/monte.geojson, de scripts/construir_monte.py), hasta 400 m.
Y el nº de edificios y viviendas por año de construcción, para la animación del crecimiento urbano.

Los edificios cambian poco: se ejecuta a mano, p. ej. una vez al año.
"""

import io, json, os, sys, urllib.request, zipfile
import geopandas as gpd
import pyogrio
from shapely.geometry import mapping, shape

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(BASE, "build", "catastro")
OUT = os.path.join(BASE, "build", "edificios.geojsonseq")
URL = "https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/29/29069-MARBELLA/A.ES.SDGC.BU.29069.zip"
H_PLANTA = 3.0   # altura media de planta (m)
# Supuestos del potencial solar (orientativos, de primer orden)
FRACCION_UTIL = 0.5      # parte de la cubierta aprovechable (castilletes, sombras, retranqueos, instalaciones)
KWP_M2 = 0.2             # potencia por m² de módulo (módulos de ~400 W y ~2 m²)
CONSUMO_VIV = 3500       # kWh/año de electricidad de una vivienda media
DIST_MAX = 400           # m; zona de influencia forestal (Ley 5/1999 de Andalucía)

USOS = {"1_residential": "residencial", "2_agriculture": "agrario", "3_industrial": "industrial",
        "4_1_office": "oficinas", "4_2_retail": "comercial", "4_3_publicServices": "servicios públicos"}

os.makedirs(TMP, exist_ok=True)
gml_bu = os.path.join(TMP, "A.ES.SDGC.BU.29069.building.gml")
gml_bp = os.path.join(TMP, "A.ES.SDGC.BU.29069.buildingpart.gml")
if not (os.path.exists(gml_bu) and os.path.exists(gml_bp)):
    print("Descargando edificios del Catastro (ATOM INSPIRE)...", flush=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req, timeout=600).read())).extractall(TMP)

edif = pyogrio.read_dataframe(gml_bu, columns=["localId", "beginning", "currentUse", "numberOfDwellings",
                                               "numberOfBuildingUnits", "value"], read_geometry=False)
edif = edif.set_index("localId")
partes = pyogrio.read_dataframe(gml_bp, columns=["localId", "numberOfFloorsAboveGround", "numberOfFloorsBelowGround"])
print(f"Edificios: {len(edif)} | cuerpos: {len(partes)}", flush=True)

partes = partes[partes["numberOfFloorsAboveGround"].fillna(0).astype(int) > 0].copy()
# une los cuerpos contiguos de un mismo edificio con igual nº de plantas (el Catastro los trocea mucho)
partes["rc"] = partes["localId"].str.split("_").str[0]
partes["numberOfFloorsAboveGround"] = partes["numberOfFloorsAboveGround"].astype(int)
partes = partes.dissolve(by=["rc", "numberOfFloorsAboveGround"], as_index=False).explode(index_parts=False)
partes["geometry"] = partes.geometry.simplify(0.2)          # 20 cm
assert partes.crs.is_projected, partes.crs

# --- potencial solar por parcela (la cubierta es la huella en planta de todos sus cuerpos)
try:
    r = json.load(urllib.request.urlopen("https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?lat=36.51&lon=-4.89&peakpower=1"
                                         "&loss=14&angle=10&aspect=0&outputformat=json", timeout=60))
    PROD_KWP = round(r["outputs"]["totals"]["fixed"]["E_y"])
except Exception as e:
    print("PVGIS no responde, uso el último valor conocido:", e, flush=True)
    PROD_KWP = 1572
print(f"Producción fotovoltaica (PVGIS, módulos a 10°): {PROD_KWP} kWh/kWp·año", flush=True)
tejado = partes.geometry.area.groupby(partes["rc"]).sum()

# --- distancia al monte por parcela (la del cuerpo más cercano)
monte = gpd.read_file(os.path.join(BASE, "data", "capas", "monte.geojson")).to_crs(partes.crs).explode(index_parts=False)
cerca = gpd.sjoin_nearest(partes[["rc", "geometry"]], monte[["geometry"]], max_distance=DIST_MAX, distance_col="d")
dist_monte = cerca.groupby("rc")["d"].min()
print(f"Parcelas a menos de {DIST_MAX} m del monte: {len(dist_monte)}", flush=True)

partes = partes.to_crs(4326)
cee = json.load(open(os.path.join(BASE, "data", "cee_parcela.json"), encoding="utf8"))


def entero(v):
    try:
        f = float(v)
        return None if f != f else int(f)          # NaN -> None
    except (TypeError, ValueError):
        return None


def texto(v):
    return v if isinstance(v, str) else ""


n = 0
with open(OUT, "w", encoding="utf8") as f:
    for rc, plantas, geom in zip(partes["rc"], partes["numberOfFloorsAboveGround"], partes.geometry):
        p = {"rc": rc, "pl": int(plantas), "h": round(int(plantas) * H_PLANTA, 1)}
        if rc in edif.index:
            e = edif.loc[rc]
            anio = texto(e["beginning"])[:4]
            uso = texto(e["currentUse"])
            p.update({"uso": USOS.get(uso, uso),
                      "anio": int(anio) if anio.isdigit() else None,
                      "viv": entero(e["numberOfDwellings"]), "ud": entero(e["numberOfBuildingUnits"]),
                      "sup": entero(e["value"])})
        if rc in cee:
            p["cee"] = cee[rc][0]
        kwp = tejado.get(rc, 0) * FRACCION_UTIL * KWP_M2
        if kwp >= 1:
            p["kwp"] = round(kwp, 1)
            if p.get("viv"):
                p["cob"] = min(999, round(kwp * PROD_KWP / (p["viv"] * CONSUMO_VIV) * 100))
        if rc in dist_monte.index:
            p["dm"] = int(round(dist_monte[rc]))
        g = mapping(geom)
        # coordenadas a 6 decimales (~10 cm)
        def red(c):
            return [red(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], 6), round(c[1], 6)]
        g = {"type": g["type"], "coordinates": red(g["coordinates"])}
        f.write(json.dumps({"type": "Feature", "properties": {k: v for k, v in p.items() if v not in (None, "")},
                            "geometry": g}, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        n += 1
print(f"Cuerpos con plantas sobre rasante: {n} -> {OUT} ({os.path.getsize(OUT) / 1e6:.0f} MB)")
import datetime
# edificios y viviendas por año de construcción (crecimiento urbano)
anios = edif["beginning"].apply(lambda v: texto(v)[:4]).where(lambda a: a.str.isdigit(), None).dropna().astype(int)
anios = anios[(anios >= 1800) & (anios <= datetime.date.today().year)]
viv = edif.loc[anios.index, "numberOfDwellings"].apply(entero).fillna(0)
por_anio = {int(a): [int((anios == a).sum()), int(viv[anios == a].sum())] for a in sorted(anios.unique())}

# totales del potencial solar y de la exposición al monte (por parcela)
kwp_rc = tejado * FRACCION_UTIL * KWP_M2
viv_rc = edif["numberOfDwellings"].apply(entero).fillna(0)
cerca_100 = dist_monte[dist_monte <= 100].index
cerca_400 = dist_monte.index
resumen = {"edificios": int(len(edif)), "cuerpos": n,
           "viviendas": int(viv_rc.sum()),
           "edificios_con_cee": len(set(edif.index) & set(cee)),
           "fecha_catastro": datetime.date.today().isoformat(),
           "por_anio": por_anio, "edificios_sin_anio": int(len(edif) - len(anios)),
           "solar": {"prod_kwp": PROD_KWP, "fraccion_util": FRACCION_UTIL, "kwp_m2": KWP_M2, "consumo_viv": CONSUMO_VIV,
                     "kwp_total": round(float(kwp_rc[kwp_rc >= 1].sum())),
                     "gwh_total": round(float(kwp_rc[kwp_rc >= 1].sum()) * PROD_KWP / 1e6, 1),
                     "consumo_viviendas_gwh": round(float(viv_rc.sum()) * CONSUMO_VIV / 1e6, 1)},
           "monte": {"edificios_100": int(len(cerca_100)), "viviendas_100": int(viv_rc.reindex(cerca_100).fillna(0).sum()),
                     "edificios_400": int(len(cerca_400)), "viviendas_400": int(viv_rc.reindex(cerca_400).fillna(0).sum())}}
json.dump(resumen, open(os.path.join(BASE, "data", "resumen_base.json"), "w"), indent=1)
print(resumen)
if n < 30000:
    sys.exit("Muy pocos edificios: algo ha fallado en la descarga")
