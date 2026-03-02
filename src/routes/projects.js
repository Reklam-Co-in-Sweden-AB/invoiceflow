const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');
const { INTERVAL_MULTIPLIER, effectivePrice, isDueForMonth } = require('../utils/billing');

const router = Router();
const prisma = new PrismaClient();

// Service categories that represent recurring monthly invoicing
const RECURRING_CATEGORIES = ['Din Marknadskoordinator', 'Supportavtal'];

function classifyProject(p) {
  if (p.category === 'Webbhotell & domän') return 'Webbhotell & domän';
  if (RECURRING_CATEGORIES.includes(p.category)) return p.category;
  if (p.invoiceType === 'Ongoing') return 'Löpande uppdrag';
  if (p.invoiceType === 'FixedPrice') return 'Fastprisprojekt';
  return 'Övrigt';
}

// Section order for display
const SECTION_ORDER = [
  'Din Marknadskoordinator',
  'Supportavtal',
  'Webbhotell & domän',
  'Löpande uppdrag',
  'Fastprisprojekt',
  'Övrigt',
];

const SECTION_META = {
  'Din Marknadskoordinator': { icon: 'recurring', desc: 'Månadsvis marknadskoordinering' },
  'Supportavtal':           { icon: 'recurring', desc: 'Löpande supportavtal' },
  'Webbhotell & domän':     { icon: 'hosting',   desc: 'Webbhotell och domännamn' },
  'Löpande uppdrag':        { icon: 'ongoing',   desc: 'Pågående uppdrag utan fast kategori' },
  'Fastprisprojekt':        { icon: 'fixed',     desc: 'Projekt med fast pris' },
  'Övrigt':                 { icon: 'other',     desc: 'Övriga projekt' },
};

/**
 * Suggest invoice week (1-4) to distribute amounts evenly.
 * Projects with a set invoiceWeek are respected, new ones fill the lightest week.
 */

function suggestWeeks(projects) {
  const weekTotals = [0, 0, 0, 0]; // week 1-4

  // First pass: count already assigned (only due projects)
  for (const p of projects) {
    const price = effectivePrice(p);
    if (p.invoiceWeek && price && p._isDue) {
      weekTotals[p.invoiceWeek - 1] += price;
    }
  }

  // Second pass: suggest for unassigned (only due projects)
  const suggestions = {};
  const unassigned = projects.filter(p => !p.invoiceWeek && effectivePrice(p) && p._isDue);
  // Sort by price desc so big amounts get placed first
  unassigned.sort((a, b) => effectivePrice(b) - effectivePrice(a));

  for (const p of unassigned) {
    const price = effectivePrice(p);
    const minWeek = weekTotals.indexOf(Math.min(...weekTotals));
    suggestions[p.id] = minWeek + 1;
    weekTotals[minWeek] += price;
  }

  return { suggestions, weekTotals };
}

/**
 * Check if a project is already invoiced for a given month.
 */
function isInvoicedForMonth(project, monthStart) {
  if (!project.lastInvoicedMonth) return false;
  const d = new Date(project.lastInvoicedMonth);
  return d.getFullYear() === monthStart.getFullYear() && d.getMonth() === monthStart.getMonth();
}


/**
 * Determine which week of the month (1-4) we're currently in.
 */
function currentWeekOfMonth() {
  const now = new Date();
  return Math.min(4, Math.ceil(now.getDate() / 7));
}

