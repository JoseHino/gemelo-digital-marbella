// Histórico y cruce de datos de tiempo, mar y aire (Open-Meteo), al pinchar en el panel "Ahora en Marbella".
// Tiempo: reanálisis ERA5 (archive-api) + previsión para los últimos días que el reanálisis aún no tiene.
// Mar y aire: sus API admiten start_date/end_date hasta hoy. Se pide horario y se agrega a diario en el navegador.

const HVARS = {
  temp:    { t: 'Temperatura del aire', u: '°C', api: 'met', v: 'temperature_2m' },
  sens:    { t: 'Sensación térmica', u: '°C', api: 'met', v: 'apparent_temperature' },
  hum:     { t: 'Humedad relativa', u: '%', api: 'met', v: 'relative_humidity_2m' },
  lluvia:  { t: 'Precipitación', u: 'mm', api: 'met', v: 'precipitation', agg: 'suma' },
  viento:  { t: 'Velocidad del viento', u: 'km/h', api: 'met', v: 'wind_speed_10m' },
  rachas:  { t: 'Rachas de viento', u: 'km/h', api: 'met', v: 'wind_gusts_10m', agg: 'max' },
  dirv:    { t: 'Dirección del viento', u: '°', api: 'met', v: 'wind_direction_10m', agg: 'dir' },
  ola:     { t: 'Altura del oleaje', u: 'm', api: 'mar', v: 'wave_height' },
  periodo: { t: 'Periodo del oleaje', u: 's', api: 'mar', v: 'wave_period' },
  dirola:  { t: 'Dirección del oleaje', u: '°', api: 'mar', v: 'wave_direction', agg: 'dir' },
  sst:     { t: 'Temperatura del agua del mar', u: '°C', api: 'mar', v: 'sea_surface_temperature' },
  ica:     { t: 'Calidad del aire (índice europeo)', u: '', api: 'aire', v: 'european_aqi' },
  no2:     { t: 'Dióxido de nitrógeno (NO₂)', u: 'µg/m³', api: 'aire', v: 'nitrogen_dioxide' },
  pm10:    { t: 'Partículas PM10', u: 'µg/m³', api: 'aire', v: 'pm10' },
  pm25:    { t: 'Partículas PM2,5', u: 'µg/m³', api: 'aire', v: 'pm2_5' },
  o3:      { t: 'Ozono (O₃)', u: 'µg/m³', api: 'aire', v: 'ozone' },
  uv:      { t: 'Índice UV', u: '', api: 'aire', v: 'uv_index', agg: 'max' },
};
const GRUPOS = [['Tiempo', ['temp', 'sens', 'hum', 'lluvia', 'viento', 'rachas', 'dirv']],
                ['Mar', ['sst', 'ola', 'periodo', 'dirola']],
                ['Aire', ['ica', 'no2', 'pm10', 'pm25', 'o3', 'uv']]];
const H_API = {
  met:  { url: 'https://archive-api.open-meteo.com/v1/archive', pt: 'latitude=36.505&longitude=-4.886', fuente: 'reanálisis ERA5 (Copernicus) y previsión de Open-Meteo' },
  mar:  { url: 'https://marine-api.open-meteo.com/v1/marine', pt: 'latitude=36.49&longitude=-4.88', fuente: 'modelos marinos de Open-Meteo (Copernicus Marine y otros)' },
  aire: { url: 'https://air-quality-api.open-meteo.com/v1/air-quality', pt: 'latitude=36.505&longitude=-4.886', fuente: 'CAMS Europa (Copernicus)' },
};
const RANGOS = [[7, '7 días'], [30, '30 días'], [365, '1 año'], [1095, '3 años']];
const DIA = 86400000;
// colores de serie (paleta categórica validada, posiciones 1 y 2)
const C_A = '#2a78d6', C_B = '#eb6834';

