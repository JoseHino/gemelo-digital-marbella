// Población flotante a partir de los residuos: población equivalente = residuos recogidos en el mes (resto + selectiva)
// / tasa de generación por habitante de la Junta de Andalucía (Informe de Medio Ambiente, kg/hab·año) prorrateada a los
// días del mes; población flotante = equivalente − empadronados (INE). Datos del observatorio de residuos de Marbella.

const URL_RESIDUOS = `${GH}/observatorio-residuos-marbella/`;
const PF = { d: null, i: 0, graf: null };
const mesTxt = x => new Date(Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, 1)).toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const mayus = t => t.charAt(0).toUpperCase() + t.slice(1);

async function iniciaPoblacion() {
  try {
    const t = await (await fetch(`${URL_RESIDUOS}data/data.js`)).text();
    PF.d = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  } catch (err) {
    $('pfNota').innerHTML = 'No se han podido cargar los datos del observatorio de residuos.';
    return;
  }
  const p = PF.d.poblacion;
  $('pfMes').max = p.x.length - 1;
  $('pfMes').value = PF.i = p.x.length - 1;
  dibujaPoblacion();
  muestraMes(PF.i);
}

function dibujaPoblacion() {
  const p = PF.d.poblacion;
  PF.graf = new Chart($('pfG'), {
    type: 'line',
    data: { labels: p.x, datasets: [
      { label: 'Población equivalente', data: p.equivalente, borderColor: '#2a78d6', backgroundColor: '#2a78d6',
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
      { label: 'Empadronados', data: p.censo, borderColor: '#9aa1a9', backgroundColor: '#9aa1a9',
        borderWidth: 2, borderDash: [4, 3], pointRadius: 0, stepped: true },
      { label: 'Mes elegido', data: [], showLine: false, pointRadius: 5, pointBackgroundColor: '#2a78d6', pointBorderColor: '#fff', pointBorderWidth: 2 },
    ] },
    options: { animation: false, maintainAspectRatio: false,
      interaction: { mode: 'index', axis: 'x', intersect: false },
      plugins: { legend: { display: false }, tooltip: { filter: it => it.datasetIndex < 2, callbacks: {
        title: it => mesTxt(p.x[it[0].dataIndex]), label: it => ` ${it.dataset.label}: ${fmt(it.parsed.y)}` } } },
      scales: { x: { grid: { display: false }, ticks: { color: '#646b73', font: { size: 10 }, autoSkip: false, maxRotation: 0,
                       callback: (v, n) => p.x[n].endsWith('-01') ? p.x[n].slice(0, 4) : '' } },
                y: { grid: { color: '#eef0f2' }, ticks: { color: '#646b73', font: { size: 10 }, maxTicksLimit: 5, callback: v => fmt(v / 1000) + ' mil' } } },
      onClick: (ev, el) => { if (el.length) muestraMes(el[0].index); } },
  });
}

function muestraMes(i) {
  const p = PF.d.poblacion, a = PF.d.poblacion_anual, x = p.x[i];
  PF.i = i; $('pfMes').value = i;
  $('pfMesTxt').textContent = mayus(mesTxt(x));
  $('pfEq').textContent = fmt(p.equivalente[i]);
  $('pfFl').textContent = (p.flotante[i] >= 0 ? '+' : '') + fmt(p.flotante[i]);
  $('pfCe').textContent = fmt(p.censo[i]);
  $('pfRatio').textContent = (p.equivalente[i] / p.censo[i]).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' ×';
  const k = PF.d.mensual.x.indexOf(x);
  $('pfRes').textContent = k >= 0 ? fmt(Math.round(PF.d.mensual.total[k])) + ' t' : '–';
  // año del mes elegido: media, mes máximo y tasa de la Junta usada
  const anio = x.slice(0, 4), j = a.x.indexOf(anio);
  const idx = p.x.map((m, n) => m.startsWith(anio) ? n : -1).filter(n => n >= 0);
  const max = idx.reduce((m, n) => p.equivalente[n] > p.equivalente[m] ? n : m, idx[0]);
  const min = idx.reduce((m, n) => p.equivalente[n] < p.equivalente[m] ? n : m, idx[0]);
  $('pfAnio').innerHTML = j < 0 ? '' : `<b>${anio}</b>: media de <b>${fmt(a.equivalente[j])}</b> personas (flotante ${fmt(a.flotante[j])}).
    Máximo en ${mesTxt(p.x[max]).split(' ')[0]} (${fmt(p.equivalente[max])}), mínimo en ${mesTxt(p.x[min]).split(' ')[0]} (${fmt(p.equivalente[min])}).
    Tasa de la Junta usada: ${String(a.ratio[j]).replace('.', ',')} kg/hab·año (${a.ratio_anio[j]})${a.notas?.[anio] ? ` · <i>${esc(a.notas[anio])}</i>` : ''}.`;
  if (PF.graf) {
    PF.graf.data.datasets[2].data = p.x.map((m, n) => n === i ? p.equivalente[n] : null);
    PF.graf.update('none');
  }
}
$('pfMes').oninput = e => muestraMes(+e.target.value);
iniciaPoblacion();
