const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { distribute } = require('../services/distributor');

const router = Router();
const prisma = new PrismaClient();

// Batch overview
router.get('/', async (req, res) => {
  const now = new Date();
  const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const batches = await prisma.batch.findMany({
    where: { invoiceMonth: currentMonth },
    orderBy: { weekNumber: 'asc' },
    include: {
      invoices: { include: { customer: true } },
    },
  });

  res.render('batches', { batches, currentMonth });
});

// Run distribution for a month
router.post('/distribute', async (req, res) => {
  const month = req.body.month
    ? new Date(req.body.month + '-01')
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  await distribute(month);
  res.redirect('/batches');
});

module.exports = router;
