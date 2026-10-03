// Gemelo Digital de Marbella
// Edificios 3D (Catastro INSPIRE, teselas PMTiles) + VUT diarias (mapa de VUT) + observatorios municipales.

const GH = 'https://josehino.github.io';
const VUT_INDEX = `${GH}/mapa-vut-marbella/vut_index.json`;           // rc18 -> [registro(s), plazas, alta, nº VUT]
const VUT_PUNTOS = `${GH}/mapa-vut-marbella/VUT_Marbella_geolocalizadas.csv`;
const fmt = n => (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString('es-ES');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);

// ------------------------------------------------------------------ mapa
const pm = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pm.tile);
const pmUrl = f => 'pmtiles://' + new URL(f, location.href).href;

// Relieve: teselas propias tierra-mar (data/relieve.pmtiles) en Marbella y su costa; fuera de esa zona,
// Terrain Tiles de AWS (sin ellas el terreno se queda en blanco al alejarse).
const relievePm = new pmtiles.PMTiles(new URL('data/relieve.pmtiles', location.href).href);
async function teselaRelieve(z, x, y, signal) {
  const t = await relievePm.getZxy(z, x, y, signal);
  if (t && t.data) return t.data;
  const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, { signal });
  if (!r.ok) throw new Error(`Relieve ${z}/${x}/${y}: ${r.status}`);
  return r.arrayBuffer();
}
maplibregl.addProtocol('relieve', async (params, abort) => {
  const [z, x, y] = params.url.replace('relieve://', '').split('/').map(Number);
  return { data: await teselaRelieve(z, x, y, abort.signal) };
});

// Cotas decodificadas (terrarium → metros) para la simulación; caché acotada.
const cacheDem = new Map();
function demTesela(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!cacheDem.has(k)) {
    cacheDem.set(k, teselaRelieve(z, x, y).then(async buf => {
      const bmp = await createImageBitmap(new Blob([buf]));
      const n = bmp.width, cv = new OffscreenCanvas(n, n), cx = cv.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const d = cx.getImageData(0, 0, n, n).data, h = new Float32Array(n * n);
      for (let i = 0; i < n * n; i++) h[i] = d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768;
      return { n, h };
    }).catch(() => null));
    if (cacheDem.size > 300) cacheDem.delete(cacheDem.keys().next().value);
  }
  return cacheDem.get(k);
}
// cota bilineal en coordenadas de píxel (px, py) de una tesela decodificada
function bilineal(t, px, py) {
  const n = t.n, x0 = Math.max(0, Math.min(n - 2, Math.floor(px))), y0 = Math.max(0, Math.min(n - 2, Math.floor(py)));
  const fx = Math.max(0, Math.min(1, px - x0)), fy = Math.max(0, Math.min(1, py - y0)), h = t.h, i = y0 * n + x0;
  return (h[i] * (1 - fx) + h[i + 1] * fx) * (1 - fy) + (h[i + n] * (1 - fx) + h[i + n + 1] * fx) * fy;
}
const Z_DEM = 14;
async function cotaEn(lng, lat) {
  const s = 2 ** Z_DEM, X = (lng + 180) / 360 * s,
        Y = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * s;
  const t = await demTesela(Z_DEM, Math.floor(X), Math.floor(Y));
  return t ? bilineal(t, (X % 1) * t.n - 0.5, (Y % 1) * t.n - 0.5) : null;
}

