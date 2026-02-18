const { PrismaClient } = require('../generated/prisma');
const { SpirisClient } = require('./spiris-client');
const { BlikkClient } = require('./blikk-client');

const prisma = new PrismaClient();

// ── Helpers ──────────────────────────────────────────────────

function lastDayOfMonth(year, month) {
  // month is 0-indexed
  return new Date(year, month + 1, 0).toISOString().slice(0, 10);
}

function monthStart(year, month) {
  return new Date(year, month, 1);
}

// ── 1. Visma P&L ────────────────────────────────────────────

/**
 * Sync P&L data from Visma account balances for all months in a year.
 * Fetches 13 balance snapshots (dec prev year + jan-dec) and diffs them.
 */
async function syncVismaFinancials(year) {
  const client = new SpirisClient();

  // Fetch 13 dates: last day of dec prev year + last day of each month
  const dates = [];
  dates.push(lastDayOfMonth(year - 1, 11)); // dec previous year
  for (let m = 0; m < 12; m++) {
    dates.push(lastDayOfMonth(year, m));
  }

  // Fetch all accounts for a date (paginated, ~1300 accounts)
  async function fetchAllBalances(date) {
    const all = [];
    let page = 1;
    const pageSize = 500;
    while (true) {
      const data = await client.get(`/accountbalances/${date}`, { $page: page, $pagesize: pageSize });
      const items = data.Data || data.data || data;
      const arr = Array.isArray(items) ? items : [];
      all.push(...arr);
      if (arr.length < pageSize) break;
      page++;
    }
    return all;
  }

  const balances = [];
  for (const date of dates) {
    balances.push(await fetchAllBalances(date));
  }

  // Helper: sum account balances matching a predicate
  function sumAccounts(items, predicate) {
    return items
      .filter(a => predicate(a.AccountNumber || a.accountNumber || 0))
      .reduce((s, a) => s + (a.Balance || a.balance || 0), 0);
  }

  const saved = [];

  for (let m = 0; m < 12; m++) {
    const curr = balances[m + 1]; // this month's cumulative
    const prev = balances[m];     // previous month's cumulative

    // BAS account groupings — cumulative to monthly diff
    const intakter_cum  = sumAccounts(curr, n => n >= 3000 && n < 4000);
    const intakter_prev = sumAccounts(prev, n => n >= 3000 && n < 4000);
    const intakter = -1 * (intakter_cum - intakter_prev); // credit accounts → positive

    const ravaror_cum  = sumAccounts(curr, n => n >= 4000 && n < 5000);
    const ravaror_prev = sumAccounts(prev, n => n >= 4000 && n < 5000);
    const ravaror = ravaror_cum - ravaror_prev;

    const ovriga_cum  = sumAccounts(curr, n => n >= 5000 && n < 7000);
    const ovriga_prev = sumAccounts(prev, n => n >= 5000 && n < 7000);
    const ovriga_kostnader = ovriga_cum - ovriga_prev;

    const personal_cum  = sumAccounts(curr, n => n >= 7000 && n < 7800);
    const personal_prev = sumAccounts(prev, n => n >= 7000 && n < 7800);
    const personalkostnad = personal_cum - personal_prev;

    const avskr_cum  = sumAccounts(curr, n => n >= 7800 && n < 7900);
    const avskr_prev = sumAccounts(prev, n => n >= 7800 && n < 7900);
    const avskrivningar = avskr_cum - avskr_prev;

    const finans_cum  = sumAccounts(curr, n => n >= 8000 && n < 9000);
    const finans_prev = sumAccounts(prev, n => n >= 8000 && n < 9000);
    const finansiella = finans_cum - finans_prev;

    // Kassa & bank — absolute balance, not diff
    const kassa_bank = sumAccounts(curr, n => n >= 1900 && n < 2000);

    const month = monthStart(year, m);
    const data = JSON.stringify({
      intakter: Math.round(intakter),
      ravaror: Math.round(ravaror),
      ovriga_kostnader: Math.round(ovriga_kostnader),
      personalkostnad: Math.round(personalkostnad),
      avskrivningar: Math.round(avskrivningar),
      finansiella: Math.round(finansiella),
      kassa_bank: Math.round(kassa_bank),
    });

    await prisma.financialSnapshot.upsert({
      where: { month_type: { month, type: 'pl' } },
      update: { data, syncedAt: new Date() },
      create: { month, type: 'pl', data, syncedAt: new Date() },
    });

    saved.push({ month: month.toISOString().slice(0, 7) });
  }

  return { type: 'pl', months: saved.length };
}

// ── 2. Blikk KPIs ───────────────────────────────────────────

/**
 * Sync time-report KPIs from Blikk for all months in a year.
 */
