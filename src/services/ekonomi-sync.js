const { PrismaClient } = require('../generated/prisma');
const { SpirisClient } = require('./spiris-client');
const { BlikkClient } = require('./blikk-client');

const prisma = new PrismaClient();

// ── Helpers ──────────────────────────────────────────────────

function monthStartUTC(year, month) {
  return new Date(Date.UTC(year, month, 1));
}

/** Build "YYYY-MM-DD" for the last day of a month (timezone-safe). */
function lastDayStr(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const mm = String(month + 1).padStart(2, '0');
  return `${year}-${mm}-${String(d).padStart(2, '0')}`;
}

/** Build "YYYY-MM-01" for the first day of a month. */
function firstDayStr(year, month) {
  const mm = String(month + 1).padStart(2, '0');
  return `${year}-${mm}-01`;
}

/**
 * Fiscal year runs Oct–Sep. year=2025 means Oct 2024 – Sep 2025.
 * fyIndex: 0=Oct, 1=Nov, 2=Dec, 3=Jan, 4=Feb, ..., 11=Sep
 */
function fyCalendar(year, fyIndex) {
  const calMonth = (9 + fyIndex) % 12;
  const calYear = fyIndex < 3 ? year - 1 : year;
  return { calYear, calMonth };
}

function fyMonthStart(year, fyIndex) {
  const { calYear, calMonth } = fyCalendar(year, fyIndex);
  return monthStartUTC(calYear, calMonth);
}

// ── 1. Visma P&L (voucher-based) ────────────────────────────

/**
 * Fetch all Visma vouchers for a date range (paginated).
 */
async function fetchVouchers(client, fromDate, toDate) {
  const vouchers = [];
  let page = 1;
  while (true) {
    const data = await client.get('/vouchers', {
      $filter: `VoucherDate ge ${fromDate} and VoucherDate le ${toDate}`,
      $pagesize: 200,
      $page: page,
    });
    const items = data.Data || data.data || data;
    const arr = Array.isArray(items) ? items : [];
    vouchers.push(...arr);
    if (arr.length < 200) break;
    page++;
  }
  return vouchers;
}

/**
 * Fetch cumulative account balance for 19xx (kassa & bank) at a date.
 */
async function fetchKassaBank(client, date) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await client.get(`/accountbalances/${date}`, { $page: page, $pagesize: 500 });
    const items = data.Data || data.data || data;
    const arr = Array.isArray(items) ? items : [];
    all.push(...arr);
    if (arr.length < 500) break;
    page++;
  }
  return all
    .filter(a => (a.AccountNumber || 0) >= 1900 && (a.AccountNumber || 0) < 2000)
    .reduce((s, a) => s + (a.Balance || 0), 0);
}

/**
 * Sync P&L data from Visma vouchers for a fiscal year (Oct–Sep).
 * Uses the /vouchers endpoint to get exact per-month figures.
 */
async function syncVismaFinancials(year) {
  const client = new SpirisClient();
  const saved = [];

  for (let i = 0; i < 12; i++) {
    const { calYear, calMonth } = fyCalendar(year, i);
    const fromDate = firstDayStr(calYear, calMonth);
    const toDate = lastDayStr(calYear, calMonth);

    // Fetch all vouchers for the month
    const vouchers = await fetchVouchers(client, fromDate, toDate);

    // Sum all voucher rows by account number
    const acctSums = {};
    for (const v of vouchers) {
      for (const row of (v.Rows || [])) {
        const a = row.AccountNumber;
        if (!acctSums[a]) acctSums[a] = { debit: 0, credit: 0 };
        acctSums[a].debit += row.DebitAmount || 0;
        acctSums[a].credit += row.CreditAmount || 0;
      }
    }

    // Net = credit - debit (positive for credit-surplus accounts like revenue)
    function netGroup(from, to) {
      let d = 0, c = 0;
      for (const [a, s] of Object.entries(acctSums)) {
        const n = parseInt(a);
        if (n >= from && n < to) { d += s.debit; c += s.credit; }
      }
      return c - d;
    }

    const intakter = netGroup(3000, 4000);                    // positive = revenue
    const ravaror = -netGroup(4000, 5000);                    // positive = cost
    const ovriga_kostnader = -netGroup(5000, 7000);           // positive = cost
    const personalkostnad = -netGroup(7000, 7900);            // positive = cost
    const ovriga_rorelsekostnader = -netGroup(7900, 8000);    // positive = cost
    const finansiella = netGroup(8000, 8800);                 // positive = income
    const skatt = -netGroup(8900, 8999);                      // positive = tax expense (excludes 8999 Årets resultat)

    // Kassa & bank: cumulative balance at month end
    let kassa_bank = 0;
    try {
      kassa_bank = await fetchKassaBank(client, toDate);
    } catch (e) {
      console.error(`Kassa/bank for ${toDate}: ${e.message}`);
    }

    const month = fyMonthStart(year, i);
    const data = JSON.stringify({
      intakter: Math.round(intakter),
      ravaror: Math.round(ravaror),
      ovriga_kostnader: Math.round(ovriga_kostnader),
      personalkostnad: Math.round(personalkostnad),
      ovriga_rorelsekostnader: Math.round(ovriga_rorelsekostnader),
      finansiella: Math.round(finansiella),
      skatt: Math.round(skatt),
      kassa_bank: Math.round(kassa_bank),
    });

    await prisma.financialSnapshot.upsert({
      where: { month_type: { month, type: 'pl' } },
      update: { data, syncedAt: new Date() },
      create: { month, type: 'pl', data, syncedAt: new Date() },
    });

    saved.push({ month: month.toISOString().slice(0, 7), vouchers: vouchers.length });
  }

  return { type: 'pl', months: saved.length };
}