// Inundación (modelo "bañera"): pinta la tierra con cota entre 0,25 m (línea de costa del relieve) y el nivel elegido.
// Por encima de z14 remuestrea la tesela z14 de forma bilineal para que el borde del agua salga suave.
let vacia = null;
maplibregl.addProtocol('inunda', async params => {
  const [ruta, q] = params.url.replace('inunda://', '').split('?');
  const [z, x, y] = ruta.split('/').map(Number), nivel = parseFloat(new URLSearchParams(q).get('n')) || 0;
  const zd = Math.min(z, Z_DEM), k = 2 ** (z - zd);
  const t = nivel > 0 ? await demTesela(zd, Math.floor(x / k), Math.floor(y / k)) : null;
  if (!vacia) { const c1 = new OffscreenCanvas(1, 1); c1.getContext('2d'); vacia = await (await c1.convertToBlob()).arrayBuffer(); }
  if (!t) return { data: vacia.slice(0) };
  const N = 256, cv = new OffscreenCanvas(N, N), cx = cv.getContext('2d'), img = cx.createImageData(N, N), o = img.data;
  const paso = t.n / k / N, ox = (x % k) * t.n / k, oy = (y % k) * t.n / k;
  let algo = false;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const h = bilineal(t, ox + (i + 0.5) * paso - 0.5, oy + (j + 0.5) * paso - 0.5);
    if (h > 0.25 && h <= nivel) {
      algo = true;
      const p = 4 * (j * N + i), prof = Math.min(1, (nivel - h) / 2);
      o[p] = 20 + 10 * (1 - prof); o[p + 1] = 110 - 50 * prof; o[p + 2] = 220 - 40 * prof; o[p + 3] = 150 + 90 * prof;
    }
  }
  if (!algo) return { data: vacia.slice(0) };
  cx.putImageData(img, 0, 0);
  return { data: await (await cv.convertToBlob()).arrayBuffer() };
});
const wmts = (capa, srv, fmtImg = 'image/jpeg') =>
  `https://www.ign.es/wmts/${srv}?layer=${capa}&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Version=1.0.0&Format=${fmtImg}&TileMatrix={z}&TileCol={x}&TileRow={y}`;