router.get('/', async (req, res) => {
  const showCompleted = req.query.completed === '1';
  const weekFilter = req.query.week ? parseInt(req.query.week) : null; // 1-4 or null for all

  // Month navigation: ?month=2026-04
  const now = new Date();
  let viewMonth;
  if (req.query.month) {
    const [y, m] = req.query.month.split('-').map(Number);
    viewMonth = new Date(y, m - 1, 1);
  } else {
    viewMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const isCurrentMonth = viewMonth.getFullYear() === now.getFullYear() && viewMonth.getMonth() === now.getMonth();

  const projects = await prisma.project.findMany({
    where: showCompleted ? {} : { isCompleted: false },
    include: { customer: true, billingSplits: true, invoiceRows: true },
    orderBy: { title: 'asc' },
  });

  const activeWeek = isCurrentMonth ? currentWeekOfMonth() : null;

  // Mark invoiced, paused, and due status on each project
  for (const p of projects) {
    p._invoicedThisMonth = isInvoicedForMonth(p, viewMonth);
    p._isPaused = p.pauseFrom && p.pauseUntil &&
      new Date(p.pauseFrom) <= now && new Date(p.pauseUntil) >= now;
    p._isDue = isDueForMonth(p, viewMonth);
  }

  // Filter by week if requested
  let filtered = projects;
  if (weekFilter) {
    filtered = projects.filter(p => {
      // Show projects assigned to this week (or suggested for it)
      return p.invoiceWeek === weekFilter;
    });
  }

  // Group into sections (only non-invoiced for billing view, unless showing all)
  const sections = {};
  for (const p of filtered) {
    const section = classifyProject(p);
    if (!sections[section]) sections[section] = { ...SECTION_META[section], projects: [] };
    sections[section].projects.push(p);
  }

  // Sort sections by defined order
  const orderedSections = {};
  for (const key of SECTION_ORDER) {
    if (sections[key]) orderedSections[key] = sections[key];
  }

  // Auto-assign weeks for projects without one
  const { suggestions, weekTotals } = suggestWeeks(projects);
  const toAssign = Object.entries(suggestions);
  if (toAssign.length > 0) {
    await Promise.all(toAssign.map(([id, week]) =>
      prisma.project.update({ where: { id: Number(id) }, data: { invoiceWeek: week } })
    ));
    // Apply to in-memory objects too
    for (const [id, week] of toAssign) {
      const p = projects.find(pr => pr.id === Number(id));
      if (p) p.invoiceWeek = week;
    }
  }

  // Count per week for tab badges (only due projects)
  const weekCounts = [0, 0, 0, 0];
  const weekInvoiced = [0, 0, 0, 0];
  const weekInvoicedTotals = [0, 0, 0, 0];
  for (const p of projects) {
    if (p.invoiceWeek && effectivePrice(p) && p._isDue) {
      weekCounts[p.invoiceWeek - 1]++;
      if (p._invoicedThisMonth) {
        weekInvoiced[p.invoiceWeek - 1]++;
        weekInvoicedTotals[p.invoiceWeek - 1] += effectivePrice(p);
      }
    }
  }

  const customers = await prisma.customer.findMany({ orderBy: { name: 'asc' } });
  const articles = await prisma.article.findMany({ orderBy: { articleNumber: 'asc' } });

  // Month navigation data
  const monthNames = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];
  const prevMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
  const nextMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
  const viewMonthLabel = monthNames[viewMonth.getMonth()] + ' ' + viewMonth.getFullYear();
  const viewMonthKey = viewMonth.toISOString().slice(0, 7); // "2026-02"

  res.render('projects', {
    projects: filtered,
    allProjects: projects,
    sections: orderedSections,
    suggestions,
    weekTotals,
    weekCounts,
    weekInvoiced,
    weekInvoicedTotals,
    showCompleted,
    weekFilter,
    activeWeek,
    isCurrentMonth,
    viewMonth,
    viewMonthLabel,
    viewMonthKey,
    prevMonthKey: prevMonth.toISOString().slice(0, 7),
    nextMonthKey: nextMonth.toISOString().slice(0, 7),
    customers,
    articles,
    pageTitle: 'Projekt',
  });
});

// Project detail page
router.get('/:id', async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: Number(req.params.id) },
    include: {
      customer: true,
      article: true,
      priceOverrides: { orderBy: { month: 'asc' } },
      invoiceRows: { include: { article: true }, orderBy: { sortOrder: 'asc' } },
      billingSplits: { include: { customer: true }, orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!project) return res.status(404).send('Projektet hittades inte');

  const articles = await prisma.article.findMany({ orderBy: { articleNumber: 'asc' } });
  const vismaCustomers = await prisma.customer.findMany({
    where: { vismaCustomerId: { not: null } },
    orderBy: { name: 'asc' },
  });

  res.render('project-detail', {
    project,
    articles,
    vismaCustomers,
    overrides: project.priceOverrides,
    pageTitle: project.title,
  });
});

module.exports = router;
