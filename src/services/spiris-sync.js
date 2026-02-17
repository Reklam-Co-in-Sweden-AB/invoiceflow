const { PrismaClient } = require('../generated/prisma');
const { SpirisClient } = require('./spiris-client');

const prisma = new PrismaClient();

/**
 * Sync articles from Spiris (Visma eEkonomi).
 * Matches on article number and stores the Visma UUID locally.
 * Creates new local articles for Visma articles that don't exist locally.
 */
/**
 * Sync one page of articles from Spiris. Returns { done, page, matched, created, skipped, pageItems }.
 */
async function syncSpirisArticlesPage(page = 1) {
  const client = new SpirisClient();
  const pageSize = 50;
  const data = await client.getArticles(page, pageSize);
  const items = data.Data || data.data || data;

  if (!Array.isArray(items) || items.length === 0) {
    return { done: true, page, matched: 0, created: 0, skipped: 0, pageItems: 0 };
  }

  let matched = 0, created = 0, skipped = 0;

  for (const art of items) {
    const vismaId = art.Id || art.id;
    const number = art.Number || art.number || '';
    const name = art.Name || art.name || '';
    const netPrice = art.NetPrice || art.net_price || 0;

    if (!number) { skipped++; continue; }

    const local = await prisma.article.findUnique({ where: { articleNumber: number } });

    if (local) {
      await prisma.article.update({ where: { id: local.id }, data: { vismaArticleId: vismaId } });
      matched++;
    } else {
      await prisma.article.create({
        data: { articleNumber: number, name: name || `Artikel ${number}`, vismaArticleId: vismaId, serviceType: 'övrigt', defaultPrice: netPrice },
      });
      created++;
    }
  }

  return { done: items.length < pageSize, page, matched, created, skipped, pageItems: items.length };
}

/**
 * Sync one page of customers from Spiris. Returns { done, page, matched, skipped, pageItems }.
 */
async function syncSpirisCustomersPage(page = 1) {
  const client = new SpirisClient();
  const pageSize = 50;
  const data = await client.getCustomers(page, pageSize);
  const items = data.Data || data.data || data;

  if (!Array.isArray(items) || items.length === 0) {
    return { done: true, page, matched: 0, skipped: 0, pageItems: 0 };
  }

  let matched = 0, skipped = 0;

  for (const cust of items) {
    const vismaId = cust.Id || cust.id;
    const name = cust.Name || cust.name || '';
    const custNumber = cust.CustomerNumber || cust.customer_number || '';
    const orgNumber = cust.CorporateIdentityNumber || cust.corporate_identity_number || '';

    if (!vismaId) { skipped++; continue; }

    let local = null;
    if (orgNumber) local = await prisma.customer.findFirst({ where: { orgNumber } });
    if (!local && custNumber) local = await prisma.customer.findFirst({ where: { customerNumber: custNumber } });
    if (!local && name) local = await prisma.customer.findFirst({ where: { name: name.trim() } });

    if (local) {
      await prisma.customer.update({ where: { id: local.id }, data: { vismaCustomerId: vismaId } });
      matched++;
    } else {
      skipped++;
    }
  }

  return { done: items.length < pageSize, page, matched, skipped, pageItems: items.length };
}

/**
 * Full sync (for cron) — loops through all pages internally.
 */
async function syncSpirisArticles() {
  let page = 1, totalMatched = 0, totalCreated = 0, totalSkipped = 0, total = 0;
  while (true) {
    const r = await syncSpirisArticlesPage(page);
    total += r.pageItems; totalMatched += r.matched; totalCreated += r.created; totalSkipped += r.skipped;
    if (r.done) break;
    page++;
  }
  return { total, matched: totalMatched, created: totalCreated, skipped: totalSkipped };
}

async function syncSpirisCustomers() {
  let page = 1, totalMatched = 0, totalSkipped = 0, total = 0;
  while (true) {
    const r = await syncSpirisCustomersPage(page);
    total += r.pageItems; totalMatched += r.matched; totalSkipped += r.skipped;
    if (r.done) break;
    page++;
  }
  return { total, matched: totalMatched, skipped: totalSkipped };
}

module.exports = { syncSpirisArticles, syncSpirisCustomers, syncSpirisArticlesPage, syncSpirisCustomersPage };