const map = new maplibregl.Map({
  container: 'map',
  center: [-4.8858, 36.5098], zoom: 15.6, pitch: 62, bearing: -20, maxPitch: 80,
  hash: true,
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      orto: { type: 'raster', tiles: [wmts('OI.OrthoimageCoverage', 'pnoa-ma')], tileSize: 256, maxzoom: 19, attribution: 'Ortofoto PNOA © IGN' },
      base: { type: 'raster', tiles: [wmts('IGNBaseTodo', 'ign-base')], tileSize: 256, maxzoom: 19, attribution: 'Mapa base © IGN' },
      // relieve continuo tierra-mar: Terrain Tiles en tierra + batimetría del IHM (MBAR24, 16 m) y EMODnet en el mar (scripts/construir_batimetria.py)
      dem: { type: 'raster-dem', tiles: ['relieve://{z}/{x}/{y}'], encoding: 'terrarium', tileSize: 256, maxzoom: 14,
             attribution: 'Relieve: Mapzen/AWS Terrain Tiles · Batimetría: © Instituto Hidrográfico de la Marina (MBAR24), EMODnet' },
      bati: { type: 'raster', url: pmUrl('data/batimetria.pmtiles'), tileSize: 256 },
      isob: { type: 'geojson', data: 'data/capas/isobatas.geojson' },
      inunda: { type: 'raster', tiles: ['inunda://{z}/{x}/{y}?n=0'], tileSize: 256, minzoom: 10, maxzoom: 17 },
      edif: { type: 'vector', url: pmUrl('data/edificios.pmtiles'),
              promoteId: { edificios: 'rc' }, attribution: 'Edificios © Dirección General del Catastro' },
    },
    layers: [
      { id: 'fondo', type: 'background', paint: { 'background-color': '#dfe6ea' } },
      { id: 'orto', type: 'raster', source: 'orto' },
      { id: 'base', type: 'raster', source: 'base', layout: { visibility: 'none' } },
      { id: 'bati', type: 'raster', source: 'bati', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } },
      { id: 'isob', type: 'line', source: 'isob', layout: { visibility: 'none' },
        paint: { 'line-color': '#ffffff', 'line-opacity': ['case', ['==', ['get', 'principal'], true], 0.75, 0.35],
                 'line-width': ['case', ['==', ['get', 'principal'], true], 1.4, 0.7] } },
      { id: 'isob-txt', type: 'symbol', source: 'isob', filter: ['==', ['get', 'principal'], true], layout: { visibility: 'none',
          'symbol-placement': 'line', 'symbol-spacing': 420, 'text-field': ['concat', ['to-string', ['get', 'prof']], ' m'],
          'text-font': ['Open Sans Semibold'], 'text-size': 11 },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10,30,70,.8)', 'text-halo-width': 1.4 } },
      { id: 'inunda', type: 'raster', source: 'inunda', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } },
      { id: 'edificios', type: 'fill-extrusion', source: 'edif', 'source-layer': 'edificios', minzoom: 13,
        paint: { 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.92,
                 'fill-extrusion-color': '#ccc', 'fill-extrusion-vertical-gradient': true } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');

// ------------------------------------------------------------------ modos de color
const SEL = ['boolean', ['feature-state', 'sel'], false];
const INUND = ['boolean', ['feature-state', 'inund'], false];
const sinDato = '#cfd3d6';
const pctVut = ['/', ['coalesce', ['feature-state', 'vut'], 0], ['max', ['coalesce', ['get', 'viv'], 1], 1]];
const MODOS = {
  uso: {
    color: ['match', ['get', 'uso'], 'residencial', '#e9c46a', 'comercial', '#e76f51', 'oficinas', '#9b8ec4',
            'industrial', '#8d99ae', 'servicios públicos', '#2a9d8f', 'agrario', '#90be6d', sinDato],
    ley: { cat: [['Residencial', '#e9c46a'], ['Comercial', '#e76f51'], ['Oficinas', '#9b8ec4'], ['Industrial', '#8d99ae'],
                 ['Servicios públicos', '#2a9d8f'], ['Agrario', '#90be6d'], ['Sin dato', sinDato]] },
  },
  anio: {
    color: ['case', ['<', ['coalesce', ['get', 'anio'], 0], 1800], sinDato,
            ['interpolate', ['linear'], ['get', 'anio'], 1900, '#3b0f70', 1960, '#8c2981', 1975, '#de4968', 1990, '#fe9f6d', 2005, '#fcfdbf', 2025, '#ffffff']],
    ley: { grad: 'linear-gradient(90deg,#3b0f70,#8c2981,#de4968,#fe9f6d,#fcfdbf)', de: '≤1900', a: '2025', nota: 'Año de construcción según el Catastro.' },
  },
  altura: {
    color: ['interpolate', ['linear'], ['get', 'h'], 3, '#ffffcc', 9, '#a1dab4', 18, '#41b6c4', 36, '#2c7fb8', 60, '#253494'],
    ley: { grad: 'linear-gradient(90deg,#ffffcc,#a1dab4,#41b6c4,#2c7fb8,#253494)', de: '1 planta', a: '20+ plantas', nota: 'Altura estimada: nº de plantas sobre rasante × 3 m.' },
  },
  viv: {
    color: ['step', ['coalesce', ['get', 'viv'], 0], sinDato, 1, '#fde0c5', 2, '#facba6', 10, '#f59e72', 50, '#eb7f54', 200, '#c8553d'],
    ley: { cat: [['Sin viviendas', sinDato], ['1', '#fde0c5'], ['2–9', '#facba6'], ['10–49', '#f59e72'], ['50–199', '#eb7f54'], ['200+', '#c8553d']],
           nota: 'Nº de viviendas del edificio según el Catastro.' },
  },
  vut: {
    color: ['case', ['>', ['coalesce', ['feature-state', 'vut'], 0], 0],
            ['interpolate', ['linear'], ['min', pctVut, 1], 0, '#fee08b', 0.25, '#fdae61', 0.5, '#f46d43', 1, '#a50026'], '#e4e6e8'],
    ley: { grad: 'linear-gradient(90deg,#fee08b,#fdae61,#f46d43,#a50026)', de: 'pocas', a: 'todas', nota: '% de las viviendas del edificio inscritas como VUT en el Registro de Turismo de Andalucía (actualizado a diario). En gris, edificios sin VUT.' },
  },
  cee: {
    color: ['match', ['get', 'cee'], 'A', '#00a651', 'B', '#4cb848', 'C', '#bfd730', 'D', '#fff200', 'E', '#fdb913', 'F', '#f37021', 'G', '#ed1c24', '#e4e6e8'],
    ley: { cat: [['A', '#00a651'], ['B', '#4cb848'], ['C', '#bfd730'], ['D', '#fff200'], ['E', '#fdb913'], ['F', '#f37021'], ['G', '#ed1c24'], ['Sin certificado', '#e4e6e8']],
           nota: 'Calificación de consumo de energía primaria no renovable del certificado energético más reciente de la parcela (registro andaluz de certificados energéticos).' },
  },
};
let modo = 'uso';

function aplicaModo(m) {
  modo = m;
  document.querySelectorAll('#modos button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  map.setPaintProperty('edificios', 'fill-extrusion-color', ['case', SEL, '#1044CD', INUND, '#e6007e', MODOS[m].color]);
  const l = MODOS[m].ley;
  $('leyenda').innerHTML = (l.grad ? `<div class="grad" style="background:${l.grad}"></div><div class="gl"><span>${l.de}</span><span>${l.a}</span></div>` : '') +
    (l.cat ? `<div class="cat">${l.cat.map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div>` : '') +
    (l.nota ? `<div class="nota">${l.nota}</div>` : '');
}
document.querySelectorAll('#modos button').forEach(b => b.onclick = () => aplicaModo(b.dataset.m));

// ------------------------------------------------------------------ capas
map.on('load', () => {
  map.setTerrain({ source: 'dem', exaggeration: exag() });
  aplicaModo(modo);

  map.addSource('ruta', { type: 'geojson', data: 'data/capas/ruta_accesible.geojson' });
  map.addLayer({ id: 'ruta-linea', type: 'line', source: 'ruta', filter: ['==', ['get', 'tipo'], 'ruta'],
                 layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
                 paint: { 'line-color': '#1ADEB1', 'line-width': 5, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'ruta-pois', type: 'circle', source: 'ruta', filter: ['==', ['get', 'tipo'], 'poi'],
                 layout: { visibility: 'none' },
                 paint: { 'circle-radius': 6, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
                          'circle-color': ['case', ['get', 'no_accesible'], '#d7191c', '#1044CD'] } });

  map.addSource('vutpts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'vut-calor', type: 'heatmap', source: 'vutpts', layout: { visibility: 'none' }, maxzoom: 17,
                 paint: { 'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 12, 6, 16, 22],
                          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 1.4],
                          'heatmap-opacity': 0.75 } }, 'edificios');

  cargaVut();
  $('cSim').disabled = false;
  $('cargando').style.display = 'none';
});

$('cOrto').onchange = e => {
  map.setLayoutProperty('orto', 'visibility', e.target.checked ? 'visible' : 'none');
  map.setLayoutProperty('base', 'visibility', e.target.checked ? 'none' : 'visible');
};
const exag = () => $('cExag').checked ? 3 : 1;
const relieve = () => map.setTerrain($('cRelieve').checked ? { source: 'dem', exaggeration: exag() } : null);
$('cRelieve').onchange = relieve;
$('cExag').onchange = relieve;
$('cBati').onchange = e => {
  ['bati', 'isob', 'isob-txt'].forEach(l => map.setLayoutProperty(l, 'visibility', e.target.checked ? 'visible' : 'none'));
  $('leyBati').style.display = e.target.checked ? '' : 'none';
  if (e.target.checked) {
    if (!$('cRelieve').checked) { $('cRelieve').checked = true; relieve(); }
    map.flyTo({ center: [-4.905, 36.455], zoom: 12.2, pitch: 70, bearing: 10, duration: 3000 });
  }
};

// profundidad o cota del punto pulsado (fuera de los edificios)
const cota = new maplibregl.Popup({ closeButton: false, className: 'cota' });
map.on('click', e => {
  if (!$('cBati').checked || !map.terrain || map.queryRenderedFeatures(e.point, { layers: ['edificios'] }).length) return;
  const h = map.terrain.getElevationForLngLatZoom(e.lngLat, Math.min(14, Math.floor(map.getZoom()))) / exag();
  if (h == null || isNaN(h)) return;
  cota.setLngLat(e.lngLat).setHTML(h < 0 ? `Profundidad ≈ <b>${fmt(Math.round(-h))} m</b>` : `Cota ≈ <b>${fmt(Math.round(h))} m</b>`).addTo(map);
});
$('cRuta').onchange = e => {
  ['ruta-linea', 'ruta-pois'].forEach(l => map.setLayoutProperty(l, 'visibility', e.target.checked ? 'visible' : 'none'));
  if (e.target.checked) map.flyTo({ center: [-4.8852, 36.5108], zoom: 17, pitch: 55 });
};
$('cCalor').onchange = async e => {
  map.setLayoutProperty('vut-calor', 'visibility', e.target.checked ? 'visible' : 'none');
  if (e.target.checked && !vutPuntosCargados) await cargaVutPuntos();
};

// ------------------------------------------------------------------ VUT (diarias, del mapa de VUT)
const vutPorParcela = new Map();
async function cargaVut() {
  try {
    const idx = await (await fetch(VUT_INDEX)).json();
    let total = 0;
    for (const [rc, v] of Object.entries(idx)) {
      const pc = rc.slice(0, 14);
      const e = vutPorParcela.get(pc) || { n: 0, plazas: 0, regs: [] };
      e.n += v[3]; e.plazas += v[1]; e.regs.push(v[0]);
      vutPorParcela.set(pc, e); total += v[3];
    }
    for (const [pc, e] of vutPorParcela) map.setFeatureState({ source: 'edif', sourceLayer: 'edificios', id: pc }, { vut: e.n });
    $('kVut').textContent = fmt(total);
  } catch (err) { console.error('VUT', err); }
}
let vutPuntosCargados = false;
async function cargaVutPuntos() {
  const txt = await (await fetch(VUT_PUNTOS)).text();
  const filas = txt.replace(/^﻿/, '').trim().split('\n');
  const cab = filas[0].split(';'), iLat = cab.indexOf('lat'), iLon = cab.indexOf('lon');
  const features = filas.slice(1).map(l => l.split(';')).filter(c => c[iLat])
    .map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [+c[iLon], +c[iLat]] } }));
  map.getSource('vutpts').setData({ type: 'FeatureCollection', features });
  vutPuntosCargados = true;
}

