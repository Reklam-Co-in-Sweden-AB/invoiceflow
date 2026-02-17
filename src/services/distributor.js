const { PrismaClient } = require('../generated/prisma');
const prisma = new PrismaClient();

/**
 * Get the 4 Mondays of a given month.
 */
function getMondays(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const mondays = [];

  for (let day = 1; day <= 28; day++) {
    const d = new Date(year, month, day);
    if (d.getDay() === 1) {
      mondays.push(d);
      if (mondays.length === 4) break;
    }
  }

  // If month starts late and we don't have 4, pad with last days
  while (mondays.length < 4) {
    const last = mondays[mondays.length - 1];
    mondays.push(new Date(last.getTime() + 7 * 24 * 60 * 60 * 1000));
  }

  return mondays;
}

/**
 * LPT distribution algorithm.
 * Assigns approved invoices to 4 weekly batches with even monetary distribution.
 */
async function distribute(monthDate) {
  const mondays = getMondays(monthDate);

  // Create or find batches for this month
  const batches = [];
  for (let i = 0; i < 4; i++) {
    let batch = await prisma.batch.findFirst({
      where: {
        invoiceMonth: monthDate,
        weekNumber: i + 1,
      },
    });

    if (!batch) {
      batch = await prisma.batch.create({
        data: {
          invoiceMonth: monthDate,
          weekNumber: i + 1,
          scheduledDate: mondays[i],
          invoiceCount: 0,
          totalAmount: 0,
        },
      });
    }

    batches.push({ ...batch, runningTotal: 0 });
  }

  // Get approved invoices not yet scheduled
  const invoices = await prisma.invoice.findMany({
    where: {
      invoiceMonth: monthDate,
      status: 'approved',
      batchId: null,
    },
    orderBy: { totalAmount: 'desc' },
  });

  // LPT: assign each invoice to the batch with lowest running total
  for (const invoice of invoices) {
    const minBatch = batches.reduce((min, b) =>
      b.runningTotal < min.runningTotal ? b : min
    );

    minBatch.runningTotal += invoice.totalAmount;

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'scheduled',
        batchId: minBatch.id,
        scheduledWeek: minBatch.weekNumber,
        scheduledDate: minBatch.scheduledDate,
      },
    });
  }

  // Update batch totals
  for (const batch of batches) {
    const agg = await prisma.invoice.aggregate({
      where: { batchId: batch.id },
      _sum: { totalAmount: true },
      _count: true,
    });

    await prisma.batch.update({
      where: { id: batch.id },
      data: {
        totalAmount: agg._sum.totalAmount || 0,
        invoiceCount: agg._count || 0,
      },
    });
  }

  return batches;
}

module.exports = { distribute, getMondays };