// ------------------------------------------------------------------ fechas (todo en hora local de Madrid, tratado como UTC "ingenuo")
const ms = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +(s.slice(11, 13) || 0), +(s.slice(14, 16) || 0));
const hoyMadrid = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};
const iso = t => new Date(t).toISOString().slice(0, 10);
const fFecha = (t, op) => new Date(t).toLocaleDateString('es-ES', { timeZone: 'UTC', ...op });
const fHora = t => fFecha(t, { day: 'numeric', month: 'short' }) + ' ' + new Date(t).toISOString().slice(11, 16) + ' h';

// ------------------------------------------------------------------ descarga (una petición por API y rango; caché)
const cacheH = new Map();
function descargaApi(api, dias) {
  const k = `${api}|${dias}`;
  if (cacheH.has(k)) return cacheH.get(k);
  const ahora = hoyMadrid(), fin = ahora.slice(0, 10), ini = iso(ms(fin) - dias * DIA);
  const vars = Object.values(HVARS).filter(x => x.api === api).map(x => x.v).join(',');
  const A = H_API[api], tz = 'timezone=Europe%2FMadrid';
  const pide = u => fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error(`${api}: HTTP ${r.status}`)));
  const p = (async () => {
    const peticiones = [pide(`${A.url}?${A.pt}&start_date=${ini}&end_date=${fin}&hourly=${vars}&${tz}`)];
    // el reanálisis llega con unos días de retraso: los últimos días salen de la previsión
    if (api === 'met') peticiones.push(pide(`https://api.open-meteo.com/v1/forecast?${A.pt}&past_days=10&forecast_days=1&hourly=${vars}&${tz}`));
    const [base, extra] = await Promise.all(peticiones);
    const lim = ms(ahora), serie = {};
    for (const v of vars.split(',')) {
      const m = new Map();
      for (const d of [base, extra]) {
        if (!d?.hourly?.[v]) continue;
        d.hourly.time.forEach((t, i) => {
          const x = d.hourly[v][i], tt = ms(t);
          if (x != null && tt <= lim && tt >= ms(ini) && !m.has(tt)) m.set(tt, x);
        });
      }
      serie[v] = m;
    }
    return serie;
  })();
  p.catch(() => cacheH.delete(k));
  cacheH.set(k, p);
  return p;
}

// serie [{t, y}] de una variable: horaria si el rango es corto, diaria si es largo
async function serieDe(id, dias) {
  const V = HVARS[id], m = (await descargaApi(V.api, dias))[V.v];
  const horas = [...m].sort((a, b) => a[0] - b[0]);
  if (dias <= 30) return horas.map(([t, y]) => ({ t, y }));
  const porDia = new Map();
  for (const [t, y] of horas) { const d = t - t % DIA; (porDia.get(d) || porDia.set(d, []).get(d)).push(y); }
  return [...porDia].map(([t, ys]) => ({ t, y: agrega(ys, V.agg) }));
}
function agrega(ys, agg) {
  if (agg === 'suma') return ys.reduce((a, b) => a + b, 0);
  if (agg === 'max') return Math.max(...ys);
  if (agg === 'dir') {                                       // media circular de ángulos
    let s = 0, c = 0;
    for (const g of ys) { s += Math.sin(g * Math.PI / 180); c += Math.cos(g * Math.PI / 180); }
    return (Math.atan2(s, c) * 180 / Math.PI + 360) % 360;
  }
  return ys.reduce((a, b) => a + b, 0) / ys.length;
}

// ------------------------------------------------------------------ interfaz
const hs = { a: 'temp', b: '', dias: 30, lag: 0, anom: false, graficos: {}, datos: null };
const SECTORES = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const SECTOR_TXT = { E: 'E · levante', O: 'O · poniente' };
function fv(y, V) {
  if (y == null || isNaN(y)) return '–';
  if (V.agg === 'dir') return `${Math.round(y)}° (${SECTORES[Math.round(y / 45) % 8]})`;
  if (Math.abs(y) < 0.05) y = 0;                          // evita "-0"
  return (V.anom && y > 0 ? '+' : '') + y.toLocaleString('es-ES', { maximumFractionDigits: Math.abs(y) < 10 ? 1 : 0 }) + (V.u ? ' ' + V.u : '');
}