// ------------------------------------------------------------------ ficha de edificio
let seleccion = null;
const USO_TXT = u => u ? u[0].toUpperCase() + u.slice(1) : 'Sin dato';
map.on('mouseenter', 'edificios', () => map.getCanvas().style.cursor = 'pointer');
map.on('mouseleave', 'edificios', () => map.getCanvas().style.cursor = '');
map.on('click', 'edificios', e => {
  const p = e.features[0].properties, rc = p.rc;
  if (seleccion) map.setFeatureState({ source: 'edif', sourceLayer: 'edificios', id: seleccion }, { sel: false });
  seleccion = rc;
  map.setFeatureState({ source: 'edif', sourceLayer: 'edificios', id: rc }, { sel: true });
  const partes = map.querySourceFeatures('edif', { sourceLayer: 'edificios', filter: ['==', ['get', 'rc'], rc] });
  const plantas = Math.max(p.pl || 0, ...partes.map(f => f.properties.pl || 0));
  const v = vutPorParcela.get(rc);
  const pct = v && p.viv ? Math.min(100, Math.round(v.n / p.viv * 100)) : null;
  const COL = { A: '#00a651', B: '#4cb848', C: '#bfd730', D: '#fff200', E: '#fdb913', F: '#f37021', G: '#ed1c24' };
  const [lon, lat] = [e.lngLat.lng.toFixed(6), e.lngLat.lat.toFixed(6)];
  $('fichaC').innerHTML = `
    <img src="https://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/OVCFotoFachada.svc/RecuperarFotoFachadaGet?ReferenciaCatastral=${esc(rc)}"
         alt="Fachada (Catastro)" onerror="this.remove()">
    <div class="c">
      <h3>Edificio ${esc(rc)}</h3>
      <div class="sub">Referencia catastral de la parcela</div>
      <table>
        <tr><td>Uso principal</td><td>${esc(USO_TXT(p.uso))}</td></tr>
        <tr><td>Año de construcción</td><td>${p.anio || '–'}</td></tr>
        <tr><td>Plantas sobre rasante</td><td>${plantas || '–'}</td></tr>
        <tr><td>Viviendas</td><td>${fmt(p.viv)}</td></tr>
        <tr><td>Inmuebles</td><td>${fmt(p.ud)}</td></tr>
        <tr><td>Superficie construida</td><td>${p.sup ? fmt(p.sup) + ' m²' : '–'}</td></tr>
        <tr><td>Viviendas turísticas</td><td>${v ? `<b>${v.n}</b> (${fmt(v.plazas)} plazas)${pct != null ? ` · ${pct} % de las viviendas` : ''}` : 'Ninguna inscrita'}</td></tr>
        <tr><td>Certificado energético</td><td>${p.cee ? `<span class="letra" style="background:${COL[p.cee] || '#999'}">${esc(p.cee)}</span>` : 'Sin certificado registrado'}</td></tr>
      </table>
      <div class="links">
        <a class="a1" target="_blank" href="https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?rc1=${esc(rc.slice(0, 7))}&rc2=${esc(rc.slice(7, 14))}">Ficha del Catastro</a>
        ${v ? `<a target="_blank" href="${GH}/mapa-vut-marbella/">Mapa de VUT</a>` : ''}
        <a target="_blank" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}">Street View</a>
      </div>
    </div>`;
  $('ficha').classList.add('on');
});
document.querySelector('#ficha .x').onclick = () => {
  $('ficha').classList.remove('on');
  if (seleccion) map.setFeatureState({ source: 'edif', sourceLayer: 'edificios', id: seleccion }, { sel: false });
  seleccion = null;
};

