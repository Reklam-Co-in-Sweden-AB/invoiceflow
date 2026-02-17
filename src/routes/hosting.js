const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const subscriptions = await prisma.hostingSubscription.findMany({
    include: { customer: true, lines: { include: { article: true } } },
    orderBy: { nextBillingDate: 'asc' },
  });

  const activeCount = subscriptions.filter(s => s.isActive).length;
  const mrr = subscriptions
    .filter(s => s.isActive)
    .reduce((sum, sub) => {
      const subTotal = sub.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      const multiplier = { monthly: 1, quarterly: 1/3, semi_annual: 1/6, annual: 1/12 }[sub.billingInterval] || 1;
      return sum + subTotal * multiplier;
    }, 0);

  res.render('hosting', { subscriptions, activeCount, mrr });
});

router.post('/', async (req, res) => {
  const { customerId, domain, billingInterval, nextBillingDate, notes, lines } = req.body;

  const sub = await prisma.hostingSubscription.create({
    data: {
      customerId: Number(customerId),
      domain,
      billingInterval,
      nextBillingDate: new Date(nextBillingDate),
      notes: notes || null,
    },
  });

  // Create lines if provided
  if (lines && Array.isArray(lines)) {
    for (const line of lines) {
      await prisma.hostingSubscriptionLine.create({
        data: {
          subscriptionId: sub.id,
          articleId: Number(line.articleId),
          description: line.description,
          quantity: parseFloat(line.quantity) || 1,
          unitPrice: parseFloat(line.unitPrice),
        },
      });
    }
  }

  res.redirect('/hosting');
});

router.post('/:id/toggle', async (req, res) => {
  const sub = await prisma.hostingSubscription.findUnique({ where: { id: Number(req.params.id) } });
  await prisma.hostingSubscription.update({
    where: { id: sub.id },
    data: { isActive: !sub.isActive },
  });
  res.redirect('/hosting');
});

module.exports = router;