function opcionesSelect(sel, conNinguna) {
  sel.innerHTML = (conNinguna ? '<option value="">— ninguno —</option>' : '') +
    GRUPOS.map(([g, ids]) => `<optgroup label="${g}">${ids.map(i => `<option value="${i}">${esc(HVARS[i].t)}</option>`).join('')}</optgroup>`).join('');
}
opcionesSelect($('hA'), false);
opcionesSelect($('hB'), true);
$('hRango').innerHTML = RANGOS.map(([d, t]) => `<button data-d="${d}">${t}</button>`).join('');

function abreHistorico(id) {
  hs.a = id; $('hA').value = id;
  $('hist').hidden = false;
  document.body.style.overflow = 'hidden';
  dibuja();
}
function cierraHistorico() { $('hist').hidden = true; document.body.style.overflow = ''; }
$('hist').addEventListener('click', e => { if (e.target.id === 'hist' || e.target.closest('.hx')) cierraHistorico(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('hist').hidden) cierraHistorico(); });
$('hRango').onclick = e => { if (e.target.dataset.d) { hs.dias = +e.target.dataset.d; dibuja(); } };
$('hA').onchange = e => { hs.a = e.target.value; dibuja(); };
$('hB').onchange = e => { hs.b = e.target.value; dibuja(); };
$('hLag').onchange = e => { hs.lag = +e.target.value; dibuja(); };
$('hAnom').onchange = e => { hs.anom = e.target.checked; dibuja(); };
$('hSwap').onclick = () => { if (!hs.b) return; [hs.a, hs.b] = [hs.b, hs.a]; $('hA').value = hs.a; $('hB').value = hs.b; dibuja(); };
// las tarjetas del panel abren el histórico de su dato
$('vivo').addEventListener('click', e => { const c = e.target.closest('[data-h]'); if (c) abreHistorico(c.dataset.h); });
$('vivo').addEventListener('keydown', e => { const c = e.target.closest('[data-h]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); abreHistorico(c.dataset.h); } });

let turno = 0;
async function dibuja() {
  const yo = ++turno;
  let A = HVARS[hs.a], B = hs.b ? HVARS[hs.b] : null;
  document.querySelectorAll('#hRango button').forEach(b => b.classList.toggle('on', +b.dataset.d === hs.dias));
  $('hLagL').hidden = !B; $('hSwap').hidden = !B; $('hAnomL').hidden = hs.dias < 365;
  $('cajaB').hidden = !B; $('cajaX').hidden = !B;
  $('hTit').textContent = B ? `${A.t} y ${B.t.toLowerCase()}` : A.t;
  $('hist').classList.add('cargando');
  $('hAviso').textContent = '';
  let sa, sb;
  try {
    [sa, sb] = await Promise.all([serieDe(hs.a, hs.dias), B ? serieDe(hs.b, hs.dias) : null]);
  } catch (err) {
    if (yo === turno) { $('hAviso').textContent = 'No se han podido descargar los datos de Open-Meteo. Prueba de nuevo en un momento.'; $('hist').classList.remove('cargando'); }
    return;
  }
  if (yo !== turno) return;
  $('hist').classList.remove('cargando');
  const diario = hs.dias > 30;
  // sin estacionalidad: cada día menos la media de su mes del año en el periodo (no se aplica a direcciones)
  if (hs.anom && hs.dias >= 365) {
    [sa, A] = anomalia(sa, A);
    if (B) [sb, B] = anomalia(sb, B);
  }
  hs.datos = { sa, sb, A, B };
  if (A.anom) $('hTit').textContent += ' · sin estacionalidad';

  // aviso si una serie empieza más tarde que el rango (oleaje desde 2021, agua del mar desde 2022…)
  const ini = ms(hoyMadrid().slice(0, 10)) - hs.dias * DIA, avisos = [];
  for (const [s, V] of [[sa, A], [sb, B]]) {
    if (!V) continue;
    if (!s.length) avisos.push(`No hay datos de ${V.t.toLowerCase()} en este periodo.`);
    else if (s[0].t - ini > 20 * DIA) avisos.push(`${V.t}: solo hay datos desde ${fFecha(s[0].t, { month: 'long', year: 'numeric' })}.`);
  }
  $('hAviso').textContent = avisos.join(' ');

  resumen(sa, A);
  grafSerie('gA', sa, A, C_A, diario);
  if (B) {
    grafSerie('gB', sb, B, C_B, diario);
    grafCruce(sa, sb, A, B, diario);
  } else ['gB', 'gX'].forEach(k => { hs.graficos[k]?.destroy(); delete hs.graficos[k]; });
  const apis = [...new Set([A.api, B?.api].filter(Boolean))];
  $('hFuente').innerHTML = `Fuente: <a target="_blank" href="https://open-meteo.com/">Open-Meteo</a>, ${apis.map(a => H_API[a].fuente).join('; ')}.
    Punto de modelo frente a Marbella; ${diario ? 'valores diarios (media; máximo para rachas y UV; suma para la lluvia)' : 'valores horarios'}.`;
}

function anomalia(s, V) {
  if (V.agg === 'dir' || !s.length) return [s, V];
  const mes = t => new Date(t).getUTCMonth(), suma = new Array(12).fill(0), n = new Array(12).fill(0);
  for (const p of s) { suma[mes(p.t)] += p.y; n[mes(p.t)]++; }
  return [s.map(p => ({ t: p.t, y: p.y - suma[mes(p.t)] / n[mes(p.t)] })), { ...V, anom: true }];
}

function resumen(s, V) {
  if (!s.length) { $('hStats').innerHTML = ''; return; }
  const ult = s[s.length - 1];
  if (V.agg === 'dir') {
    const n = new Array(8).fill(0);
    s.forEach(p => n[Math.round(p.y / 45) % 8]++);
    const top = n.map((c, i) => [c, i]).sort((a, b) => b[0] - a[0]).slice(0, 2);
    $('hStats').innerHTML = `<div><b>${fv(ult.y, V)}</b>último dato</div>` +
      top.map(([c, i]) => `<div><b>${SECTOR_TXT[SECTORES[i]] || SECTORES[i]}</b>${Math.round(c / s.length * 100)} % del tiempo</div>`).join('');
    return;
  }
  let mn = s[0], mx = s[0], suma = 0;
  for (const p of s) { if (p.y < mn.y) mn = p; if (p.y > mx.y) mx = p; suma += p.y; }
  const f = hs.dias > 30 ? t => fFecha(t, { day: 'numeric', month: 'short', year: 'numeric' }) : fHora;
  $('hStats').innerHTML = `<div><b>${fv(ult.y, V)}</b>último dato</div><div><b>${fv(suma / s.length, V)}</b>media del periodo</div>
    <div><b>${fv(mn.y, V)}</b>mínimo · ${f(mn.t)}</div><div><b>${fv(mx.y, V)}</b>máximo · ${f(mx.t)}</div>`;
}

const ejeTiempo = diario => ({
  type: 'linear', grid: { display: false },
  ticks: { maxTicksLimit: 7, color: '#646b73', callback: t => diario ? fFecha(t, { month: 'short', year: '2-digit' }) : fFecha(t, { day: 'numeric', month: 'short' }) },
});
const ejeValor = V => V.agg === 'dir'
  ? { min: 0, max: 360, ticks: { stepSize: 90, color: '#646b73', callback: g => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'O', 360: 'N' })[g] ?? '' }, grid: { color: '#eef0f2' } }
  : { beginAtZero: ['lluvia', 'ica', 'uv'].includes(Object.keys(HVARS).find(k => HVARS[k] === V)), grid: { color: '#eef0f2' },
      ticks: { color: '#646b73' }, title: { display: !!V.u, text: V.u, color: '#646b73' } };

function grafSerie(id, s, V, color, diario) {
  hs.graficos[id]?.destroy();
  const dir = V.agg === 'dir';
  hs.graficos[id] = new Chart($(id), {
    type: dir ? 'scatter' : 'line',
    data: { datasets: [{ label: V.t, data: s.map(p => ({ x: p.t, y: p.y })), borderColor: color, backgroundColor: color,
      borderWidth: 2, pointRadius: dir ? (s.length > 400 ? 1.5 : 2.5) : 0, pointHoverRadius: 5, tension: 0.15, spanGaps: false }] },
    options: {
      animation: false, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: 'index', axis: 'x', intersect: false },
      plugins: { legend: { display: false }, title: { display: !!hs.b || V.anom, text: V.t + (V.anom ? ' · diferencia con la media de su mes' : ''), align: 'start', color: '#222', font: { size: 12, weight: '600' } },
        tooltip: { callbacks: { title: it => diario ? fFecha(it[0].parsed.x, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : fHora(it[0].parsed.x),
          label: it => ` ${fv(it.parsed.y, V)}` } } },
      scales: { x: { ...ejeTiempo(diario), min: s[0]?.t, max: s[s.length - 1]?.t }, y: ejeValor(V) },
    },
  });
}

// pares (A en t, B en t + desfase)
function pares(sa, sb) {
  const mb = new Map(sb.map(p => [p.t, p.y])), d = hs.lag * DIA, out = [];
  for (const p of sa) { const y = mb.get(p.t + d); if (y != null) out.push({ a: p.y, b: y, t: p.t }); }
  return out;
}
function pearson(ps) {
  const n = ps.length; if (n < 3) return null;
  let sa = 0, sb = 0; for (const p of ps) { sa += p.a; sb += p.b; }
  const ma = sa / n, mb = sb / n; let c = 0, va = 0, vb = 0;
  for (const p of ps) { c += (p.a - ma) * (p.b - mb); va += (p.a - ma) ** 2; vb += (p.b - mb) ** 2; }
  return va && vb ? c / Math.sqrt(va * vb) : null;
}
const fuerza = r => { const a = Math.abs(r); return a < 0.1 ? 'sin relación apreciable' : a < 0.3 ? 'relación débil' : a < 0.6 ? 'relación moderada' : 'relación fuerte'; };

function grafCruce(sa, sb, A, B, diario) {
  hs.graficos.gX?.destroy();
  const ps = pares(sa, sb), lagTxt = hs.lag ? ` (${B.t.toLowerCase()} ${hs.lag === 1 ? '1 día' : hs.lag + ' días'} después)` : '';
  const dirA = A.agg === 'dir', dirB = B.agg === 'dir';
  if (dirA !== dirB) {
    // una dirección y una magnitud: media de la magnitud por rumbo (gráfico de puntos, el eje no tiene por qué empezar en 0)
    const [D, M] = dirA ? [A, B] : [B, A], g = new Array(8).fill(0).map(() => []);
    for (const p of ps) { const [d, m] = dirA ? [p.a, p.b] : [p.b, p.a]; g[Math.round(d / 45) % 8].push(m); }
    const filas = g.map((ys, i) => ({ x: SECTOR_TXT[SECTORES[i]] || SECTORES[i], y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null, n: ys.length }));
    const total = ps.length, conDatos = filas.filter(f => f.n >= Math.max(3, total * 0.02));
    $('xTit').textContent = `${M.t}${M.anom ? ' (diferencia con la media del mes)' : ''} media según la ${D.t.toLowerCase()}${lagTxt}`;
    hs.graficos.gX = new Chart($('gX'), {
      type: 'line',
      data: { labels: filas.map(f => f.x), datasets: [{ data: filas.map(f => conDatos.includes(f) ? f.y : null), showLine: false,
        pointRadius: filas.map(f => 4 + Math.min(8, Math.sqrt(f.n / Math.max(1, total)) * 20)), pointHoverRadius: 10,
        backgroundColor: C_A, borderColor: '#fff', borderWidth: 2 }] },
      options: { animation: false, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: it => ` ${fv(it.parsed.y, M)} · ${filas[it.dataIndex].n} ${diario ? 'días' : 'horas'} (${Math.round(filas[it.dataIndex].n / total * 100)} %)` } } },
        scales: { x: { offset: true, grid: { display: false }, ticks: { color: '#646b73' } }, y: { ...ejeValor(M), beginAtZero: false } } },
    });
    const orden = conDatos.filter(f => f.y != null).sort((a, b) => b.y - a.y);
    $('xNota').innerHTML = orden.length >= 2
      ? `Con ${D.v === 'wave_direction' ? 'oleaje' : 'viento'} del <b>${esc(orden[0].x)}</b> la media es <b>${fv(orden[0].y, M)}</b>; del <b>${esc(orden[orden.length - 1].x)}</b>, <b>${fv(orden[orden.length - 1].y, M)}</b>${M.anom ? ' respecto a lo normal en ese mes' : ''}.
         El tamaño del punto indica cuántas ${diario ? 'jornadas' : 'horas'} hubo de cada rumbo; se omiten los rumbos con muy pocos datos. ${ps.length} pares de datos.
         ${hs.dias >= 365 && !M.anom ? '<br>Ojo: en periodos largos parte de la diferencia se debe a la estación del año (cada rumbo es más frecuente en unos meses). Marca <b>Quitar la estacionalidad</b> para ver solo el efecto del viento.' : ''}`
      : 'No hay suficientes datos coincidentes para cruzar.';
    return;
  }
  // dos magnitudes (o dos direcciones): dispersión y correlación
  const r = pearson(ps);
  $('xTit').textContent = `${B.t} frente a ${A.t.toLowerCase()}${lagTxt}`;
  hs.graficos.gX = new Chart($('gX'), {
    type: 'scatter',
    data: { datasets: [{ data: ps.map(p => ({ x: p.a, y: p.b, t: p.t })), backgroundColor: C_A + '66', borderColor: C_A + '99',
      pointRadius: ps.length > 2000 ? 2 : 3.5, pointHoverRadius: 7, pointHitRadius: 8 }] },
    options: { animation: false, maintainAspectRatio: false, parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: it => diario ? fFecha(it[0].raw.t, { day: 'numeric', month: 'short', year: 'numeric' }) : fHora(it[0].raw.t),
        label: it => [` ${A.t}: ${fv(it.parsed.x, A)}`, ` ${B.t}: ${fv(it.parsed.y, B)}`] } } },
      scales: { x: { ...ejeValor(A), title: { display: true, text: A.t + (A.u && A.agg !== 'dir' ? ` (${A.u})` : ''), color: '#646b73' } },
                y: { ...ejeValor(B), title: { display: true, text: B.t + (B.u && B.agg !== 'dir' ? ` (${B.u})` : ''), color: '#646b73' } } } },
  });
  $('xNota').innerHTML = r == null ? 'No hay suficientes datos coincidentes para cruzar.'
    : `Correlación de Pearson <b>r = ${r.toLocaleString('es-ES', { maximumFractionDigits: 2 })}</b>: ${fuerza(r)}${Math.abs(r) >= 0.1 ? (r > 0 ? ', suben a la vez' : ', cuando uno sube el otro baja') : ''}.
       ${ps.length} pares de datos. Una correlación no demuestra que una cosa cause la otra (por ejemplo, ambas pueden seguir a la estación del año).`;
}

$('hCsv').onclick = () => {
  if (!hs.datos) return;
  const { A, B } = hs.datos, diario = hs.dias > 30;
  const mb = new Map((hs.datos.sb || []).map(p => [p.t, p.y]));
  const cab = ['fecha', `${A.t}${A.u ? ` (${A.u})` : ''}`, ...(B ? [`${B.t}${B.u ? ` (${B.u})` : ''}`] : [])];
  const filas = hs.datos.sa.map(p => [diario ? iso(p.t) : new Date(p.t).toISOString().slice(0, 16).replace('T', ' '),
    String(+p.y.toFixed(2)).replace('.', ','), ...(B ? [mb.has(p.t) ? String(+mb.get(p.t).toFixed(2)).replace('.', ',') : ''] : [])]);
  const csv = '﻿' + [cab, ...filas].map(f => f.map(c => /[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `marbella_${hs.a}${B ? '_' + hs.b : ''}_${hs.dias}d${A.anom ? '_sin_estacionalidad' : ''}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