// ------------------------------------------------------------------ ir a
const SITIOS = [['Casco Antiguo', [-4.8858, 36.5098], 16.6], ['Puerto Banús', [-4.9523, 36.4864], 16.3], ['San Pedro', [-4.9907, 36.4855], 16],
                ['Nueva Andalucía', [-4.9530, 36.4990], 15.4], ['Golden Mile', [-4.9180, 36.5015], 15.6], ['Las Chapas', [-4.7790, 36.5040], 15.2],
                ['Vista general', [-4.9100, 36.5030], 12.6]];
$('irA').innerHTML = SITIOS.map((s, i) => `<button data-i="${i}">${s[0]}</button>`).join('');
$('irA').onclick = e => {
  const s = SITIOS[e.target.dataset.i]; if (!s) return;
  map.flyTo({ center: s[1], zoom: s[2], pitch: s[2] < 14 ? 45 : 62, bearing: -20, duration: 2500 });
};

// ------------------------------------------------------------------ resumen y observatorios
fetch('data/resumen_base.json').then(r => r.json()).then(r => {
  $('kEdif').textContent = fmt(r.edificios); $('kViv').textContent = fmt(r.viviendas);
  $('fuentes').innerHTML = fuentes(r);
}).catch(() => { $('fuentes').innerHTML = fuentes({}); });

