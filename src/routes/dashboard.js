const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');
const { effectivePrice, isDueForMonth } = require('../utils/billing');
const { calculateForecast } = require('../services/forecast');

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const now = new Date();
  const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Active projects with billing data
  const projects = await prisma.project.findMany({
    where: { isCompleted: false },
    include: { customer: true, billingSplits: true, invoiceRows: true },
  });

  // Classify projects for the current month
  const dueProjects = [];
  const invoicedProjects = [];
  const weekTotals = [0, 0, 0, 0];
  const weekCounts = [0, 0, 0, 0];

  for (const p of projects) {
    const price = effectivePrice(p);
    if (!price) continue;

    const isPaused = p.pauseFrom && p.pauseUntil &&
      new Date(p.pauseFrom) <= now && new Date(p.pauseUntil) >= now;
    if (isPaused) continue;

    if (!isDueForMonth(p, currentMonth)) continue;

    const invoiced = p.lastInvoicedMonth &&
      new Date(p.lastInvoicedMonth).getFullYear() === currentMonth.getFullYear() &&
      new Date(p.lastInvoicedMonth).getMonth() === currentMonth.getMonth();

    if (invoiced) {
      invoicedProjects.push({ ...p, _price: price });
    } else {
      dueProjects.push({ ...p, _price: price });
    }

    if (p.invoiceWeek) {
      weekTotals[p.invoiceWeek - 1] += price;
      weekCounts[p.invoiceWeek - 1]++;
    }
  }

  const dueCount = dueProjects.length;
  const dueAmount = dueProjects.reduce((s, p) => s + p._price, 0);
  const invoicedCount = invoicedProjects.length;
  const invoicedAmount = invoicedProjects.reduce((s, p) => s + p._price, 0);

  // Forecast for current month
  const fyYear = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  const fyIndex = (now.getMonth() + 3) % 12;
  const forecast = await calculateForecast(fyYear);
  const fcMonth = forecast[fyIndex];
  const forecastTotal = Object.values(fcMonth).reduce((s, v) => s + v, 0);

  // Hosting MRR
  const hostingSubs = await prisma.hostingSubscription.findMany({
    where: { isActive: true },
    include: { lines: true },
  });
  const mrr = hostingSubs.reduce((sum, sub) => {
    const subTotal = sub.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const multiplier = { monthly: 1, quarterly: 1/3, semi_annual: 1/6, annual: 1/12 }[sub.billingInterval] || 1;
    return sum + subTotal * multiplier;
  }, 0);

  // Recent sync logs
  const recentLogs = await prisma.syncLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { invoice: true },
  });

  res.render('dashboard', {
    currentMonth,
    dueCount, dueAmount,
    invoicedCount, invoicedAmount,
    forecastTotal,
    mrr,
    hostingActiveCount: hostingSubs.length,
    weekTotals, weekCounts,
    recentLogs,
    topDue: dueProjects.slice(0, 5),
  });
});

module.exports = router;