// ── 2. Blikk KPIs ───────────────────────────────────────────

/**
 * Sync time-report KPIs from Blikk for a fiscal year (Oct–Sep).
 */
async function syncBlikkKpis(year) {
  const client = new BlikkClient();
  const saved = [];

  for (let i = 0; i < 12; i++) {
    const { calYear, calMonth } = fyCalendar(year, i);
    const fromDate = firstDayStr(calYear, calMonth);
    const toDate = lastDayStr(calYear, calMonth);

    let reports;
    try {
      reports = await client.getAllTimeReports({ fromDate, toDate });
    } catch (err) {
      console.error(`Blikk time reports for ${fromDate}: ${err.message}`);
      continue;
    }

    let rapporterade_h = 0;
    let interntid_h = 0;
    let franvaro_h = 0;
    let debiterade_h = 0;

    for (const r of reports) {
      const hours = r.hours || r.quantity || r.time || 0;
      rapporterade_h += hours;

      const isInternal = r.isInternal || r.internal || r.projectType === 'Internal' || false;
      const isAbsence = r.isAbsence || r.absence || r.type === 'Absence' || false;
      const isBillable = r.isBillable || r.billable || r.invoiceable || false;

      if (isAbsence) franvaro_h += hours;
      else if (isInternal) interntid_h += hours;
      else if (isBillable) debiterade_h += hours;
    }

    const month = fyMonthStart(year, i);
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

// ── 3. Service Revenue (from Visma accounts) ────────────────

// Visma account → category mapping
const SERVICE_ACCOUNTS = {
  3041: 'tjanster',       // Försäljn tjänst 25% sv
  3045: 'tjanster',       // Försäljn tjänst utanför EG momsfri
  3051: 'varor',          // Försäljn varor 25% sv
  3055: 'varor',          // Försäljn varor utanför EG momsfri
  3111: 'dima',           // Försäljning Din markandskoordinator 25%
  3112: 'supportavtal',   // Webbhotell och Supportavtal 25%
  3113: 'hemsidor',       // Försäljning Hemsidor 25%
  3114: 'layout',         // Försäljning Layout, Foto, Film 25%
};

/**
 * Sync service revenue from Visma vouchers for a fiscal year (Oct–Sep).
 * Uses accounts 3111/3112/3113 to break down revenue by service type.
 */
async function syncServiceRevenue(year) {
  const client = new SpirisClient();
  const saved = [];

  for (let i = 0; i < 12; i++) {
    const { calYear, calMonth } = fyCalendar(year, i);
    const fromDate = firstDayStr(calYear, calMonth);
    const toDate = lastDayStr(calYear, calMonth);

    const vouchers = await fetchVouchers(client, fromDate, toDate);

    const totals = { tjanster: 0, varor: 0, dima: 0, supportavtal: 0, hemsidor: 0, layout: 0 };
    for (const v of vouchers) {
      for (const row of (v.Rows || [])) {
        const cat = SERVICE_ACCOUNTS[row.AccountNumber];
        if (cat) {
          totals[cat] += (row.CreditAmount || 0) - (row.DebitAmount || 0);
        }
      }
    }

    const month = fyMonthStart(year, i);
    const data = JSON.stringify({
      tjanster: Math.round(totals.tjanster),
      varor: Math.round(totals.varor),
      dima: Math.round(totals.dima),
      supportavtal: Math.round(totals.supportavtal),
      hemsidor: Math.round(totals.hemsidor),
      layout: Math.round(totals.layout),
    });

    await prisma.financialSnapshot.upsert({
      where: { month_type: { month, type: 'service_revenue' } },
      update: { data, syncedAt: new Date() },
      create: { month, type: 'service_revenue', data, syncedAt: new Date() },
    });

    saved.push({ month: month.toISOString().slice(0, 7) });
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

// ── Single-month sync functions (for serverless timeout safety) ──

async function syncVismaFinancialsMonth(year, fyIndex) {
  const client = new SpirisClient();
  const { calYear, calMonth } = fyCalendar(year, fyIndex);
  const fromDate = firstDayStr(calYear, calMonth);
  const toDate = lastDayStr(calYear, calMonth);

  const vouchers = await fetchVouchers(client, fromDate, toDate);

  const acctSums = {};
  for (const v of vouchers) {
    for (const row of (v.Rows || [])) {
      const a = row.AccountNumber;
      if (!acctSums[a]) acctSums[a] = { debit: 0, credit: 0 };
      acctSums[a].debit += row.DebitAmount || 0;
      acctSums[a].credit += row.CreditAmount || 0;
    }
  }

  function netGroup(from, to) {
    let d = 0, c = 0;
    for (const [a, s] of Object.entries(acctSums)) {
      const n = parseInt(a);
      if (n >= from && n < to) { d += s.debit; c += s.credit; }
    }
    return c - d;
  }

  const intakter = netGroup(3000, 4000);
  const ravaror = -netGroup(4000, 5000);
  const ovriga_kostnader = -netGroup(5000, 7000);
  const personalkostnad = -netGroup(7000, 7900);
  const ovriga_rorelsekostnader = -netGroup(7900, 8000);
  const finansiella = netGroup(8000, 8800);
  const skatt = -netGroup(8900, 8999);

  let kassa_bank = 0;
  try {
    kassa_bank = await fetchKassaBank(client, toDate);
  } catch (e) {
    console.error(`Kassa/bank for ${toDate}: ${e.message}`);
  }

  const month = fyMonthStart(year, fyIndex);
  const data = JSON.stringify({
    intakter: Math.round(intakter),
    ravaror: Math.round(ravaror),
    ovriga_kostnader: Math.round(ovriga_kostnader),
    personalkostnad: Math.round(personalkostnad),
    ovriga_rorelsekostnader: Math.round(ovriga_rorelsekostnader),
    finansiella: Math.round(finansiella),
    skatt: Math.round(skatt),
    kassa_bank: Math.round(kassa_bank),
  });

  await prisma.financialSnapshot.upsert({
    where: { month_type: { month, type: 'pl' } },
    update: { data, syncedAt: new Date() },
    create: { month, type: 'pl', data, syncedAt: new Date() },
  });

  // ── pl_detail: per-account breakdown with voucher texts ──
  const plDetailGroups = {
    intakter:         { from: 3000, to: 4000 },
    ravaror:          { from: 4000, to: 5000 },
    ovriga_kostnader: { from: 5000, to: 7000 },
    personalkostnad:  { from: 7000, to: 7900 },
    finansiella:      { from: 8000, to: 8800 },
  };

  // Collect per-account amounts, names, and voucher texts
  const acctDetails = {}; // { accountNumber: { amount, name, texts: { text: amount } } }
  for (const v of vouchers) {
    const vText = (v.VoucherText || v.Description || '').trim();
    for (const row of (v.Rows || [])) {
      const a = row.AccountNumber;
      if (!acctDetails[a]) acctDetails[a] = { amount: 0, name: '', texts: {} };
      if (!acctDetails[a].name && row.AccountName) acctDetails[a].name = row.AccountName;
      const net = (row.DebitAmount || 0) - (row.CreditAmount || 0);
      acctDetails[a].amount += net;
      if (vText) {
        acctDetails[a].texts[vText] = (acctDetails[a].texts[vText] || 0) + Math.abs(net);
      }
    }
  }

  const detailData = {};
  for (const [group, range] of Object.entries(plDetailGroups)) {
    const accounts = [];
    for (const [acctStr, info] of Object.entries(acctDetails)) {
      const acctNum = parseInt(acctStr);
      if (acctNum >= range.from && acctNum < range.to) {
        // For cost accounts (4000+), amount is positive = cost; for revenue (3000-4000), flip sign
        const isRevenue = group === 'intakter' || group === 'finansiella';
        const amount = isRevenue ? -info.amount : info.amount;
        if (Math.abs(amount) < 1) continue;
        // Top 5 voucher texts by amount (with amounts)
        const vouchers = Object.entries(info.texts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([text, amt]) => ({ text, amount: Math.round(amt) }));
        accounts.push({ account: acctNum, name: info.name || '', amount: Math.round(amount), vouchers });
      }
    }
    accounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    if (accounts.length > 0) detailData[group] = accounts;
  }

  const detailJson = JSON.stringify(detailData);
  await prisma.financialSnapshot.upsert({
    where: { month_type: { month, type: 'pl_detail' } },
    update: { data: detailJson, syncedAt: new Date() },
    create: { month, type: 'pl_detail', data: detailJson, syncedAt: new Date() },
  });

  return { month: month.toISOString().slice(0, 7), vouchers: vouchers.length };
}

async function syncServiceRevenueMonth(year, fyIndex) {
  const client = new SpirisClient();
  const { calYear, calMonth } = fyCalendar(year, fyIndex);
  const fromDate = firstDayStr(calYear, calMonth);
  const toDate = lastDayStr(calYear, calMonth);

  const vouchers = await fetchVouchers(client, fromDate, toDate);

  const totals = { tjanster: 0, varor: 0, dima: 0, supportavtal: 0, hemsidor: 0, layout: 0 };
  for (const v of vouchers) {
    for (const row of (v.Rows || [])) {
      const cat = SERVICE_ACCOUNTS[row.AccountNumber];
      if (cat) {
        totals[cat] += (row.CreditAmount || 0) - (row.DebitAmount || 0);
      }
    }
  }

  const month = fyMonthStart(year, fyIndex);
  const data = JSON.stringify({
    tjanster: Math.round(totals.tjanster),
    varor: Math.round(totals.varor),
    dima: Math.round(totals.dima),
    supportavtal: Math.round(totals.supportavtal),
    hemsidor: Math.round(totals.hemsidor),
    layout: Math.round(totals.layout),
  });

  await prisma.financialSnapshot.upsert({
    where: { month_type: { month, type: 'service_revenue' } },
    update: { data, syncedAt: new Date() },
    create: { month, type: 'service_revenue', data, syncedAt: new Date() },
  });

  return { month: month.toISOString().slice(0, 7) };
}

async function syncBlikkKpisMonth(year, fyIndex) {
  const client = new BlikkClient();
  const { calYear, calMonth } = fyCalendar(year, fyIndex);
  const fromDate = firstDayStr(calYear, calMonth);
  const toDate = lastDayStr(calYear, calMonth);

  const reports = await client.getAllTimeReports({ fromDate, toDate });

  let rapporterade_h = 0, interntid_h = 0, franvaro_h = 0, debiterade_h = 0;
  for (const r of reports) {
    const hours = r.hours || r.quantity || r.time || 0;
    rapporterade_h += hours;
    const isInternal = r.isInternal || r.internal || r.projectType === 'Internal' || false;
    const isAbsence = r.isAbsence || r.absence || r.type === 'Absence' || false;
    const isBillable = r.isBillable || r.billable || r.invoiceable || false;
    if (isAbsence) franvaro_h += hours;
    else if (isInternal) interntid_h += hours;
    else if (isBillable) debiterade_h += hours;
  }

  const month = fyMonthStart(year, fyIndex);
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

  return { month: month.toISOString().slice(0, 7) };
}

module.exports = {
  syncVismaFinancials,
  syncBlikkKpis,
  syncServiceRevenue,
  syncAll,
  syncVismaFinancialsMonth,
  syncServiceRevenueMonth,
  syncBlikkKpisMonth,
};
