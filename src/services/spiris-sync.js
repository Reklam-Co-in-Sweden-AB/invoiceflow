const { PrismaClient } = require('../generated/prisma');
const { SpirisClient } = require('./spiris-client');

const prisma = new PrismaClient();

/**
 * Sync articles from Spiris (Visma eEkonomi).
 * Matches on article number and stores the Visma UUID locally.
 * Creates new local articles for Visma articles that don't exist locally.
 */
async function syncSpirisArticles() {
  const client = new SpirisClient();
  const all = [];
  let page = 1;

  while (true) {
    const data = await client.getArticles(page, 100);
    const items = data.Data || data.data || data;
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    if (items.length < 100) break;
    page++;
  }

  let matched = 0;
  let created = 0;
  let skipped = 0;

  for (const art of all) {
    const vismaId = art.Id || art.id;
    const number = art.Number || art.number || '';
    const name = art.Name || art.name || '';
    const netPrice = art.NetPrice || art.net_price || 0;

    if (!number) { skipped++; continue; }

    // Try to match on article number
    const local = await prisma.article.findUnique({
      where: { articleNumber: number },
    });

    if (local) {
      await prisma.article.update({
        where: { id: local.id },
        data: { vismaArticleId: vismaId },
      });
      matched++;
    } else {
      await prisma.article.create({
        data: {
          articleNumber: number,
          name: name || `Artikel ${number}`,
          vismaArticleId: vismaId,
          serviceType: 'övrigt',
          defaultPrice: netPrice,
        },
      });
      created++;
    }
  }

  return { total: all.length, matched, created, skipped };
}

/**
 * Sync customers from Spiris (Visma eEkonomi).
 * Matches on customer number or org number and stores the Visma UUID locally.
 */
async function syncSpirisCustomers() {
  const client = new SpirisClient();
  const all = [];
  let page = 1;

  while (true) {
    const data = await client.getCustomers(page, 100);
    const items = data.Data || data.data || data;
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    if (items.length < 100) break;
    page++;
  }

  let matchedByOrg = 0;
  let matchedByNumber = 0;
  let matchedByName = 0;
  let skipped = 0;

  for (const cust of all) {
    const vismaId = cust.Id || cust.id;
    const name = cust.Name || cust.name || '';
    const custNumber = cust.CustomerNumber || cust.customer_number || '';
    const orgNumber = cust.CorporateIdentityNumber || cust.corporate_identity_number || '';

    if (!vismaId) { skipped++; continue; }

    // Priority 1: Match by org number (most reliable)
    let local = null;
    let matchType = '';
    if (orgNumber) {
      local = await prisma.customer.findFirst({
        where: { orgNumber: orgNumber, vismaCustomerId: null },
      });
      if (local) matchType = 'org';
    }

    // Priority 2: Match by customer number
    if (!local && custNumber) {
      local = await prisma.customer.findFirst({
        where: { customerNumber: custNumber, vismaCustomerId: null },
      });
      if (local) matchType = 'number';
    }

    // Priority 3: Match by exact name (trimmed)
    if (!local && name) {
      local = await prisma.customer.findFirst({
        where: { name: name.trim(), vismaCustomerId: null },
      });
      if (local) matchType = 'name';
    }

    if (local) {
      await prisma.customer.update({
        where: { id: local.id },
        data: { vismaCustomerId: vismaId },
      });
      if (matchType === 'org') matchedByOrg++;
      else if (matchType === 'number') matchedByNumber++;
      else matchedByName++;
    } else {
      skipped++;
    }
  }

  const matched = matchedByOrg + matchedByNumber + matchedByName;
  return { total: all.length, matched, matchedByOrg, matchedByNumber, matchedByName, skipped };
}

module.exports = { syncSpirisArticles, syncSpirisCustomers };
