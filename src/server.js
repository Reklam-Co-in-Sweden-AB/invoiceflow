require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');

const { requireAuth } = require('./middleware/auth');
const { calculateForecast } = require('./services/forecast');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Middleware
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const sessionPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});
app.use(session({
  store: new pgSession({
    pool: sessionPool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// Make user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  next();
});

// Public ekonomi data API (secured by API key, no session needed)
app.get('/api/public/ekonomi', async (req, res) => {
  const apiKey = process.env.EKONOMI_API_KEY;
  if (apiKey && req.headers['x-api-key'] !== apiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  try {
  const { PrismaClient } = require('./generated/prisma');
  const prisma = new PrismaClient();
  const MONTH_NAMES = ['okt', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep'];

  const now = new Date();
  const currentFY = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  const year = parseInt(req.query.year) || currentFY;

  const fyStart = new Date(Date.UTC(year - 1, 9, 1));
  const fyEnd = new Date(Date.UTC(year, 8, 30));

  const snapshots = await prisma.financialSnapshot.findMany({
    where: { month: { gte: fyStart, lte: fyEnd } },
    orderBy: { month: 'asc' },
  });

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

  const plRows = pl.map(d => {
    if (!d) return null;
    const bruttovinst = d.intakter - d.ravaror;
    const rorelseresultat = bruttovinst - d.ovriga_kostnader - d.personalkostnad - (d.ovriga_rorelsekostnader || 0);
    const resultat_fore_skatt = rorelseresultat + (d.finansiella || 0);
    const resultat = resultat_fore_skatt - (d.skatt || 0);
    return { ...d, bruttovinst, rorelseresultat, resultat_fore_skatt, resultat,
      ovriga_pct: d.intakter ? Math.round((d.ovriga_kostnader / d.intakter) * 1000) / 10 : 0,
      personal_pct: d.intakter ? Math.round((d.personalkostnad / d.intakter) * 1000) / 10 : 0,
      rorelseresultat_pct: d.intakter ? Math.round((rorelseresultat / d.intakter) * 1000) / 10 : 0,
      resultat_pct: d.intakter ? Math.round((resultat / d.intakter) * 1000) / 10 : 0,
    };
  });

  let ack = 0;
  const ackResultatArr = plRows.map(d => { if (!d) return 0; ack += d.resultat; return ack; });

  const plFields = ['intakter', 'ravaror', 'ovriga_kostnader', 'personalkostnad', 'ovriga_rorelsekostnader', 'finansiella', 'skatt'];
  const plTotal = {};
  for (const f of plFields) plTotal[f] = plRows.reduce((s, d) => s + (d ? (d[f] || 0) : 0), 0);
  plTotal.bruttovinst = plTotal.intakter - plTotal.ravaror;
  plTotal.rorelseresultat = plTotal.bruttovinst - plTotal.ovriga_kostnader - plTotal.personalkostnad - plTotal.ovriga_rorelsekostnader;
  plTotal.resultat_fore_skatt = plTotal.rorelseresultat + plTotal.finansiella;
  plTotal.resultat = plTotal.resultat_fore_skatt - plTotal.skatt;
  plTotal.ovriga_pct = plTotal.intakter ? Math.round((plTotal.ovriga_kostnader / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.personal_pct = plTotal.intakter ? Math.round((plTotal.personalkostnad / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.rorelseresultat_pct = plTotal.intakter ? Math.round((plTotal.rorelseresultat / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.resultat_pct = plTotal.intakter ? Math.round((plTotal.resultat / plTotal.intakter) * 1000) / 10 : 0;
  plTotal.kassa_bank = [...plRows].reverse().find(d => d)?.kassa_bank || 0;

  const kpiFields = ['rapporterade_h', 'interntid_h', 'franvaro_h', 'debiterade_h'];
  const kpiTotal = {};
  for (const f of kpiFields) kpiTotal[f] = kpi.reduce((s, d) => s + (d ? d[f] : 0), 0);
  const tillganglig = kpiTotal.rapporterade_h - kpiTotal.franvaro_h;
  kpiTotal.debiteringsgrad = tillganglig > 0 ? Math.round((kpiTotal.debiterade_h / tillganglig) * 1000) / 10 : 0;
  kpiTotal.intakt_per_h = kpiTotal.debiterade_h > 0 ? Math.round(plTotal.intakter / kpiTotal.debiterade_h) : 0;

  const srFields = ['tjanster', 'varor', 'dima', 'supportavtal', 'hemsidor', 'layout'];
  const srTotal = {};
  for (const f of srFields) srTotal[f] = serviceRevenue.reduce((s, d) => s + (d ? (d[f] || 0) : 0), 0);

  const budgetTotal = {
    intakter: budget.reduce((s, d) => s + (d ? (d.intakter || 0) : 0), 0),
  };

  // Forecast: fill months where service_revenue has no actual revenue,
  // plus the current (incomplete) month which gets both utfall + prognos
  let forecastData = new Array(12).fill(null);
  try {
    const forecast = await calculateForecast(year);
    const nowMonth = new Date().getMonth();
    const curFyIdx = year === currentFY ? (nowMonth + 3) % 12 : -1;
    forecastData = serviceRevenue.map((sr, i) => {
      if (i === curFyIdx) return forecast[i];
      const hasRevenue = sr && srFields.some(f => sr[f] > 0);
      return hasRevenue ? null : forecast[i];
    });
  } catch (e) {
    console.error('Forecast calculation failed:', e.message);
  }

  res.json({
    year, yearLabel: `${year - 1}/${String(year).slice(2)}`, monthNames: MONTH_NAMES,
    plRows, plTotal, ackResultatArr, kpi, kpiTotal, serviceRevenue, srTotal,
    budget, budgetTotal, forecastData,
  });
  } catch (e) {
    console.error('Ekonomi API error:', e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// Public support contracts API (secured by API key, no session needed)
app.get('/api/public/support-contracts', async (req, res) => {
  const apiKey = process.env.EKONOMI_API_KEY;
  if (apiKey && req.headers['x-api-key'] !== apiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { PrismaClient } = require('./generated/prisma');
  const prisma = new PrismaClient();

  try {
    const projects = await prisma.project.findMany({
      where: {
        category: 'Supportavtal',
        isCompleted: false,
      },
      include: {
        customer: { select: { name: true } },
      },
      orderBy: { title: 'asc' },
    });

    const contracts = projects.map(p => ({
      id: p.id,
      blikkProjectId: p.blikkProjectId,
      title: p.title,
      customerName: p.customer?.name || 'Okänd kund',
      monthlyPrice: p.monthlyPrice || 0,
      billingInterval: p.billingInterval,
      status: p.status,
    }));

    res.json({ contracts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await prisma.$disconnect();
  }
});

// Cron endpoint (secured by CRON_SECRET, no session needed)
app.get('/api/cron/daily-sync', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = {};
  try {
    const { syncBlikkProjects } = require('./services/blikk-sync');
    results.projects = await syncBlikkProjects();
  } catch (e) { results.projects = { error: e.message }; }

  try {
    const { syncBlikkContacts } = require('./services/blikk-sync');
    results.contacts = await syncBlikkContacts();
  } catch (e) { results.contacts = { error: e.message }; }

  try {
    const { syncSpirisCustomers } = require('./services/spiris-sync');
    results.vismaCustomers = await syncSpirisCustomers();
  } catch (e) { results.vismaCustomers = { error: e.message }; }

  try {
    const { syncSpirisArticles } = require('./services/spiris-sync');
    results.vismaArticles = await syncSpirisArticles();
  } catch (e) { results.vismaArticles = { error: e.message }; }

  // Ekonomi sync: P&L + service revenue for current fiscal year
  try {
    const { syncVismaFinancials, syncServiceRevenue } = require('./services/ekonomi-sync');
    const now = new Date();
    const fyYear = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
    results.ekonomiPl = await syncVismaFinancials(fyYear);
    results.ekonomiSr = await syncServiceRevenue(fyYear);
  } catch (e) { results.ekonomi = { error: e.message }; }

  res.json({ success: true, timestamp: new Date().toISOString(), results });
});

// Routes
app.use('/', require('./routes/auth'));
app.use('/', requireAuth, require('./routes/dashboard'));
app.use('/invoices', requireAuth, require('./routes/invoices'));
app.use('/batches', requireAuth, require('./routes/batches'));
app.use('/hosting', requireAuth, require('./routes/hosting'));
app.use('/projects', requireAuth, require('./routes/projects'));
app.use('/customers', requireAuth, require('./routes/customers'));
app.use('/ekonomi', requireAuth, require('./routes/ekonomi'));
app.use('/settings', requireAuth, require('./routes/settings'));
app.use('/api', requireAuth, require('./routes/api'));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`FakturaFlöde running on http://localhost:${PORT}`);
  });
}

module.exports = app;
