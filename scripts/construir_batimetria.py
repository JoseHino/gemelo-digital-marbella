"""Batimetría del gemelo: relieve continuo tierra-mar y fondo marino coloreado.

Une el relieve de tierra de Terrain Tiles (AWS, donde el mar vale 0) con la batimetría de
EMODnet (DTM europeo, ~115 m) y genera tres productos en data/:

  - relieve.pmtiles      teselas raster-dem (codificación terrarium) para el terreno 3D
  - batimetria.pmtiles   fondo marino coloreado por profundidad con sombreado (PNG con alfa;
                         transparente en tierra)
  - capas/isobatas.geojson   curvas de profundidad

Si se coloca un modelo más fino en build/batimetria_local.tif (p. ej. el MBAR24 del
Instituto Hidrográfico de la Marina, que exige registro en cdihm.cnig.es), se usa ese
donde tenga dato y EMODnet en el resto. Debe estar en EPSG:4326 y en metros (negativo = fondo).
"""
import io, json, math, os, sys
import numpy as np
import requests, mercantile, rasterio, contourpy
from rasterio.warp import reproject, Resampling
from PIL import Image
from pmtiles.writer import Writer
from pmtiles.tile import zxy_to_tileid, TileType, Compression

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD, DATA = os.path.join(RAIZ, 'build'), os.path.join(RAIZ, 'data')
os.makedirs(BUILD, exist_ok=True)

# Marbella y su franja marina (hasta ~25 km mar adentro)
ZONA = (-5.08, 36.30, -4.72, 36.62)          # oeste, sur, este, norte: teselas detalladas
DESCARGA = (-5.40, 36.00, -4.40, 36.80)      # algo más amplia, para los niveles de zoom bajos
ZMIN, ZMAX = 8, 14
AWS = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
EMOD = ('https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage'
        '&coverageId=emodnet__mean&format=image/tiff&subset=Lat({s},{n})&subset=Long({w},{e})')
LOCAL = os.path.join(BUILD, 'batimetria_local.tif')

ses = requests.Session()


def descarga_emodnet():
    ruta = os.path.join(BUILD, 'emodnet.tif')
    w, s, e, n = DESCARGA
    r = ses.get(EMOD.format(w=w, s=s, e=e, n=n), timeout=300)
    r.raise_for_status()
    if not r.content.startswith((b'II*', b'MM\x00*')):
        sys.exit('EMODnet no ha devuelto un GeoTIFF: ' + r.text[:300])
    open(ruta, 'wb').write(r.content)
    return ruta


class Rejilla:
    """Rejilla lon/lat (EPSG:4326) con interpolación bilineal."""
    def __init__(self, ruta):
        with rasterio.open(ruta) as src:
            a = src.read(1).astype('float32')
            if src.nodata is not None:
                a[a == src.nodata] = np.nan
            self.a, self.t = a, src.transform
        print(f'  {os.path.basename(ruta)}: {self.a.shape[1]}×{self.a.shape[0]} celdas, '
              f'{abs(self.t.a) * 111320 * math.cos(math.radians(36.5)):.0f} m de celda')

    def muestra(self, lon, lat):
        c = (lon - self.t.c) / self.t.a - 0.5
        f = (lat - self.t.f) / self.t.e - 0.5
        h, w = self.a.shape
        c0 = np.clip(np.floor(c).astype(int), 0, w - 2); f0 = np.clip(np.floor(f).astype(int), 0, h - 2)
        dc = np.clip(c - c0, 0, 1); df = np.clip(f - f0, 0, 1)
        a = self.a
        v = (a[f0, c0] * (1 - dc) * (1 - df) + a[f0, c0 + 1] * dc * (1 - df) +
             a[f0 + 1, c0] * (1 - dc) * df + a[f0 + 1, c0 + 1] * dc * df)
        fuera = (c < -0.5) | (c > w - 0.5) | (f < -0.5) | (f > h - 0.5)
        return np.where(fuera, np.nan, v)