function fuentes(r) {
  return `<b>Fuentes oficiales.</b> Edificios: <a target="_blank" href="https://www.catastro.hacienda.gob.es/webinspire/index.html">Catastro, INSPIRE</a>${r.fecha_catastro ? ` (base del ${r.fecha_catastro.split('-').reverse().join('/')})` : ''}; altura estimada a 3 m por planta.
    Viviendas turísticas: <a target="_blank" href="${GH}/mapa-vut-marbella/">Registro de Turismo de Andalucía</a>, a diario.
    Eficiencia energética: registro andaluz de certificados energéticos, por parcela.
    Ortofoto y mapa base: IGN. Relieve: Terrain Tiles (AWS). Batimetría: <a target="_blank" href="https://cdihm.cnig.es/CentroDescargasIHM/">Instituto Hidrográfico de la Marina</a> (modelo MBAR24, celda de 16 m) y, fuera de su cobertura, <a target="_blank" href="https://emodnet.ec.europa.eu/en/bathymetry">EMODnet</a> (~100 m).
    Indicadores: observatorios municipales de Marbella, sincronizados cada día.
    Tiempo, mar y aire en vivo: <a target="_blank" href="https://open-meteo.com/">Open-Meteo</a> (modelos meteorológicos europeos y Copernicus), cada 15 minutos.`;
}

fetch('data/observatorios.json').then(r => r.json()).then(d => {
  $('obs').innerHTML = d.observatorios.map(o => `
    <div class="obs">
      <div class="t"><a target="_blank" href="${esc(o.url)}">${esc(o.nombre)} ↗</a>
        <small class="${o.ok ? '' : 'ko'}">${o.ok ? '' : 'sin conexión · último dato'}</small></div>
      <div class="k">${o.kpis.slice(0, 4).map(k => `<div><b>${fmt(k.valor)}${k.unidad && k.unidad.length < 4 ? ' ' + esc(k.unidad) : ''}</b>${esc(k.etiqueta)}${k.periodo ? ` · ${esc(k.periodo)}` : ''}</div>`).join('')}</div>
    </div>`).join('') + `<div class="src">Sincronizado el ${new Date(d.actualizado.replace('Z', ':00Z')).toLocaleDateString('es-ES')}.</div>`;
}).catch(() => { $('obs').innerHTML = '<div class="src">No se han podido cargar los indicadores.</div>'; });

