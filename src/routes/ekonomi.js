const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');

const router = Router();
const prisma = new PrismaClient();

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

router.get('/', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();

  // Fetch all snapshots for the year
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);

  const snapshots = await prisma.financialSnapshot.findMany({
    where: {
      month: { gte: yearStart, lte: yearEnd },
    },
    orderBy: { month: 'asc' },
  });

  // Parse into monthly data
  const pl = new Array(12).fill(null);
  const kpi = new Array(12).fill(null);
  const serviceRevenue = new Array(12).fill(null);

  for (const snap of snapshots) {
    const m = new Date(snap.month).getMonth();
    const data = JSON.parse(snap.data);
    if (snap.type === 'pl') pl[m] = data;
    else if (snap.type === 'kpi') kpi[m] = data;
    else if (snap.type === 'service_revenue') serviceRevenue[m] = data;
  }

  // Derive P&L rows with computed fields
  const plRows = pl.map(d => {
    if (!d) return null;
    const bruttovinst = d.intakter - d.ravaror;
    const ebitda = bruttovinst - d.ovriga_kostnader - d.personalkostnad;
    const resultat = ebitda - d.avskrivningar - d.finansiella;
    return {
      ...d,
      bruttovinst,
      ebitda,
      resultat,
      ovriga_pct: d.intakter ? Math.round((d.ovriga_kostnader / d.intakter) * 1000) / 10 : 0,
      personal_pct: d.intakter ? Math.round((d.personalkostnad / d.intakter) * 1000) / 10 : 0,
      ebitda_pct: d.intakter ? Math.round((ebitda / d.intakter) * 1000) / 10 : 0,
      resultat_pct: d.intakter ? Math.round((resultat / d.intakter) * 1000) / 10 : 0,
    };
  });

  // Calculate accumulated result
  let ackResultat = 0;
  const ackResultatArr = plRows.map(d => {
    if (!d) return 0;
    ackResultat += d.resultat;
    return ackResultat;
  });

  // Year totals for P&L
  const plTotal = {};
  const plFields = ['intakter', 'ravaror', 'ovriga_kostnader', 'personalkostnad', 'avskrivningar', 'finansiella'];
  for (const f of plFields) {
    plTotal[f] = plRows.reduce((s, d) => s + (d ? d[f] : 0), 0);
  }
  plTotal.bruttovinst = plTotal.intakter - plTotal.ravaror;
  plTotal.ebitda = plTotal.bruttovinst - plTotal.ovriga_kostnader - plTotal.personalkostnad;
  plTotal.resultat = plTotal.ebitda - plTotal.avskrivningar - plTotal.finansiella;
  plTotal.ovriga_pct = plTotal.intakter ? Math.round((plTotal.ovriga_kostnader / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.personal_pct = plTotal.intakter ? Math.round((plTotal.personalkostnad / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.ebitda_pct = plTotal.intakter ? Math.round((plTotal.ebitda / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.resultat_pct = plTotal.intakter ? Math.round((plTotal.resultat / plTotal.intakter) * 1000) / 10 : 0;
  // Kassa & bank: use last available month
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
  const srFields = ['dima', 'supportavtal', 'webbhotell'];
  for (const f of srFields) {
    srTotal[f] = serviceRevenue.reduce((s, d) => s + (d ? d[f] : 0), 0);
  }

  // Stat cards YTD
  const currentMonth = new Date().getMonth();
  const intakterYtd = plRows.slice(0, currentMonth + 1).reduce((s, d) => s + (d ? d.intakter : 0), 0);
  const ebitdaYtd = plRows.slice(0, currentMonth + 1).reduce((s, d) => s + (d ? d.ebitda : 0), 0);
  const latestDebiteringsgrad = [...kpi].reverse().find(d => d)?.debiteringsgrad || 0;
  const latestKassaBank = [...plRows].reverse().find(d => d)?.kassa_bank || 0;

  // Last sync time
  const latestSync = snapshots.length > 0
    ? snapshots.reduce((latest, s) => s.syncedAt > latest ? s.syncedAt : latest, snapshots[0].syncedAt)
    : null;

  res.render('ekonomi', {
    year,
    monthNames: MONTH_NAMES,
    plRows,
    plTotal,
    ackResultatArr,
    kpi,
    kpiTotal,
    serviceRevenue,
    srTotal,
    intakterYtd,
    ebitdaYtd,
    latestDebiteringsgrad,
    latestKassaBank,
    latestSync,
    pageTitle: 'Ekonomi',
  });
});

module.exports = router;