def lonlat_tesela(t, borde=0):
    """Lon/lat del centro de cada píxel de una tesela de 256×256 (más `borde` píxeles por lado)."""
    b = mercantile.xy_bounds(t)
    i = (np.arange(-borde, 256 + borde) + 0.5) / 256
    x = b.left + i * (b.right - b.left)
    y = b.top - i * (b.top - b.bottom)
    X, Y = np.meshgrid(x, y)
    lon = X / 6378137 * 180 / math.pi
    lat = np.degrees(2 * np.arctan(np.exp(Y / 6378137)) - math.pi / 2)
    return lon, lat


def aws(t):
    r = ses.get(AWS.format(z=t.z, x=t.x, y=t.y), timeout=60)
    r.raise_for_status()
    p = np.asarray(Image.open(io.BytesIO(r.content)).convert('RGB')).astype('float64')
    return p[..., 0] * 256 + p[..., 1] + p[..., 2] / 256 - 32768


def terrarium(h):
    v = np.clip(h, -32768, 32767) + 32768
    r = np.floor(v / 256); g = np.floor(v - r * 256); b = np.floor((v - np.floor(v)) * 256)
    return np.dstack([r, g, b]).astype('uint8')


# Rampa de profundidad (m) -> color: aguas someras turquesa, plataforma azul, talud azul noche
RAMPA = [(0, (182, 236, 230)), (-5, (128, 214, 214)), (-15, (72, 181, 200)), (-30, (42, 140, 186)),
         (-60, (30, 102, 165)), (-120, (25, 72, 138)), (-300, (20, 48, 104)), (-800, (12, 26, 66))]


def color_profundidad(h):
    prof = np.array([p for p, _ in RAMPA])[::-1]
    cols = np.array([c for _, c in RAMPA], dtype='float64')[::-1]
    return np.dstack([np.interp(h, prof, cols[:, k]) for k in range(3)])


def sombreado(h, t):
    """Sombreado (luz del noroeste, relieve ×4 para que se aprecie el fondo)."""
    res = (mercantile.xy_bounds(t).right - mercantile.xy_bounds(t).left) / 256
    gy, gx = np.gradient(h * 4, res)
    az, alt = math.radians(315), math.radians(40)
    pend = np.arctan(np.hypot(gx, gy)); asp = np.arctan2(-gx, gy)
    s = np.sin(alt) * np.cos(pend) + np.cos(alt) * np.sin(pend) * np.cos(az - asp)
    return np.clip(s, 0, 1)