// ------------------------------------------------------------------ ahora en Marbella (Open-Meteo, en vivo desde el navegador)
const OM = 'latitude=36.505&longitude=-4.886&timezone=Europe%2FMadrid';
const CIELO = { 0: 'Despejado', 1: 'Casi despejado', 2: 'Nubes y claros', 3: 'Cubierto', 45: 'Niebla', 48: 'Niebla', 51: 'Llovizna', 53: 'Llovizna', 55: 'Llovizna',
  61: 'Lluvia débil', 63: 'Lluvia', 65: 'Lluvia fuerte', 80: 'Chubascos', 81: 'Chubascos', 82: 'Chubascos fuertes', 95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo' };
const RUMBO = g => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(g / 45) % 8];
const VIENTO_LOCAL = g => g >= 45 && g <= 135 ? ' · levante' : g >= 225 && g <= 315 ? ' · poniente' : '';
const ICA = v => v <= 20 ? 'buena' : v <= 40 ? 'razonable' : v <= 60 ? 'regular' : v <= 80 ? 'mala' : v <= 100 ? 'muy mala' : 'extremadamente mala';
const dec = (n, d = 1) => n == null ? '–' : Number(n).toLocaleString('es-ES', { maximumFractionDigits: d, minimumFractionDigits: d });

// cada tarjeta abre su histórico (historico.js)
const H = id => `data-h="${id}" role="button" tabindex="0" title="Ver el histórico y cruzarlo con otros datos"`;
async function cargaVivo() {
  const j = u => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
  const [met, mar, aire] = await Promise.all([
    j(`https://api.open-meteo.com/v1/forecast?${OM}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m&daily=uv_index_max&forecast_days=1`),
    j('https://marine-api.open-meteo.com/v1/marine?latitude=36.49&longitude=-4.88&timezone=Europe%2FMadrid&current=wave_height,wave_period,wave_direction,sea_surface_temperature'),
    j(`https://air-quality-api.open-meteo.com/v1/air-quality?${OM}&current=european_aqi,pm10,nitrogen_dioxide`),
  ]);
  const c = met?.current, m = mar?.current, a = aire?.current, cel = [];
  if (c) {
    cel.push(`<div ${H('temp')}><b>${dec(c.temperature_2m)} °C</b>${esc(CIELO[c.weather_code] || '')} · sensación ${dec(c.apparent_temperature, 0)} °C</div>`);
    cel.push(`<div ${H('viento')}><b>${dec(c.wind_speed_10m, 0)} km/h</b>Viento del ${RUMBO(c.wind_direction_10m)}${VIENTO_LOCAL(c.wind_direction_10m)} · rachas ${dec(c.wind_gusts_10m, 0)}</div>`);
  }
  if (m) {
    cel.push(`<div ${H('ola')}><b>${dec(m.wave_height)} m</b>Oleaje del ${RUMBO(m.wave_direction)} · periodo ${dec(m.wave_period, 0)} s</div>`);
    cel.push(`<div ${H('sst')}><b>${dec(m.sea_surface_temperature)} °C</b>Temperatura del agua del mar</div>`);
  }
  if (a) cel.push(`<div ${H('ica')}><b>${dec(a.european_aqi, 0)}</b>Calidad del aire <em>${ICA(a.european_aqi)}</em> · NO₂ ${dec(a.nitrogen_dioxide, 0)} µg/m³</div>`);
  if (met?.daily) cel.push(`<div ${H('uv')}><b>${dec(met.daily.uv_index_max[0], 0)}</b>Índice UV máximo de hoy</div>`);
  $('vivo').innerHTML = cel.length ? cel.join('') : '<div>Sin conexión con Open-Meteo.</div>';
  if (c) $('vivoHora').textContent = c.time.slice(11, 16) + ' h';
}
cargaVivo();
setInterval(cargaVivo, 15 * 60 * 1000);

// ------------------------------------------------------------------ simulación: subida del nivel del mar
let nivel = 0, inundados = new Set(), versionSim = 0, temporizador = null;
const simActiva = () => $('cSim').checked;
const NOTA_SIM = `Modelo de “bañera”: se inunda toda la tierra con cota inferior al nivel elegido, aunque no esté conectada con el mar,
  y no tiene en cuenta diques, paseos marítimos ni el oleaje. La cota es la del relieve del gemelo (Terrain Tiles de AWS, de resolución
  limitada y con un error vertical de varios metros): sirve para explorar escenarios, no para delimitar zonas de riesgo. Para eso, el
  <a target="_blank" href="https://sig.mapama.gob.es/snczi/">SNCZI</a> de MITECO. Los recuentos son de los edificios de la vista actual
  (cota en el centro del edificio).`;

