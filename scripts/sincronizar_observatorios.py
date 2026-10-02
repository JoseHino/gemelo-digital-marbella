"""
Sincroniza el Gemelo Digital con los observatorios municipales publicados.

Lee los datos que ya publica cada observatorio (no repite sus descargas) y escribe:
 - data/observatorios.json: indicadores clave de cada observatorio, con enlace y fecha.
 - data/capas/ruta_accesible.geojson: itinerario y puntos de la Ruta Accesible.
Si un observatorio falla, se conserva su ultimo dato bueno y se marca "ok": false.
"""

import json, os, re, sys, urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "data", "observatorios.json")
CAPAS = os.path.join(BASE, "data", "capas")
os.makedirs(CAPAS, exist_ok=True)
GH = "https://josehino.github.io"
UA = {"User-Agent": "Mozilla/5.0"}


def texto(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read().decode("utf-8", "ignore")


def objeto_js(url, marca):
    s = texto(url)
    i = s.index(marca) + len(marca)
    return json.JSONDecoder().raw_decode(s[i:].lstrip())[0]


def ultimo(years, valores):
    pares = [(y, v) for y, v in zip(years, valores) if v not in (None, 0)]
    return pares[-1] if pares else (None, None)


def kpi(etiqueta, valor, unidad="", periodo="", decimales=0):
    return {"etiqueta": etiqueta, "valor": None if valor is None else round(float(valor), decimales),
            "unidad": unidad, "periodo": str(periodo or "")}


# ---------------------------------------------------------------- lectores
def dti():
    d = objeto_js(f"{GH}/dashboard-dti-marbella/data.js", "=")
    t = d["turismo"]
    out = []
    y, v = ultimo(t["viajeros"]["years"], t["viajeros"]["total"]); out.append(kpi("Viajeros alojados", v, "", y))
    y, v = ultimo(t["pernoctaciones"]["years"], t["pernoctaciones"]["total"]); out.append(kpi("Pernoctaciones", v, "", y))
    y, v = ultimo(t["plazas"]["years"], t["plazas"]["total"]); out.append(kpi("Plazas turísticas", v, "", y))
    y, v = ultimo(d["empleo"]["paro"]["years"], d["empleo"]["paro"]["tasa"]); out.append(kpi("Tasa de paro", v, "%", y, 1))
    y, v = ultimo(d["empleo"]["afiliados"]["years"], d["empleo"]["afiliados"]["total"]); out.append(kpi("Afiliados a la S. Social", v, "", y))
    y, v = ultimo(d["seguridad"]["tasa"]["years"], d["seguridad"]["tasa"]["valor"]); out.append(kpi("Tasa de criminalidad", v, "‰", y, 1))
    y, v = ultimo(d["residuos"]["years"], d["residuos"]["pct_reciclado"]); out.append(kpi("Residuos reciclados", v, "%", y, 1))
    y, v = ultimo(d["deportes"]["years"], d["deportes"]["total"]); out.append(kpi("Eventos deportivos", v, "", y))
    return {"nombre": "Dashboard DTI", "url": f"{GH}/dashboard-dti-marbella/", "kpis": out}


def turismo():
    # datos[tipo de alojamiento][Viajeros|Pernoctaciones][pais] = serie mensual
    d = json.loads(texto(f"{GH}/observatorio-turistico-marbella/data/paises_marbella.json"))
    meses, datos = d["meses"], d["datos"]
    out = []
    for medida, etiqueta in (("Viajeros", "Viajeros (último mes)"), ("Pernoctaciones", "Pernoctaciones (último mes)")):
        total = [0] * len(meses)
        for tipo in datos.values():
            serie = (tipo.get(medida) or {}).get("Total") or []
            for i, v in enumerate(serie[:len(meses)]):
                total[i] += v or 0
        pares = [(m, v) for m, v in zip(meses, total) if v]
        if pares:
            out.append(kpi(etiqueta, pares[-1][1], "", pares[-1][0]))
    return {"nombre": "Observatorio Turístico", "url": f"{GH}/observatorio-turistico-marbella/", "kpis": out}


def trafico():
    # datasets[nombre]["series"]["Marbella"][anio][columna]
    d = json.loads(texto(f"{GH}/observatorio-trafico-marbella/trafico_marbella.json"))
    out = []
    for ds_nombre, buscar, etiqueta in (("general", "Parque Total", "Parque de vehículos"),
                                        ("general", "Censo Conductores", "Conductores"),
                                        ("siniestralidad", "Accidentes", "Accidentes con víctimas"),
                                        ("siniestralidad", "Fallecidos", "Fallecidos en accidente")):
        serie = (d["datasets"].get(ds_nombre, {}).get("series") or {}).get("Marbella") or {}
        col = next((c for c in d["datasets"].get(ds_nombre, {}).get("columnas", []) if c.startswith(buscar)), None)
        pares = [(a, serie[a].get(col)) for a in sorted(serie) if col and serie[a].get(col) not in (None, "")]
        if pares:
            out.append(kpi(etiqueta, pares[-1][1], "", pares[-1][0]))
    return {"nombre": "Observatorio de Tráfico", "url": f"{GH}/observatorio-trafico-marbella/", "kpis": out}


def residuos():
    d = objeto_js(f"{GH}/observatorio-residuos-marbella/data/data.js", "=")
    out = []
    j = d.get("junta") or {}
    y, v = ultimo(j.get("x", []), j.get("v", [])); out.append(kpi("Residuos por habitante", v, "kg/hab·año", y, 1))
    return {"nombre": "Observatorio de Residuos", "url": f"{GH}/observatorio-residuos-marbella/", "kpis": out}


def ambiental():
    d = objeto_js(f"{GH}/observatorio-ambiental-marbella/data.js", "const OBS =")
    fechas, zonas, units = d["fechas"], d["zonas"], d["units"]
    muni = zonas.index("Municipio")
    out = []
    for ind, etiqueta, dec in (("cobveg", "Cobertura vegetal", 1), ("sellado", "Suelo sellado", 1),
                               ("tempsup", "Temperatura superficial", 1), ("co2", "Absorción de CO₂", 0)):
        regs = sorted((r for r in d["rec"] if r[1] == ind and r[2] == muni), key=lambda r: r[0])
        if regs:
            r = regs[-1]
            out.append(kpi(etiqueta, r[3], {"tempsup": "°C"}.get(ind, units.get(ind, "")), fechas[r[0]][:7], dec))
    return {"nombre": "Observatorio Ambiental", "url": f"{GH}/observatorio-ambiental-marbella/", "kpis": out}


def vut():
    idx = json.loads(texto(f"{GH}/mapa-vut-marbella/vut_index.json"))
    n = sum(v[3] for v in idx.values())
    plazas = sum(v[1] for v in idx.values())
    hoy = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return {"nombre": "Mapa de VUT", "url": f"{GH}/mapa-vut-marbella/",
            "kpis": [kpi("Viviendas de uso turístico", n, "", hoy), kpi("Plazas en VUT", plazas, "", hoy)]}


def ruta_accesible():
    s = texto(f"{GH}/ruta-accesible-marbella/")
    ruta = json.loads(re.search(r"const ROUTE\s*=\s*(\[\[.*?\]\])\s*;", s, re.S).group(1))
    feats = [{"type": "Feature", "properties": {"tipo": "ruta"},
              "geometry": {"type": "LineString", "coordinates": [[lon, lat] for lat, lon in ruta]}}]
    # puntos de interes: {..., acc:true|false, lat:.., lon:.., name:'..', ...}
    for m in re.finditer(r"\{[^{}]*?lat:\s*(36\.\d+)\s*,\s*lon:\s*(-4\.\d+)\s*,\s*name:\s*'([^']+)'", s):
        ini = s.rfind("{", 0, m.start() + 1)
        acc = re.search(r"acc:\s*(true|false)", s[ini:m.end()])
        feats.append({"type": "Feature",
                      "properties": {"tipo": "poi", "nombre": m.group(3), "no_accesible": bool(acc and acc.group(1) == "false")},
                      "geometry": {"type": "Point", "coordinates": [float(m.group(2)), float(m.group(1))]}})
    json.dump({"type": "FeatureCollection", "features": feats},
              open(os.path.join(CAPAS, "ruta_accesible.geojson"), "w", encoding="utf8"), ensure_ascii=False)
    return len(ruta), len(feats) - 1


# ---------------------------------------------------------------- ejecucion
previo = {}
if os.path.exists(OUT):
    previo = {o["id"]: o for o in json.load(open(OUT, encoding="utf8"))["observatorios"]}

ahora = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
salida = []
for oid, f in (("vut", vut), ("turismo", turismo), ("dti", dti), ("trafico", trafico),
               ("ambiental", ambiental), ("residuos", residuos)):
    try:
        o = f()
        o.update({"id": oid, "ok": True, "comprobado": ahora})
        if not o["kpis"]:
            raise ValueError("sin indicadores")
    except Exception as e:
        print(f"{oid}: FALLO ({e})", file=sys.stderr)
        o = dict(previo.get(oid, {"nombre": oid, "url": "", "kpis": []}), id=oid, ok=False, comprobado=ahora)
    print(f"{oid}: {'ok' if o['ok'] else 'conserva el dato anterior'} · {len(o['kpis'])} indicadores")
    salida.append(o)

try:
    print("ruta accesible: %d puntos de trazado, %d puntos de interés" % ruta_accesible())
except Exception as e:
    print(f"ruta accesible: FALLO ({e}); se conserva la capa anterior", file=sys.stderr)

json.dump({"actualizado": ahora, "observatorios": salida}, open(OUT, "w", encoding="utf8"),
          ensure_ascii=False, indent=1)
