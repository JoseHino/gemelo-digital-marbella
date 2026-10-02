"""
Base 3D del Gemelo Digital de Marbella: edificios del Catastro (INSPIRE).

Descarga el conjunto de edificios de Marbella (municipio catastral 29069) del servicio
ATOM del Catastro, une cada cuerpo de edificio (BuildingPart, con su nº de plantas) con
los atributos de su edificio (uso, año, viviendas, superficie) y con la calificación
energética de la parcela, y escribe build/edificios.geojsonseq (EPSG:4326) para
convertirlo en teselas vectoriales con tippecanoe (ver .github/workflows/base3d.yml).

Los edificios cambian poco: se ejecuta a mano, p. ej. una vez al año.
"""

import io, json, os, sys, urllib.request, zipfile
import pyogrio
from shapely.geometry import mapping

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(BASE, "build", "catastro")
OUT = os.path.join(BASE, "build", "edificios.geojsonseq")
URL = "https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/29/29069-MARBELLA/A.ES.SDGC.BU.29069.zip"
H_PLANTA = 3.0   # altura media de planta (m)

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
resumen = {"edificios": int(len(edif)), "cuerpos": n,
           "viviendas": int(edif["numberOfDwellings"].apply(entero).fillna(0).sum()),
           "edificios_con_cee": len(set(edif.index) & set(cee)),
           "fecha_catastro": datetime.date.today().isoformat()}
json.dump(resumen, open(os.path.join(BASE, "data", "resumen_base.json"), "w"), indent=1)
print(resumen)
if n < 30000:
    sys.exit("Muy pocos edificios: algo ha fallado en la descarga")
