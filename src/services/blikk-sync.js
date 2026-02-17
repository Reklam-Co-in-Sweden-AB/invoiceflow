const { PrismaClient } = require('../generated/prisma');
const { BlikkClient } = require('./blikk-client');
const { getMonthLabel, getInvoiceMonth, appendMonthLabel } = require('./month-label');

const prisma = new PrismaClient();

// Map article numbers to service types
const ARTICLE_SERVICE_MAP = {
  '101': 'marknadskoordinator',
  '103': 'marknadskoordinator',
  '108': 'supportavtal',
  '211': 'supportavtal',
  '2101': 'supportavtal',
};

/**
 * Determine service type from Blikk invoice rows.
 */
function detectServiceType(rows) {
  for (const row of rows) {
    if (row.isHeader || row.isSumRow) continue;
    const artNum = String(row.articleNumber || '');
    if (ARTICLE_SERVICE_MAP[artNum]) {
      return ARTICLE_SERVICE_MAP[artNum];
    }
  }
  return 'supportavtal';
}

/**
 * Filter to only actual data rows (skip headers and sum rows).
 */
function getDataRows(rows) {
  return (rows || []).filter(r => !r.isHeader && !r.isSumRow);
}

/**
 * Sync invoices from Blikk that haven't been sent to economy system.
 * Only syncs invoices from the specified month (default: current month).
 */
async function syncBlikkInvoices(options = {}) {
  const client = new BlikkClient();
  const log = await prisma.syncLog.create({
    data: { type: 'blikk_sync', status: 'started' },
  });

  try {
    // Fetch all invoices (paginated)
    const allInvoices = await client.getAllInvoices();

    // Filter for unsent invoices
    let candidates = allInvoices.filter(inv => !inv.sentToEconomySystem);

    // Optionally filter by month
    let monthName = 'alla';
    if (options.month) {
      const targetMonth = new Date(options.month + '-01');
      const monthStart = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1);
      const monthEnd = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0);
      monthName = getMonthLabel(targetMonth);

      candidates = candidates.filter(inv => {
        const invDate = new Date(inv.fromDate || inv.invoiceDate);
        return invDate >= monthStart && invDate <= monthEnd;
      });
    }

    let created = 0;
    let skipped = 0;

    for (const blikkInv of candidates) {
      const blikkId = blikkInv.id;

      // Deduplication check
      const existing = await prisma.invoice.findUnique({
        where: { blikkInvoiceId: blikkId },
      });

      if (existing) {
        skipped++;
        continue;
      }

      // Fetch invoice detail to get rows
      const detail = await client.getInvoice(blikkId);
      const allRows = detail.rows || [];
      const dataRows = getDataRows(allRows);

      // Find or create customer
      const contactId = blikkInv.customer?.id;
      let customer = null;

      if (contactId) {
        customer = await prisma.customer.findUnique({
          where: { blikkContactId: contactId },
        });

        if (!customer) {
          customer = await prisma.customer.create({
            data: {
              blikkContactId: contactId,
              customerNumber: String(contactId),
              name: (blikkInv.customer?.name || `Kund ${contactId}`).trim(),
            },
          });
        }
      }

      if (!customer) {
        customer = await prisma.customer.create({
          data: {
            customerNumber: `BLIKK-${blikkId}`,
            name: `Okänd kund (faktura ${blikkId})`,
          },
        });
      }

      // Determine dates and month label
      const fromDate = new Date(blikkInv.fromDate || blikkInv.invoiceDate);
      const toDate = blikkInv.toDate ? new Date(blikkInv.toDate) : fromDate;
      const invoiceMonth = getInvoiceMonth(fromDate, toDate);
      const monthLabel = getMonthLabel(invoiceMonth);

      // Detect service type from rows
      const serviceType = detectServiceType(allRows);

      // Total from Blikk
      const totalAmount = detail.sum || blikkInv.sum || 0;

      // Create invoice
      const invoice = await prisma.invoice.create({
        data: {
          customerId: customer.id,
          blikkInvoiceId: blikkId,
          serviceType,
          invoiceMonth,
          monthLabel,
          fromDate,
          toDate,
          totalAmount,
          status: 'pending_review',
          blikkSyncedAt: new Date(),
        },
      });

      // Create invoice lines (only data rows, not headers/sums)
      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const artNum = String(row.articleNumber || '');
        const originalText = row.article || row.comment || artNum || 'Rad';
        const text = appendMonthLabel(originalText, monthLabel);

        // Find matching local article
        const article = artNum
          ? await prisma.article.findUnique({ where: { articleNumber: artNum } })
          : null;

        const quantity = row.value || 1;
        const unitPrice = row.rate || 0;
        const discount = row.discount || 0;
        const lineTotal = row.sum || (quantity * unitPrice * (1 - discount / 100));

        await prisma.invoiceLine.create({
          data: {
            invoiceId: invoice.id,
            articleId: article?.id || null,
            blikkRowId: row.id || null,
            text,
            quantity,
            unitPrice,
            discount,
            lineTotal,
            sortOrder: row.sortOrder ?? i,
          },
        });
      }

      created++;
    }

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: 'completed',
        details: JSON.stringify({
          month: monthName,
          totalInBlikk: allInvoices.length,
          unsentInMonth: candidates.length,
          created,
          skipped,
        }),
      },
    });

    return {
      month: monthName,
      totalInBlikk: allInvoices.length,
      unsentInMonth: candidates.length,
      created,
      skipped,
    };
  } catch (error) {
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'failed', error: error.message },
    });
    throw error;
  }
}

