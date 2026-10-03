// Sol y sombras: posición del sol (fórmulas de SunCalc) y sombra de cada edificio de la vista.
// La sombra de un cuerpo de edificio es la envolvente convexa de su planta y de la planta desplazada
// h / tan(altura del sol) en sentido contrario al sol. Se dibuja sobre el terreno (no tiene en cuenta
// la pendiente ni la sombra del relieve). La iluminación de los edificios 3D se orienta con el mismo sol.

const RAD = Math.PI / 180, DIA_J = 86400000, J1970 = 2440588, J2000 = 2451545, OBLICUIDAD = 23.4397 * RAD;
function posicionSol(fecha, lat, lon) {
  const d = fecha.valueOf() / DIA_J - 0.5 + J1970 - J2000;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OBLICUIDAD) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(OBLICUIDAD), Math.cos(L));
  const H = RAD * (280.16 + 360.9856235 * d) - RAD * -lon - ra, phi = RAD * lat;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)); // desde el sur, positivo al oeste
  return { alt, az: (az / RAD + 180 + 360) % 360 };                                              // acimut desde el norte
}

// hora local de Madrid -> Date (con el horario de verano correcto para ese día)
function fechaMadrid(anio, diaDelAnio, horaDecimal) {
  const base = Date.UTC(anio, 0, 1) + (diaDelAnio - 1) * DIA_J + horaDecimal * 3600000;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(base)).map(x => [x.type, x.value]));
  const off = +(p.timeZoneName.match(/GMT([+-]\d+)/)?.[1] || 1);
  return new Date(base - off * 3600000);
}

function envolvente(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cruz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inf = [], sup = [];
  for (const p of pts) { while (inf.length >= 2 && cruz(inf[inf.length - 2], inf[inf.length - 1], p) <= 0) inf.pop(); inf.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (sup.length >= 2 && cruz(sup[sup.length - 2], sup[sup.length - 1], p) <= 0) sup.pop(); sup.push(p); }
  const h = inf.slice(0, -1).concat(sup.slice(0, -1));
  h.push(h[0]);
  return h;
}

const sol = { activo: false, dia: 172, hora: 17, anio: new Date().getFullYear() };
let tSombras = null;

function sombrasVista() {
  if (!sol.activo) return;
  const f = fechaMadrid(sol.anio, sol.dia, sol.hora), c = map.getCenter(), s = posicionSol(f, c.lat, c.lng);
  const altG = s.alt / RAD;
  $('solTxt').innerHTML = altG <= 0 ? 'El sol está bajo el horizonte'
    : `Sol a <b>${Math.round(altG)}°</b> de altura, desde el <b>${RUMBO(s.az)}</b> (${Math.round(s.az)}°)`;
  // luz de los edificios 3D orientada como el sol
  map.setLight({ anchor: 'map', position: [1.5, s.az, Math.max(10, 90 - Math.max(altG, 0))], intensity: altG > 0 ? 0.45 : 0.15,
                 color: altG > 0 && altG < 12 ? '#ffd9a8' : '#ffffff' });
  if (altG <= 0.5 || map.getZoom() < 14.5) {
    map.getSource('sombras').setData({ type: 'FeatureCollection', features: [] });
    if (altG > 0.5) $('solTxt').innerHTML += '<br><span class="sub">Acércate (zoom ≥ 14,5) para ver las sombras.</span>';
    return;
  }
  // desplazamiento por metro de altura, en grados (sentido contrario al sol)
  const largo = 1 / Math.tan(s.alt), az = (s.az + 180) * RAD;
  const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(c.lat * RAD));
  const dx = Math.sin(az) * largo * mLon, dy = Math.cos(az) * largo * mLat;
  const b = map.getBounds(), feats = [];
  for (const ft of map.querySourceFeatures('edif', { sourceLayer: 'edificios' })) {
    const h = ft.properties.h, g = ft.geometry;
    if (!h) continue;
    const anillos = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : [];
    for (const r of anillos) {
      if (!b.contains(r[0])) continue;
      const pts = r.concat(r.map(([x, y]) => [x + dx * h, y + dy * h]));
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [envolvente(pts)] } });
    }
  }
  map.getSource('sombras').setData({ type: 'FeatureCollection', features: feats });
}
const programaSombras = () => { clearTimeout(tSombras); tSombras = setTimeout(sombrasVista, 150); };

const fmtDia = d => new Date(Date.UTC(sol.anio, 0, d)).toLocaleDateString('es-ES', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const fmtHora = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round(h % 1 * 60)).padStart(2, '0')}`;
function pintaSol() {
  $('solDia').value = sol.dia; $('solHora').value = sol.hora;
  $('solDiaTxt').textContent = fmtDia(sol.dia); $('solHoraTxt').textContent = fmtHora(sol.hora) + ' h';
  programaSombras();
}
$('cSol').onchange = e => {
  sol.activo = e.target.checked;
  $('solCtl').classList.toggle('off', !sol.activo);
  map.setLayoutProperty('sombras', 'visibility', sol.activo ? 'visible' : 'none');
  if (!sol.activo) { map.setLight({ anchor: 'viewport', position: [1.15, 210, 30], intensity: 0.5, color: '#ffffff' }); return; }
  if (map.getZoom() < 15) map.flyTo({ center: [-4.8858, 36.5098], zoom: 16.4, pitch: 55, bearing: -20, duration: 2500 });
  pintaSol();
};
$('solDia').oninput = e => { sol.dia = +e.target.value; pintaSol(); };
$('solHora').oninput = e => { sol.hora = +e.target.value; pintaSol(); };
$('solPre').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.ahora) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false })
      .formatToParts(new Date()).map(x => [x.type, +x.value]));
    sol.anio = p.year; sol.dia = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(p.year, 0, 1)) / DIA_J) + 1;
    sol.hora = Math.min(21.75, Math.max(6, p.hour % 24 + Math.round(p.minute / 15) / 4));
  } else { sol.dia = +b.dataset.dia; if (b.dataset.hora) sol.hora = +b.dataset.hora; }
  pintaSol();
};
map.on('moveend', programaSombras);
map.on('sourcedata', e => { if (sol.activo && e.sourceId === 'edif' && e.isSourceLoaded) programaSombras(); });
