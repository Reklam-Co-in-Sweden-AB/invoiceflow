const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const customers = await prisma.customer.findMany({
    include: {
      invoices: { select: { totalAmount: true, serviceType: true } },
      hostingSubscriptions: { where: { isActive: true }, select: { id: true } },
      projects: { where: { isCompleted: false }, select: { id: true } },
    },
    orderBy: { name: 'asc' },
  });

  res.render('customers', { customers });
});

router.post('/', async (req, res) => {
  const { customerNumber, name, orgNumber, email, yourReference, ourReference } = req.body;

  await prisma.customer.create({
    data: {
      customerNumber,
      name,
      orgNumber: orgNumber || null,
      email: email || null,
      yourReference: yourReference || null,
      ourReference: ourReference || null,
    },
  });

  res.redirect('/customers');
});

module.exports = router;