/**
 * Sync contacts from Blikk to local customers table.
 */
async function syncBlikkContacts() {
  const client = new BlikkClient();
  const contacts = await client.getAllContacts();

  let created = 0;
  let updated = 0;

  for (const contact of contacts) {
    const contactId = contact.id;
    const existing = await prisma.customer.findUnique({
      where: { blikkContactId: contactId },
    });

    const data = {
      name: (contact.name || `Kontakt ${contactId}`).trim(),
      customerNumber: String(contact.customerNumber || contactId),
      orgNumber: contact.organizationalOrSocialSecurityNumber || null,
      email: contact.email || null,
    };

    if (existing) {
      await prisma.customer.update({
        where: { id: existing.id },
        data,
      });
      updated++;
    } else {
      await prisma.customer.create({
        data: { ...data, blikkContactId: contactId },
      });
      created++;
    }
  }

  return { total: contacts.length, created, updated };
}

/**
 * Sync projects from Blikk to local projects table.
 */
async function syncBlikkProjects() {
  const client = new BlikkClient();
  const all = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const data = await client.get('/v1/Core/Projects', { page, pageSize });
    const items = data.items || data.data || data;
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    if (items.length < pageSize) break;
    page++;
  }

  let created = 0;
  let updated = 0;

  let customersLinked = 0;

  for (const listProj of all) {
    // Fetch detail to get invoice fields (yourReference, invoiceText, etc.)
    let proj;
    try {
      proj = await client.get(`/v1/Core/Projects/${listProj.id}`);
    } catch (e) {
      proj = listProj; // fallback to list data if detail fails
    }

    // Find or create local customer from Blikk contact
    const contactId = proj.customer?.id;
    let localCustomer = null;
    if (contactId) {
      localCustomer = await prisma.customer.findUnique({
        where: { blikkContactId: contactId },
      });

      if (!localCustomer) {
        localCustomer = await prisma.customer.create({
          data: {
            blikkContactId: contactId,
            customerNumber: String(contactId),
            name: (proj.customer?.name || `Kund ${contactId}`).trim(),
          },
        });
      }

      customersLinked++;
    }

    const data = {
      orderNumber: proj.orderNumber || null,
      title: (proj.title || '').trim(),
      category: proj.category?.name || null,
      categoryColor: proj.category?.color || null,
      invoiceType: proj.invoiceType || null,
      status: proj.status?.name || null,
      isCompleted: proj.status?.isCompletedStatus || false,
      startDate: proj.startDate ? new Date(proj.startDate) : null,
      endDate: proj.endDate ? new Date(proj.endDate) : null,
      customerId: localCustomer?.id || null,
      yourReference: proj.yourReference || null,
      ourReference: proj.ourReference || null,
      buyersOrderRef: proj.customerReferenceMarking || null,
      invoiceText: proj.invoiceText || null,
    };

    const existing = await prisma.project.findUnique({
      where: { blikkProjectId: proj.id },
    });

    if (existing) {
      await prisma.project.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.project.create({
        data: { ...data, blikkProjectId: proj.id },
      });
      created++;
    }
  }

  return { total: all.length, created, updated, customersLinked };
}

module.exports = { syncBlikkInvoices, syncBlikkContacts, syncBlikkProjects };
