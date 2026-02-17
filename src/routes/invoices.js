const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');

const router = Router();
const prisma = new PrismaClient();

// Review page — pending invoices
router.get('/review', async (req, res) => {
  const { service, search, status } = req.query;
  const where = {};

  if (status) {
    where.status = status;
  } else {
    where.status = 'pending_review';
  }

  if (service) where.serviceType = service;
  if (search) {
    where.customer = { name: { contains: search, mode: 'insensitive' } };
  }

  const invoices = await prisma.invoice.findMany({
    where,
    include: { customer: true, lines: { include: { article: true }, orderBy: { sortOrder: 'asc' } } },
    orderBy: { totalAmount: 'desc' },
  });

  const isHtmx = req.headers['hx-request'];
  if (isHtmx) {
    return res.render('partials/invoice-table', { invoices });
  }

  res.render('review', { invoices, filters: { service, search, status } });
});

// All invoices
router.get('/', async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    include: { customer: true, batch: true },
    orderBy: { id: 'desc' },
  });

  res.render('invoices', { invoices });
});

// Bulk approve
router.post('/approve', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [Number(req.body.ids)];

  await prisma.invoice.updateMany({
    where: { id: { in: ids }, status: 'pending_review' },
    data: { status: 'approved' },
  });

  res.redirect('/invoices/review');
});

// Bulk skip
router.post('/skip', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [Number(req.body.ids)];

  await prisma.invoice.updateMany({
    where: { id: { in: ids }, status: 'pending_review' },
    data: { status: 'skipped' },
  });

  res.redirect('/invoices/review');
});

// Update single invoice line (htmx)
router.patch('/:invoiceId/lines/:lineId', async (req, res) => {
  const { text, unitPrice, quantity } = req.body;
  const lineId = Number(req.params.lineId);

  const updates = {};
  if (text !== undefined) updates.text = text;
  if (unitPrice !== undefined) updates.unitPrice = parseFloat(unitPrice);
  if (quantity !== undefined) updates.quantity = parseFloat(quantity);
  if (updates.unitPrice || updates.quantity) {
    const line = await prisma.invoiceLine.findUnique({ where: { id: lineId } });
    const qty = updates.quantity || line.quantity;
    const price = updates.unitPrice || line.unitPrice;
    updates.lineTotal = qty * price * (1 - line.discount / 100);
  }

  const updated = await prisma.invoiceLine.update({
    where: { id: lineId },
    data: updates,
    include: { article: true },
  });

  // Recalc invoice total
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: Number(req.params.invoiceId) } });
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  await prisma.invoice.update({
    where: { id: Number(req.params.invoiceId) },
    data: { totalAmount: total },
  });

  res.render('partials/invoice-row', { line: updated });
});

module.exports = router;
