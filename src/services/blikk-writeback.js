const { PrismaClient } = require('../generated/prisma');
const { BlikkClient } = require('./blikk-client');

const prisma = new PrismaClient();

/**
 * Write back exported invoices to Blikk.
 * Marks them as sent to economy system with the Visma invoice number.
 */
async function writebackToBlikk(invoiceIds) {
  const client = new BlikkClient();
  const results = { success: 0, failed: 0, errors: [] };

  const invoices = await prisma.invoice.findMany({
    where: {
      id: { in: invoiceIds },
      status: 'exported',
      blikkInvoiceId: { not: null },
    },
  });

  for (const invoice of invoices) {
    const log = await prisma.syncLog.create({
      data: {
        type: 'blikk_writeback',
        status: 'started',
        invoiceId: invoice.id,
      },
    });

    try {
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      await client.markAsSent(
        invoice.blikkInvoiceId,
        date,
        invoice.vismaInvoiceNumber || invoice.vismaDraftId || ''
      );

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'confirmed',
          blikkWritebackAt: new Date(),
        },
      });

      await prisma.syncLog.update({
        where: { id: log.id },
        data: {
          status: 'completed',
          details: JSON.stringify({
            blikkInvoiceId: invoice.blikkInvoiceId,
            date,
            vismaNumber: invoice.vismaInvoiceNumber,
          }),
        },
      });

      results.success++;
    } catch (error) {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'failed',
          errorMessage: `Blikk writeback: ${error.message}`,
        },
      });

      await prisma.syncLog.update({
        where: { id: log.id },
        data: {
          status: 'failed',
          error: error.message,
        },
      });

      results.failed++;
      results.errors.push({ invoiceId: invoice.id, error: error.message });
    }
  }

  return results;
}

module.exports = { writebackToBlikk };
