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
maplibregl.addProtocol('relieve', async (params, abort) => {
  const [z, x, y] = params.url.replace('relieve://', '').split('/').map(Number);
  const t = await relievePm.getZxy(z, x, y, abort.signal);
  if (t && t.data) return { data: t.data };
  const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, { signal: abort.signal });
  if (!r.ok) throw new Error(`Relieve ${z}/${x}/${y}: ${r.status}`);
  return { data: await r.arrayBuffer() };
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
  map.setPaintProperty('edificios', 'fill-extrusion-color', ['case', SEL, '#1044CD', MODOS[m].color]);
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
    Indicadores: observatorios municipales de Marbella, sincronizados cada día.`;
}

fetch('data/observatorios.json').then(r => r.json()).then(d => {
  $('obs').innerHTML = d.observatorios.map(o => `
    <div class="obs">
      <div class="t"><a target="_blank" href="${esc(o.url)}">${esc(o.nombre)} ↗</a>
        <small class="${o.ok ? '' : 'ko'}">${o.ok ? '' : 'sin conexión · último dato'}</small></div>
      <div class="k">${o.kpis.slice(0, 4).map(k => `<div><b>${fmt(k.valor)}${k.unidad && k.unidad.length < 4 ? ' ' + esc(k.unidad) : ''}</b>${esc(k.etiqueta)}${k.periodo ? ` · ${esc(k.periodo)}` : ''}</div>`).join('')}</div>
    </div>`).join('') + `<div class="src">Sincronizado el ${new Date(d.actualizado.replace('Z', ':00Z')).toLocaleDateString('es-ES')}.</div>`;
}).catch(() => { $('obs').innerHTML = '<div class="src">No se han podido cargar los indicadores.</div>'; });

$('toggle').onclick = () => { $('panel').classList.toggle('min'); $('toggle').textContent = $('panel').classList.contains('min') ? 'mostrar' : 'ocultar'; };