function pintaNivel() {
  $('simN').textContent = `+${dec(nivel)} m`;
  $('simR').value = nivel;
  map.getSource('inunda').setTiles([`inunda://{z}/{x}/{y}?n=${nivel}`]);
  programaRecuento();
}
// recuenta cuando el mapa termine de cargar las teselas de edificios de la vista
function programaRecuento() {
  clearTimeout(temporizador);
  temporizador = setTimeout(() => {
    if (map.areTilesLoaded()) return cuentaAfectados();
    let hecho = false;
    const una = () => { if (!hecho) { hecho = true; cuentaAfectados(); } };
    map.once('idle', una); setTimeout(una, 3000);       // por si el mapa no llega a quedar en reposo
  }, 300);
}

async function cuentaAfectados() {
  const v = ++versionSim;
  if (!simActiva() || nivel <= 0) return marcaInundados(new Set(), v, null);
  if (map.getZoom() < 13) {
    ['simE', 'simV', 'simT'].forEach(id => $(id).textContent = '–');
    $('simNota').innerHTML = '<b>Acércate (zoom ≥ 13) para contar los edificios afectados.</b><br>' + NOTA_SIM;
    return marcaInundados(new Set(), v, null);
  }
  const b = map.getBounds(), porRc = new Map();
  for (const f of map.querySourceFeatures('edif', { sourceLayer: 'edificios' })) {
    const g = f.geometry, anillo = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
    if (!anillo) continue;
    let lng = 0, lat = 0;
    for (const [x, y] of anillo) { lng += x; lat += y; }
    lng /= anillo.length; lat /= anillo.length;
    if (!b.contains([lng, lat])) continue;
    const rc = f.properties.rc, e = porRc.get(rc) || { viv: f.properties.viv || 0, pts: [] };
    e.pts.push([lng, lat]); porRc.set(rc, e);
  }
  const res = new Set();
  let viv = 0, vut = 0;
  await Promise.all([...porRc].map(async ([rc, e]) => {
    const cotas = (await Promise.all(e.pts.map(([x, y]) => cotaEn(x, y)))).filter(h => h != null);
    if (cotas.length && Math.min(...cotas) <= nivel) { res.add(rc); viv += e.viv; vut += vutPorParcela.get(rc)?.n || 0; }
  }));
  marcaInundados(res, v, { edif: res.size, viv, vut, vistos: porRc.size });
}

function marcaInundados(nuevos, v, r) {
  if (v !== versionSim) return;                       // ha llegado otra petición más reciente
  for (const rc of inundados) if (!nuevos.has(rc)) map.setFeatureState({ source: 'edif', sourceLayer: 'edificios', id: rc }, { inund: false });
  for (const rc of nuevos) if (!inundados.has(rc)) map.setFeatureState({ source: 'edif', sourceLayer: 'edificios', id: rc }, { inund: true });
  inundados = nuevos;
  if (!r) return;
  $('simE').textContent = fmt(r.edif); $('simV').textContent = fmt(r.viv); $('simT').textContent = fmt(r.vut);
  $('simNota').innerHTML = `En magenta, edificios afectados (de ${fmt(r.vistos)} en la vista).<br>` + NOTA_SIM;
}

$('cSim').onchange = e => {
  const on = e.target.checked;
  $('simCtl').classList.toggle('off', !on);
  map.setLayoutProperty('inunda', 'visibility', on ? 'visible' : 'none');
  if (on) {
    if (!nivel) nivel = 0.8;
    pintaNivel();
    if (map.getZoom() < 14) map.flyTo({ center: [-4.9523, 36.4864], zoom: 15.6, pitch: 58, bearing: -15, duration: 2500 });
  } else cuentaAfectados();
};
$('simR').oninput = e => { nivel = parseFloat(e.target.value); pintaNivel(); };
$('simPre').onclick = e => { if (!e.target.dataset.n) return; nivel = parseFloat(e.target.dataset.n); pintaNivel(); };
map.on('moveend', () => { if (simActiva()) programaRecuento(); });
$('simNota').innerHTML = NOTA_SIM;

$('toggle').onclick =() => { $('panel').classList.toggle('min'); $('toggle').textContent = $('panel').classList.contains('min') ? 'mostrar' : 'ocultar'; };