def main():
    print('EMODnet: descargando batimetría')
    fuentes = [Rejilla(descarga_emodnet())]
    if os.path.exists(LOCAL):
        print('Modelo local encontrado, tiene prioridad donde haya dato')
        fuentes.insert(0, Rejilla(LOCAL))

    def fondo(lon, lat):
        v = np.full(lon.shape, np.nan)
        for f in fuentes:
            m = np.isnan(v); v[m] = f.muestra(lon[m], lat[m])
        return v

    teselas = [t for z in range(ZMIN, ZMAX + 1) for t in mercantile.tiles(*ZONA, z)]
    print(f'Teselas z{ZMIN}-z{ZMAX}: {len(teselas)}')
    dem, color = {}, {}
    min_prof = 0
    for n, t in enumerate(teselas, 1):
        tierra = aws(t)
        mar = tierra <= 0.25                        # en Terrain Tiles el mar es plano a 0 m
        prof_b = np.minimum(fondo(*lonlat_tesela(t, 1)), -0.5)   # el fondo nunca por encima del agua
        prof = prof_b[1:-1, 1:-1]
        prof = np.where(np.isnan(prof), tierra, prof)
        h = np.where(mar, prof, tierra)
        dem[t] = img_bytes(terrarium(np.round(h * 8) / 8), 'png')   # 12,5 cm: suficiente y comprime mucho mejor
        if mar.any():
            # el sombreado se calcula con un píxel de margen para que no se noten las juntas entre teselas
            luz = sombreado(np.nan_to_num(prof_b, nan=0.0), t)[1:-1, 1:-1]
            rgb = color_profundidad(np.where(mar, prof, 0)) * (0.55 + 0.45 * luz)[..., None]
            rgba = np.dstack([rgb.clip(0, 255), np.where(mar, 255, 0)]).astype('uint8')
            color[t] = img_bytes(rgba, 'png')
            min_prof = min(min_prof, float(np.nanmin(np.where(mar, prof, 0))))
        if n % 50 == 0 or n == len(teselas):
            print(f'  {n}/{len(teselas)}')

    escribe(os.path.join(DATA, 'relieve.pmtiles'), dem, 'Relieve tierra-mar (Terrain Tiles + EMODnet)')
    escribe(os.path.join(DATA, 'batimetria.pmtiles'), color, 'Batimetría (EMODnet)')
    isobatas(fuentes)
    json.dump({'fuente': 'EMODnet Bathymetry DTM' + (' + modelo local' if len(fuentes) > 1 else ''),
               'profundidad_max_zona_m': round(-min_prof), 'teselas': len(teselas)},
              open(os.path.join(DATA, 'resumen_batimetria.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print('Hecho')


def img_bytes(arr, fmt):
    b = io.BytesIO(); Image.fromarray(arr).save(b, fmt, optimize=True); return b.getvalue()


def escribe(ruta, teselas, nombre):
    with open(ruta, 'wb') as f:
        w = Writer(f)
        for t in sorted(teselas, key=lambda t: zxy_to_tileid(t.z, t.x, t.y)):
            w.write_tile(zxy_to_tileid(t.z, t.x, t.y), teselas[t])
        w.finalize({'tile_type': TileType.PNG, 'tile_compression': Compression.NONE,
                    'min_zoom': ZMIN, 'max_zoom': ZMAX,
                    'min_lon_e7': int(ZONA[0] * 1e7), 'min_lat_e7': int(ZONA[1] * 1e7),
                    'max_lon_e7': int(ZONA[2] * 1e7), 'max_lat_e7': int(ZONA[3] * 1e7),
                    'center_zoom': 11, 'center_lon_e7': int(-4.90 * 1e7), 'center_lat_e7': int(36.46 * 1e7)},
                   {'name': nombre})
    print(f'  {os.path.basename(ruta)}: {len(teselas)} teselas, {os.path.getsize(ruta) / 1e6:.1f} MB')


def isobatas(fuentes):
    """Curvas de profundidad sobre la rejilla de EMODnet (la más amplia)."""
    g = fuentes[-1]
    h, w = g.a.shape
    lon = g.t.c + (np.arange(w) + 0.5) * g.t.a
    lat = g.t.f + (np.arange(h) + 0.5) * g.t.e
    gen = contourpy.contour_generator(lon, lat, g.a)
    feats = []
    for nivel in [-5, -10, -20, -30, -50, -100, -200, -300, -400, -500, -600, -700, -800]:
        for linea in gen.lines(nivel):
            if len(linea) < 4:
                continue
            feats.append({'type': 'Feature', 'properties': {'prof': -nivel, 'principal': nivel in (-10, -50, -100, -200, -500)},
                          'geometry': {'type': 'LineString', 'coordinates': [[round(x, 5), round(y, 5)] for x, y in linea]}})
    os.makedirs(os.path.join(DATA, 'capas'), exist_ok=True)
    json.dump({'type': 'FeatureCollection', 'features': feats},
              open(os.path.join(DATA, 'capas', 'isobatas.geojson'), 'w'), separators=(',', ':'))
    print(f'Isóbatas: {len(feats)} líneas')


if __name__ == '__main__':
    main()
