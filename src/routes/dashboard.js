const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  // Get current month (first day)
  const now = new Date();
  const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Invoice stats for current month
  const invoices = await prisma.invoice.findMany({
    where: { invoiceMonth: currentMonth },
    include: { customer: true },
  });

  const totalCount = invoices.length;
  const totalAmount = invoices.reduce((s, i) => s + i.totalAmount, 0);

  const pendingInvoices = invoices.filter(i => i.status === 'pending_review');
  const pendingCount = pendingInvoices.length;
  const pendingAmount = pendingInvoices.reduce((s, i) => s + i.totalAmount, 0);

  const approvedStatuses = ['approved', 'scheduled', 'exporting', 'exported', 'confirmed'];
  const approvedInvoices = invoices.filter(i => approvedStatuses.includes(i.status));
  const approvedCount = approvedInvoices.length;
  const approvedAmount = approvedInvoices.reduce((s, i) => s + i.totalAmount, 0);

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

  // Batches for current month
  const batches = await prisma.batch.findMany({
    where: { invoiceMonth: currentMonth },
    orderBy: { weekNumber: 'asc' },
    include: { invoices: true },
  });

  // Recent sync logs
  const recentLogs = await prisma.syncLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { invoice: true },
  });

  // Top 5 pending for quick view
  const topPending = pendingInvoices.slice(0, 5);

  res.render('dashboard', {
    currentMonth,
    totalCount, totalAmount,
    approvedCount, approvedAmount,
    pendingCount, pendingAmount,
    mrr,
    hostingActiveCount: hostingSubs.length,
    batches,
    recentLogs,
    topPending,
  });
});

module.exports = router;
