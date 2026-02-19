const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');
const { calculateForecast } = require('../services/forecast');

const router = Router();
const prisma = new PrismaClient();

// Fiscal year Oct–Sep: index 0=okt, 1=nov, ..., 11=sep
const MONTH_NAMES = ['okt', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep'];

function currentFiscalYear() {
  const now = new Date();
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}

router.get('/', async (req, res) => {
  const year = parseInt(req.query.year) || currentFiscalYear();

  // FY year=2025 → Oct 2024 – Sep 2025
  const fyStart = new Date(Date.UTC(year - 1, 9, 1));
  const fyEnd   = new Date(Date.UTC(year, 8, 30));

  const snapshots = await prisma.financialSnapshot.findMany({
    where: { month: { gte: fyStart, lte: fyEnd } },
    orderBy: { month: 'asc' },
  });

  // Parse into fiscal monthly data (index 0=Oct, 11=Sep)
  const pl = new Array(12).fill(null);
  const kpi = new Array(12).fill(null);
  const serviceRevenue = new Array(12).fill(null);
  const budget = new Array(12).fill(null);

  for (const snap of snapshots) {
    const calMonth = new Date(snap.month).getUTCMonth();
    const fyIndex = (calMonth + 3) % 12;
    const data = JSON.parse(snap.data);
    if (snap.type === 'pl') pl[fyIndex] = data;
    else if (snap.type === 'kpi') kpi[fyIndex] = data;
    else if (snap.type === 'service_revenue') serviceRevenue[fyIndex] = data;
    else if (snap.type === 'budget') budget[fyIndex] = data;
  }

  // Forecast: fill months where service_revenue has no actual revenue,
  // plus the current (incomplete) month which gets both utfall + prognos
  const forecast = await calculateForecast(year);
  const nowFyIdx = year === currentFiscalYear() ? (new Date().getMonth() + 3) % 12 : -1;
  const forecastData = serviceRevenue.map((sr, i) => {
    if (i === nowFyIdx) return forecast[i]; // current month: always show forecast
    const hasRevenue = sr && ['tjanster', 'varor', 'dima', 'supportavtal', 'hemsidor', 'layout'].some(f => sr[f] > 0);
    return hasRevenue ? null : forecast[i];
  });

  // Derive P&L rows with computed fields
  const plRows = pl.map(d => {
    if (!d) return null;
    const bruttovinst = d.intakter - d.ravaror;
    const rorelseresultat = bruttovinst - d.ovriga_kostnader - d.personalkostnad - (d.ovriga_rorelsekostnader || 0);
    const resultat_fore_skatt = rorelseresultat + (d.finansiella || 0);
    const resultat = resultat_fore_skatt - (d.skatt || 0);
    return {
      ...d,
      bruttovinst,
      rorelseresultat,
      resultat_fore_skatt,
      resultat,
      ovriga_pct: d.intakter ? Math.round((d.ovriga_kostnader / d.intakter) * 1000) / 10 : 0,
      personal_pct: d.intakter ? Math.round((d.personalkostnad / d.intakter) * 1000) / 10 : 0,
      rorelseresultat_pct: d.intakter ? Math.round((rorelseresultat / d.intakter) * 1000) / 10 : 0,
      resultat_pct: d.intakter ? Math.round((resultat / d.intakter) * 1000) / 10 : 0,
    };
  });

  // Accumulated result
  let ackResultat = 0;
  const ackResultatArr = plRows.map(d => {
    if (!d) return 0;
    ackResultat += d.resultat;
    return ackResultat;
  });

  // Year totals for P&L
  const plTotal = {};
  const plFields = ['intakter', 'ravaror', 'ovriga_kostnader', 'personalkostnad', 'ovriga_rorelsekostnader', 'finansiella', 'skatt'];
  for (const f of plFields) {
    plTotal[f] = plRows.reduce((s, d) => s + (d ? (d[f] || 0) : 0), 0);
  }
  plTotal.bruttovinst = plTotal.intakter - plTotal.ravaror;
  plTotal.rorelseresultat = plTotal.bruttovinst - plTotal.ovriga_kostnader - plTotal.personalkostnad - plTotal.ovriga_rorelsekostnader;
  plTotal.resultat_fore_skatt = plTotal.rorelseresultat + plTotal.finansiella;
  plTotal.resultat = plTotal.resultat_fore_skatt - plTotal.skatt;
  plTotal.ovriga_pct = plTotal.intakter ? Math.round((plTotal.ovriga_kostnader / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.personal_pct = plTotal.intakter ? Math.round((plTotal.personalkostnad / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.rorelseresultat_pct = plTotal.intakter ? Math.round((plTotal.rorelseresultat / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.resultat_pct = plTotal.intakter ? Math.round((plTotal.resultat / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.kassa_bank = [...plRows].reverse().find(d => d)?.kassa_bank || 0;

  // Year totals for KPI
  const kpiTotal = {};
  const kpiFields = ['rapporterade_h', 'interntid_h', 'franvaro_h', 'debiterade_h'];
  for (const f of kpiFields) {
    kpiTotal[f] = kpi.reduce((s, d) => s + (d ? d[f] : 0), 0);
  }
  const tillganglig = kpiTotal.rapporterade_h - kpiTotal.franvaro_h;
  kpiTotal.debiteringsgrad = tillganglig > 0 ? Math.round((kpiTotal.debiterade_h / tillganglig) * 1000) / 10 : 0;
  kpiTotal.intakt_per_h = kpiTotal.debiterade_h > 0 ? Math.round(plTotal.intakter / kpiTotal.debiterade_h) : 0;

  // Year totals for service revenue
  const srTotal = {};
  const srFields = ['tjanster', 'varor', 'dima', 'supportavtal', 'hemsidor', 'layout'];
  for (const f of srFields) {
    srTotal[f] = serviceRevenue.reduce((s, d) => s + (d ? d[f] : 0), 0);
  }

  // Year totals for budget
  const budgetTotal = {
    intakter: budget.reduce((s, d) => s + (d ? (d.intakter || 0) : 0), 0),
  };

  // Stat cards YTD (fiscal year)
  const nowFY = currentFiscalYear();
  const currentFyIndex = (new Date().getMonth() + 3) % 12;
  const ytdEnd = year === nowFY ? currentFyIndex + 1 : 12;

  const intakterYtd = plRows.slice(0, ytdEnd).reduce((s, d) => s + (d ? d.intakter : 0), 0);
  const resultatYtd = plRows.slice(0, ytdEnd).reduce((s, d) => s + (d ? d.resultat : 0), 0);
  const latestDebiteringsgrad = [...kpi].reverse().find(d => d)?.debiteringsgrad || 0;
  const latestKassaBank = [...plRows].reverse().find(d => d)?.kassa_bank || 0;

  // Last sync time
  const latestSync = snapshots.length > 0
    ? snapshots.reduce((latest, s) => s.syncedAt > latest ? s.syncedAt : latest, snapshots[0].syncedAt)
    : null;

  const yearLabel = `${year - 1}/${String(year).slice(2)}`;

  res.render('ekonomi', {
    year,
    yearLabel,
    monthNames: MONTH_NAMES,
    plRows,
    plTotal,
    ackResultatArr,
    kpi,
    kpiTotal,
    serviceRevenue,
    srTotal,
    forecastData,
    budget,
    budgetTotal,
    intakterYtd,
    resultatYtd,
    latestDebiteringsgrad,
    latestKassaBank,
    latestSync,
    pageTitle: 'Ekonomi',
  });
});

module.exports = router;
