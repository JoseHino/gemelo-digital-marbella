// Población flotante: cuánta gente hay realmente en Marbella y qué demanda de agua y residuos supone.
// Medido: empadronados (INE, padrón), huéspedes de alojamiento reglado (pernoctaciones del último mes / días; EOH del INE,
// vía el observatorio turístico) y plazas de viviendas turísticas (registro, a diario).
// Supuesto (ajustable): ocupación de las viviendas turísticas y de las segundas residencias.

const PF = {
  residentes: 159786, anioPadron: 2025,         // se actualiza con la API del INE
  huespedes: null, mesHuespedes: '',             // pernoctaciones del último mes / días del mes
  plazasVut: null, vivVut: 0, viviendas: null,
  personasHogar: 2.5,                            // tamaño medio del hogar en Andalucía (aprox.)
  aguaHab: 130,                                  // l/hab/día de consumo doméstico (INE, Andalucía, aprox.)
  residuosHab: 1.3,                              // kg/hab/día de residuos municipales (INE, España, aprox.)
};
const COL_PF = { residentes: '#1044CD', huespedes: '#1baf7a', vut: '#eb6834', segundas: '#eda100' };

async function iniciaPoblacion() {
  const [ine, obs, res] = await Promise.all([
    fetch('https://servicios.ine.es/wstempus/js/ES/DATOS_TABLA/2882?nult=1&tip=A').then(r => r.json()).catch(() => null),
    fetch('data/observatorios.json').then(r => r.json()).catch(() => null),
    fetch('data/resumen_base.json').then(r => r.json()).catch(() => null),
  ]);
  const s = ine?.find(x => /^Marbella\. Total\. Total habitantes/.test(x.Nombre));
  if (s?.Data?.[0]) { PF.residentes = s.Data[0].Valor; PF.anioPadron = s.Data[0].Anyo; }
  const kpi = (nombre, etiqueta) => obs?.observatorios.find(o => o.nombre === nombre)?.kpis.find(k => k.etiqueta.startsWith(etiqueta));
  const pern = kpi('Observatorio Turístico', 'Pernoctaciones');
  if (pern?.periodo) {
    const [a, m] = pern.periodo.split('-').map(Number), dias = new Date(Date.UTC(a, m, 0)).getUTCDate();
    PF.huespedes = pern.valor / dias;
    PF.mesHuespedes = new Date(Date.UTC(a, m - 1, 1)).toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  PF.plazasVut = kpi('Mapa de VUT', 'Plazas en VUT')?.valor ?? null;
  PF.vivVut = kpi('Mapa de VUT', 'Viviendas de uso')?.valor ?? 0;
  PF.viviendas = res?.viviendas ?? null;
  calculaPoblacion();
}

function calculaPoblacion() {
  const oVut = +$('pfVut').value / 100, oSeg = +$('pfSeg').value / 100;
  $('pfVutTxt').textContent = `${Math.round(oVut * 100)} %`; $('pfSegTxt').textContent = `${Math.round(oSeg * 100)} %`;
  const hogares = PF.residentes / PF.personasHogar;
  const segundas = PF.viviendas ? Math.max(0, PF.viviendas - hogares - PF.vivVut) : 0;
  const partes = [
    ['residentes', `Empadronados (INE ${PF.anioPadron})`, PF.residentes],
    ['huespedes', `Huéspedes de hoteles y apartamentos (media de ${PF.mesHuespedes || '–'})`, PF.huespedes || 0],
    ['vut', 'Turistas en viviendas turísticas', (PF.plazasVut || 0) * oVut],
    ['segundas', 'Ocupantes de segundas residencias', segundas * PF.personasHogar * oSeg],
  ];
  const total = partes.reduce((a, p) => a + p[2], 0);
  $('pfTotal').textContent = fmt(Math.round(total / 100) * 100);
  $('pfRatio').textContent = `${(total / PF.residentes).toLocaleString('es-ES', { maximumFractionDigits: 2 })} ×`;
  $('pfBarra').innerHTML = partes.map(([k, t, v]) => `<i style="width:${v / total * 100}%;background:${COL_PF[k]}" title="${esc(t)}: ${fmt(Math.round(v))}"></i>`).join('');
  $('pfLeyenda').innerHTML = partes.map(([k, t, v]) => `<div><i style="background:${COL_PF[k]}"></i>${esc(t)}<b>${fmt(Math.round(v / 100) * 100)}</b></div>`).join('');
  const extra = total - PF.residentes;
  $('pfDemanda').innerHTML = `<div><b>${fmt(Math.round(total * PF.aguaHab / 1000))} m³</b>agua doméstica al día (+${fmt(Math.round(extra * PF.aguaHab / 1000))} por la población flotante)</div>
    <div><b>${fmt(Math.round(total * PF.residuosHab / 1000))} t</b>residuos al día (+${fmt(Math.round(extra * PF.residuosHab / 1000))})</div>`;
}
['pfVut', 'pfSeg'].forEach(id => $(id).oninput = calculaPoblacion);
$('pfPre').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  $('pfVut').value = b.dataset.vut; $('pfSeg').value = b.dataset.seg; calculaPoblacion();
};
iniciaPoblacion();