async function syncBlikkKpis(year) {
  const client = new BlikkClient();

  const saved = [];

  for (let m = 0; m < 12; m++) {
    const fromDate = `${year}-${String(m + 1).padStart(2, '0')}-01`;
    const toDate = lastDayOfMonth(year, m);

    let reports;
    try {
      reports = await client.getAllTimeReports({ fromDate, toDate });
    } catch (err) {
      console.error(`Blikk time reports for ${fromDate}: ${err.message}`);
      continue;
    }

    // Aggregate hours — field names are guesses, debug endpoint will confirm
    let rapporterade_h = 0;
    let interntid_h = 0;
    let franvaro_h = 0;
    let debiterade_h = 0;

    for (const r of reports) {
      const hours = r.hours || r.quantity || r.time || 0;
      rapporterade_h += hours;

      // Categorize based on common Blikk field patterns
      const isInternal = r.isInternal || r.internal || r.projectType === 'Internal' || false;
      const isAbsence = r.isAbsence || r.absence || r.type === 'Absence' || false;
      const isBillable = r.isBillable || r.billable || r.invoiceable || false;

      if (isAbsence) {
        franvaro_h += hours;
      } else if (isInternal) {
        interntid_h += hours;
      } else if (isBillable) {
        debiterade_h += hours;
      }
    }

    // Try to calculate debiteringsgrad and intäkt/h from P&L snapshot
    const month = monthStart(year, m);
    const tillganglig = rapporterade_h - franvaro_h;
    const debiteringsgrad = tillganglig > 0 ? Math.round((debiterade_h / tillganglig) * 1000) / 10 : 0;

    let intakt_per_h = 0;
    try {
      const plSnapshot = await prisma.financialSnapshot.findUnique({
        where: { month_type: { month, type: 'pl' } },
      });
      if (plSnapshot && debiterade_h > 0) {
        const pl = JSON.parse(plSnapshot.data);
        intakt_per_h = Math.round(pl.intakter / debiterade_h);
      }
    } catch { /* P&L not yet synced */ }

    const data = JSON.stringify({
      rapporterade_h: Math.round(rapporterade_h * 10) / 10,
      interntid_h: Math.round(interntid_h * 10) / 10,
      franvaro_h: Math.round(franvaro_h * 10) / 10,
      debiterade_h: Math.round(debiterade_h * 10) / 10,
      debiteringsgrad,
      intakt_per_h,
    });

    await prisma.financialSnapshot.upsert({
      where: { month_type: { month, type: 'kpi' } },
      update: { data, syncedAt: new Date() },
      create: { month, type: 'kpi', data, syncedAt: new Date() },
    });

    saved.push({ month: month.toISOString().slice(0, 7) });
  }

  return { type: 'kpi', months: saved.length };
}

// ── 3. Service Revenue ───────────────────────────────────────

const INTERVAL_MULTIPLIER = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };

const CATEGORY_MAP = {
  'Din Marknadskoordinator': 'dima',
  'Supportavtal': 'supportavtal',
  'Webbhotell & domän': 'webbhotell',
};

/**
 * Check if a project is due for invoicing in a given month.
 */
function isDueForMonth(project, ms) {
  if (!project.nextInvoiceMonth) return true;
  const next = new Date(project.nextInvoiceMonth);
  const nextY = next.getFullYear(), nextM = next.getMonth();
  const viewY = ms.getFullYear(), viewM = ms.getMonth();
  if (viewY < nextY || (viewY === nextY && viewM < nextM)) return false;
  const intMonths = INTERVAL_MULTIPLIER[project.billingInterval] || 1;
  const diff = (viewY - nextY) * 12 + (viewM - nextM);
  return diff % intMonths === 0;
}

/**
 * Calculate effective price for a project in a given month.
 */
function effectivePrice(p, ms) {
  // Check for override
  const override = (p.priceOverrides || []).find(o => {
    const d = new Date(o.month);
    return d.getFullYear() === ms.getFullYear() && d.getMonth() === ms.getMonth();
  });
  if (override) return override.price;

  if (p.billingSplits && p.billingSplits.length > 0) {
    return p.billingSplits.reduce((s, sp) => s + sp.amount, 0);
  }
  if (p.invoiceRows && p.invoiceRows.length > 0) {
    return p.invoiceRows.reduce((s, r) => s + (r.unitPrice || 0) * (r.quantity || 1), 0);
  }
  const multiplier = INTERVAL_MULTIPLIER[p.billingInterval] || 1;
  return (p.monthlyPrice || 0) * multiplier;
}

/**
 * Sync service revenue breakdown for all months in a year.
 */
async function syncServiceRevenue(year) {
  const projects = await prisma.project.findMany({
    where: { isCompleted: false },
    include: {
      priceOverrides: true,
      invoiceRows: true,
      billingSplits: true,
    },
  });

  const saved = [];

  for (let m = 0; m < 12; m++) {
    const ms = monthStart(year, m);
    const totals = { dima: 0, supportavtal: 0, webbhotell: 0 };

    for (const p of projects) {
      const key = CATEGORY_MAP[p.category];
      if (!key) continue;
      if (!isDueForMonth(p, ms)) continue;

      // Skip if project started after this month
      if (p.startDate && new Date(p.startDate) > ms) continue;
      // Skip if project ended before this month
      if (p.endDate && new Date(p.endDate) < ms) continue;
      // Skip if paused during this month
      if (p.pauseFrom && p.pauseUntil) {
        const from = new Date(p.pauseFrom);
        const until = new Date(p.pauseUntil);
        if (from <= ms && until >= ms) continue;
      }

      totals[key] += effectivePrice(p, ms);
    }

    const month = ms;
    const data = JSON.stringify({
      dima: Math.round(totals.dima),
      supportavtal: Math.round(totals.supportavtal),
      webbhotell: Math.round(totals.webbhotell),
    });

    await prisma.financialSnapshot.upsert({
      where: { month_type: { month, type: 'service_revenue' } },
      update: { data, syncedAt: new Date() },
      create: { month, type: 'service_revenue', data, syncedAt: new Date() },
    });

    saved.push({ month: ms.toISOString().slice(0, 7) });
  }

  return { type: 'service_revenue', months: saved.length };
}

// ── 4. Sync All ──────────────────────────────────────────────

async function syncAll(year) {
  const results = {};

  try { results.pl = await syncVismaFinancials(year); }
  catch (e) { results.pl = { error: e.message }; }

  try { results.kpi = await syncBlikkKpis(year); }
  catch (e) { results.kpi = { error: e.message }; }

  try { results.service_revenue = await syncServiceRevenue(year); }
  catch (e) { results.service_revenue = { error: e.message }; }

  return results;
}

module.exports = {
  syncVismaFinancials,
  syncBlikkKpis,
  syncServiceRevenue,
  syncAll,
};
