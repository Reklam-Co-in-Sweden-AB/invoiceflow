const { Router } = require('express');
const { PrismaClient } = require('../generated/prisma');

const router = Router();
const prisma = new PrismaClient();

// htmx endpoint: filtered invoice table
router.get('/invoices/table', async (req, res) => {
  const { service, search, status } = req.query;
  const where = {};

  if (status) where.status = status;
  if (service) where.serviceType = service;
  if (search) {
    where.customer = { name: { contains: search, mode: 'insensitive' } };
  }

  const invoices = await prisma.invoice.findMany({
    where,
    include: { customer: true, lines: { include: { article: true }, orderBy: { sortOrder: 'asc' } } },
    orderBy: { totalAmount: 'desc' },
  });

  res.render('partials/invoice-table', { invoices });
});

// htmx endpoint: toggle invoice expand
router.get('/invoices/:id/lines', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: Number(req.params.id) },
    include: { lines: { include: { article: true }, orderBy: { sortOrder: 'asc' } } },
  });

  res.render('partials/invoice-lines', { invoice });
});

// Dashboard chart data
router.get('/dashboard/chart-data', async (req, res) => {
  const now = new Date();
  const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const batches = await prisma.batch.findMany({
    where: { invoiceMonth: currentMonth },
    orderBy: { weekNumber: 'asc' },
  });

  res.json({
    labels: batches.map(b => `V.${b.weekNumber}`),
    amounts: batches.map(b => b.totalAmount),
  });
});

// Test Blikk API connection
router.post('/test/blikk', async (req, res) => {
  try {
    const { BlikkClient } = require('../services/blikk-client');
    const client = new BlikkClient();
    await client.authenticate();
    // Try a simple request to verify permissions
    const data = await client.get('/v1/Core/Contacts', { page: 1, pageSize: 1 });
    // Blikk may return { items: [...], totalCount: N } or { data: [...], total: N } or just an array
    const count = data.totalItemCount ?? data.totalCount ?? data.total ?? null;
    const info = count != null ? `${count} kontakter hittades` : 'Anslutning OK';
    res.json({ success: true, info });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Trigger Blikk sync (optional ?month=2026-02)
router.post('/sync/blikk', async (req, res) => {
  try {
    const { syncBlikkInvoices } = require('../services/blikk-sync');
    const options = {};
    if (req.query.month) options.month = req.query.month;
    const result = await syncBlikkInvoices(options);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger Blikk project sync
router.post('/sync/projects', async (req, res) => {
  try {
    const { syncBlikkProjects } = require('../services/blikk-sync');
    const result = await syncBlikkProjects();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Projects grouped by category
router.get('/projects', async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { isCompleted: false },
    include: { customer: true },
    orderBy: { title: 'asc' },
  });

  // Group by category
  const byCategory = {};
  for (const p of projects) {
    const cat = p.category || 'Okategoriserad';
    if (!byCategory[cat]) byCategory[cat] = { color: p.categoryColor, projects: [] };
    byCategory[cat].projects.push(p);
  }

  res.json(byCategory);
});

// Debug: show raw Blikk project (to see status field structure)
router.get('/debug/blikk-project/:blikkId', async (req, res) => {
  try {
    const { BlikkClient } = require('../services/blikk-client');
    const client = new BlikkClient();
    const data = await client.get(`/v1/Core/Projects/${req.params.blikkId}`);
    res.json(data);
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug: show Blikk project fields
router.get('/debug/blikk-project', async (req, res) => {
  try {
    const { BlikkClient } = require('../services/blikk-client');
    const client = new BlikkClient();
    const orderNum = req.query.order;
    let proj = null;
    if (orderNum) {
      // Search through pages to find by order number
      let page = 1;
      while (!proj) {
        const data = await client.get('/v1/Core/Projects', { page, pageSize: 100 });
        const items = data.items || data.data || data;
        if (!Array.isArray(items) || items.length === 0) break;
        proj = items.find(p => String(p.orderNumber) === String(orderNum));
        if (items.length < 100) break;
        page++;
      }
      if (!proj) return res.json({ error: `Project with order number ${orderNum} not found` });
    } else {
      const data = await client.get('/v1/Core/Projects', { page: 1, pageSize: 1 });
      const items = data.items || data.data || data;
      proj = Array.isArray(items) ? items[0] : null;
      if (!proj) return res.json({ error: 'No projects found' });
    }
    const detail = await client.get(`/v1/Core/Projects/${proj.id}`);
    res.json({ fields: Object.keys(detail), sample: detail });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug: show Visma data structures
router.get('/debug/visma-projects', async (req, res) => {
  try {
    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();
    const data = await client.get('/projects', { $pagesize: 5 });
    res.json({ fields: data.Data?.[0] ? Object.keys(data.Data[0]) : Object.keys((data[0] || {})), sample: data.Data || data });
  } catch (error) {
    res.json({ error: error.message });
  }
});

router.get('/debug/visma-draft', async (req, res) => {
  try {
    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();
    const data = await client.get('/customerinvoicedrafts', { $pagesize: 1 });
    const items = data.Data || data.data || data;
    const first = Array.isArray(items) ? items[0] : items;
    res.json({ fields: first ? Object.keys(first) : [], rowFields: first?.Rows?.[0] ? Object.keys(first.Rows[0]) : [], sample: first });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Reset invoiced status for all projects (dev tool)
router.post('/projects/reset-invoiced', async (req, res) => {
  const result = await prisma.project.updateMany({
    where: { lastInvoicedMonth: { not: null } },
    data: { lastInvoicedMonth: null },
  });
  res.json({ success: true, reset: result.count });
});

// Bulk send project invoices to Visma — supports billing splits
router.post('/projects/bulk-send-to-visma', async (req, res) => {
  try {
    const { projectIds } = req.body;
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return res.json({ success: false, error: 'Inga projekt valda' });
    }

    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds.map(Number) } },
      include: {
        customer: true, article: true, priceOverrides: true,
        invoiceRows: { include: { article: true }, orderBy: { sortOrder: 'asc' } },
        billingSplits: { include: { customer: true }, orderBy: { sortOrder: 'asc' } },
      },
    });

    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthNames = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];

    const results = [];
    for (const project of projects) {
      try {
        const hasSplits = project.billingSplits.length > 0;
        const hasInvoiceRows = project.invoiceRows.length > 0;

        if (!hasInvoiceRows && !project.article?.vismaArticleId) { results.push({ id: project.id, title: project.title, success: false, error: 'Ingen Visma-artikel kopplad' }); continue; }

        if (!hasSplits) {
          // --- Standard single-invoice path ---
          if (!hasInvoiceRows && !project.monthlyPrice) { results.push({ id: project.id, title: project.title, success: false, error: 'Inget pris satt' }); continue; }
          if (!project.customer) { results.push({ id: project.id, title: project.title, success: false, error: 'Ingen kund kopplad' }); continue; }
          if (!project.customer.vismaCustomerId) { results.push({ id: project.id, title: project.title, success: false, error: 'Kunden saknar Visma-ID' }); continue; }

          const override = project.priceOverrides.find(o =>
            new Date(o.month).getFullYear() === monthStart.getFullYear() &&
            new Date(o.month).getMonth() === monthStart.getMonth()
          );
          const price = override ? override.price : project.monthlyPrice;
          const periodText = `${project.title} — ${monthNames[now.getMonth()]} ${now.getFullYear()}`;

          let vismaProjectId = null;
          if (project.orderNumber) {
            const vismaProject = await client.findProjectByNumber(project.orderNumber);
            if (vismaProject) vismaProjectId = vismaProject.Id || vismaProject.id;
          }

          const rows = [];
          let totalAmount = 0;

          if (hasInvoiceRows) {
            for (let i = 0; i < project.invoiceRows.length; i++) {
              const ir = project.invoiceRows[i];
              const artId = ir.article?.vismaArticleId || project.article?.vismaArticleId;
              if (!artId) { results.push({ id: project.id, title: project.title, success: false, error: `Rad "${ir.text}" saknar Visma-artikel` }); continue; }
              rows.push({
                ArticleId: artId,
                Text: ir.text,
                UnitPrice: ir.unitPrice,
                Quantity: ir.quantity,
                LineNumber: i + 1,
                ...(vismaProjectId && { ProjectId: vismaProjectId }),
              });
              totalAmount += ir.unitPrice * ir.quantity;
            }
          } else {
            rows.push({
              ArticleId: project.article.vismaArticleId,
              Text: periodText,
              UnitPrice: price,
              Quantity: 1,
              LineNumber: 1,
              ...(vismaProjectId && { ProjectId: vismaProjectId }),
            });
            totalAmount = price;
          }

          const draftData = {
            CustomerId: project.customer.vismaCustomerId,
            YourReference: project.yourReference || project.customer.yourReference || null,
            BuyersOrderReference: project.buyersOrderRef || null,
            OurReference: project.ourReference || project.customer.ourReference || null,
            InvoiceDate: now.toISOString().slice(0, 10),
            ...(project.invoiceText && { InvoiceText: project.invoiceText }),
            Rows: rows,
          };

          const draft = await client.createInvoiceDraft(draftData);

          await prisma.project.update({
            where: { id: project.id },
            data: { lastInvoicedMonth: monthStart, nextInvoiceMonth: calcNextInvoiceMonth(monthStart, project.billingInterval) },
          });

          results.push({ id: project.id, title: project.title, success: true, price: totalAmount, draftId: draft.id || draft.Id });
        } else {
          // --- Split invoice path ---
          // Validate all splits
          const invalidSplit = project.billingSplits.find(s => !s.customer.vismaCustomerId);
          if (invalidSplit) {
            results.push({ id: project.id, title: project.title, success: false, error: `Kund "${invalidSplit.customer.name}" saknar Visma-ID` });
            continue;
          }

          let vismaProjectId = null;
          if (project.orderNumber) {
            const vismaProject = await client.findProjectByNumber(project.orderNumber);
            if (vismaProject) vismaProjectId = vismaProject.Id || vismaProject.id;
          }

          const splitResults = [];
          let allOk = true;

          for (let si = 0; si < project.billingSplits.length; si++) {
            const split = project.billingSplits[si];
            const periodText = split.label || `${project.title} — ${monthNames[now.getMonth()]} ${now.getFullYear()}`;

            const rows = [];
            rows.push({
              ArticleId: project.article.vismaArticleId,
              Text: periodText,
              UnitPrice: split.amount,
              Quantity: 1,
              LineNumber: 1,
              ...(vismaProjectId && { ProjectId: vismaProjectId }),
            });

            let totalExtra = 0;
            if (si === 0) {
              for (let i = 0; i < project.invoiceRows.length; i++) {
                const ir = project.invoiceRows[i];
                const artId = ir.article?.vismaArticleId || project.article.vismaArticleId;
                rows.push({
                  ArticleId: artId,
                  Text: ir.text,
                  UnitPrice: ir.unitPrice,
                  Quantity: ir.quantity,
                  LineNumber: i + 2,
                  ...(vismaProjectId && { ProjectId: vismaProjectId }),
                });
                totalExtra += ir.unitPrice * ir.quantity;
              }
            }

            const batchYourRef = split.yourReference || project.yourReference || split.customer.yourReference || null;
            const draftData = {
              CustomerId: split.customer.vismaCustomerId,
              YourReference: batchYourRef,
              BuyersOrderReference: project.buyersOrderRef || null,
              OurReference: project.ourReference || split.customer.ourReference || null,
              InvoiceDate: now.toISOString().slice(0, 10),
              ...(project.invoiceText && { InvoiceText: project.invoiceText }),
              Rows: rows,
            };

            try {
              const draft = await client.createInvoiceDraft(draftData);
              splitResults.push({ customer: split.customer.name, amount: split.amount + totalExtra, success: true, draftId: draft.id || draft.Id });
            } catch (err) {
              splitResults.push({ customer: split.customer.name, amount: split.amount, success: false, error: err.message });
              allOk = false;
            }
          }

          if (allOk) {
            await prisma.project.update({
              where: { id: project.id },
              data: { lastInvoicedMonth: monthStart, nextInvoiceMonth: calcNextInvoiceMonth(monthStart, project.billingInterval) },
            });
          }

          const totalAmount = splitResults.filter(r => r.success).reduce((s, r) => s + r.amount, 0);
          results.push({
            id: project.id,
            title: project.title,
            success: allOk,
            price: totalAmount,
            splitCount: project.billingSplits.length,
            splitResults,
            error: allOk ? undefined : 'Vissa splitar misslyckades',
          });
        }
      } catch (error) {
        results.push({ id: project.id, title: project.title, success: false, error: error.message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const totalAmount = results.filter(r => r.success).reduce((s, r) => s + (r.price || 0), 0);

    res.json({ success: true, sent: succeeded, failed, totalAmount, results });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Sync articles from Spiris (one page at a time)
router.post('/sync/spiris-articles', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const { syncSpirisArticlesPage } = require('../services/spiris-sync');
    const result = await syncSpirisArticlesPage(page);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync customers from Spiris (one page at a time)
router.post('/sync/spiris-customers', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const { syncSpirisCustomersPage } = require('../services/spiris-sync');
    const result = await syncSpirisCustomersPage(page);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync projects from Blikk — incremental (non-force, for cron/quick sync)
router.post('/sync/blikk-projects', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (force) {
      // Force mode: just list IDs (frontend should use batch endpoint)
      const { listBlikkProjectIds } = require('../services/blikk-sync');
      const projects = await listBlikkProjectIds();
      return res.json({ success: true, total: projects.length, ids: projects.map(p => p.id) });
    }
    const { syncBlikkProjects } = require('../services/blikk-sync');
    const result = await syncBlikkProjects();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync a batch of Blikk projects by IDs
router.post('/sync/blikk-projects/batch', async (req, res) => {
  try {
    const { ids, force } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.json({ success: false, error: 'Inga projekt-ID angivna' });
    }
    const { syncBlikkProjectsBatch } = require('../services/blikk-sync');
    const result = await syncBlikkProjectsBatch(ids, force !== false);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manually link a customer to Visma ID
router.patch('/customers/:id/visma', async (req, res) => {
  const { vismaCustomerId } = req.body;
  const customer = await prisma.customer.update({
    where: { id: Number(req.params.id) },
    data: { vismaCustomerId: vismaCustomerId || null },
  });
  res.json(customer);
});

// Search Visma customers (for manual linking)
router.get('/spiris/customers/search', async (req, res) => {
  try {
    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();
    const q = req.query.q || '';
    const data = await client.get('/customers', {
      $filter: `contains(Name,'${q}')`,
      $pagesize: 20,
    });
    const items = data.Data || data.data || data;
    res.json(Array.isArray(items) ? items : []);
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Create manual project (e.g. hosting)
router.post('/projects/create', async (req, res) => {
  try {
    const { title, customerId, articleId, monthlyPrice, billingInterval, category } = req.body;
    if (!title) return res.json({ success: false, error: 'Titel krävs' });

    const project = await prisma.project.create({
      data: {
        title,
        category: category || 'Webbhotell & domän',
        customerId: customerId ? Number(customerId) : null,
        articleId: articleId ? Number(articleId) : null,
        monthlyPrice: monthlyPrice ? parseFloat(monthlyPrice) : null,
        billingInterval: billingInterval || 'monthly',
        status: 'Pågående',
      },
    });

    res.json({ success: true, project });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Blikk status IDs
const BLIKK_STATUS = { 'Att göra': 2301, 'Pågående': 2299, 'Avslutad': 2300 };

// Update project status (local + Blikk)
router.patch('/projects/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const blikkStatusId = BLIKK_STATUS[status];
    if (!blikkStatusId) return res.json({ success: false, error: 'Ogiltig status' });

    const project = await prisma.project.findUnique({ where: { id: Number(req.params.id) } });
    if (!project) return res.status(404).json({ success: false, error: 'Projekt hittades inte' });

    // Update in Blikk only if the project has a blikkProjectId
    if (project.blikkProjectId) {
      const { BlikkClient } = require('../services/blikk-client');
      const client = new BlikkClient();
      await client.put(`/v1/Core/Projects/${project.blikkProjectId}`, {
        status: { id: blikkStatusId },
      });
    }

    // Update locally
    await prisma.project.update({
      where: { id: project.id },
      data: {
        status,
        isCompleted: status === 'Avslutad',
      },
    });

    res.json({ success: true, status });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Pause/unpause project invoicing
router.patch('/projects/:id/pause', async (req, res) => {
  const { pauseFrom, pauseUntil } = req.body;
  const project = await prisma.project.update({
    where: { id: Number(req.params.id) },
    data: {
      pauseFrom: pauseFrom ? new Date(pauseFrom) : null,
      pauseUntil: pauseUntil ? new Date(pauseUntil) : null,
    },
  });
  res.json(project);
});

// Global price adjustment (percentage increase/decrease)
router.post('/projects/price-adjustment', async (req, res) => {
  try {
    const { percentage, category } = req.body;
    const pct = parseFloat(percentage);
    if (isNaN(pct)) return res.json({ success: false, error: 'Ange en giltig procentsats' });

    const where = { monthlyPrice: { not: null } };
    if (category) where.category = category;

    const projects = await prisma.project.findMany({ where });

    let updated = 0;
    for (const p of projects) {
      const newPrice = Math.round(p.monthlyPrice * (1 + pct / 100));
      await prisma.project.update({
        where: { id: p.id },
        data: { monthlyPrice: newPrice },
      });
      updated++;
    }

    res.json({ success: true, updated, percentage: pct });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// CRUD for project invoice rows
router.get('/projects/:id/rows', async (req, res) => {
  const rows = await prisma.projectInvoiceRow.findMany({
    where: { projectId: Number(req.params.id) },
    include: { article: true },
    orderBy: { sortOrder: 'asc' },
  });
  res.json(rows);
});

router.post('/projects/:id/rows', async (req, res) => {
  const { articleId, text, unitPrice, quantity } = req.body;
  const count = await prisma.projectInvoiceRow.count({ where: { projectId: Number(req.params.id) } });
  const row = await prisma.projectInvoiceRow.create({
    data: {
      projectId: Number(req.params.id),
      articleId: articleId ? parseInt(articleId) : null,
      text: text || '',
      unitPrice: parseFloat(unitPrice) || 0,
      quantity: parseFloat(quantity) || 1,
      sortOrder: count,
    },
    include: { article: true },
  });
  res.json(row);
});

router.patch('/projects/:id/rows/:rowId', async (req, res) => {
  const data = {};
  if (req.body.articleId !== undefined) data.articleId = req.body.articleId ? parseInt(req.body.articleId) : null;
  if (req.body.text !== undefined) data.text = req.body.text;
  if (req.body.unitPrice !== undefined) data.unitPrice = parseFloat(req.body.unitPrice);
  if (req.body.quantity !== undefined) data.quantity = parseFloat(req.body.quantity);
  const row = await prisma.projectInvoiceRow.update({
    where: { id: Number(req.params.rowId) },
    data,
    include: { article: true },
  });
  res.json(row);
});

router.delete('/projects/:id/rows/:rowId', async (req, res) => {
  await prisma.projectInvoiceRow.delete({ where: { id: Number(req.params.rowId) } });
  res.json({ success: true });
});

// CRUD for project billing splits
router.get('/projects/:id/splits', async (req, res) => {
  const splits = await prisma.projectBillingSplit.findMany({
    where: { projectId: Number(req.params.id) },
    include: { customer: true },
    orderBy: { sortOrder: 'asc' },
  });
  res.json(splits);
});

router.post('/projects/:id/splits', async (req, res) => {
  const { customerId, amount, label, yourReference } = req.body;
  const count = await prisma.projectBillingSplit.count({ where: { projectId: Number(req.params.id) } });
  const split = await prisma.projectBillingSplit.create({
    data: {
      projectId: Number(req.params.id),
      customerId: Number(customerId),
      amount: parseFloat(amount) || 0,
      label: label || null,
      yourReference: yourReference || null,
      sortOrder: count,
    },
    include: { customer: true },
  });
  res.json(split);
});

router.patch('/projects/:id/splits/:splitId', async (req, res) => {
  const data = {};
  if (req.body.customerId !== undefined) data.customerId = Number(req.body.customerId);
  if (req.body.amount !== undefined) data.amount = parseFloat(req.body.amount);
  if (req.body.label !== undefined) data.label = req.body.label || null;
  if (req.body.yourReference !== undefined) data.yourReference = req.body.yourReference || null;
  const split = await prisma.projectBillingSplit.update({
    where: { id: Number(req.params.splitId) },
    data,
    include: { customer: true },
  });
  res.json(split);
});

router.delete('/projects/:id/splits/:splitId', async (req, res) => {
  await prisma.projectBillingSplit.delete({ where: { id: Number(req.params.splitId) } });
  res.json({ success: true });
});

// Update project monthly price and/or invoice week (from list view)
router.patch('/projects/:id/price', async (req, res) => {
  const data = {};
  if (req.body.monthlyPrice !== undefined) data.monthlyPrice = parseFloat(req.body.monthlyPrice);
  if (req.body.invoiceWeek !== undefined) data.invoiceWeek = parseInt(req.body.invoiceWeek) || null;

  const project = await prisma.project.update({
    where: { id: Number(req.params.id) },
    data,
    include: { customer: true },
  });
  res.json(project);
});

// Update project settings (from detail view)
router.patch('/projects/:id/settings', async (req, res) => {
  const data = {};
  if (req.body.monthlyPrice !== undefined) data.monthlyPrice = parseFloat(req.body.monthlyPrice) || null;
  if (req.body.billingInterval !== undefined) data.billingInterval = req.body.billingInterval;
  if (req.body.invoiceWeek !== undefined) data.invoiceWeek = parseInt(req.body.invoiceWeek) || null;
  if (req.body.articleId !== undefined) data.articleId = parseInt(req.body.articleId) || null;
  if (req.body.endDate !== undefined) data.endDate = req.body.endDate ? new Date(req.body.endDate) : null;
  if (req.body.nextInvoiceMonth !== undefined) data.nextInvoiceMonth = req.body.nextInvoiceMonth ? new Date(req.body.nextInvoiceMonth + '-01') : null;

  const project = await prisma.project.update({
    where: { id: Number(req.params.id) },
    data,
    include: { customer: true, article: true },
  });
  res.json(project);
});

// Set price override for a specific month
router.post('/projects/:id/price-override', async (req, res) => {
  const { month, price, note } = req.body;
  const projectId = Number(req.params.id);
  const monthDate = new Date(month);

  const override = await prisma.projectPriceOverride.upsert({
    where: { projectId_month: { projectId, month: monthDate } },
    update: { price: parseFloat(price), note: note || null },
    create: { projectId, month: monthDate, price: parseFloat(price), note: note || null },
  });

  res.json(override);
});

// Delete price override
router.delete('/projects/:id/price-override/:overrideId', async (req, res) => {
  await prisma.projectPriceOverride.delete({
    where: { id: Number(req.params.overrideId) },
  });
  res.json({ success: true });
});

// Send project invoice to Visma (create draft) — supports billing splits
router.post('/projects/:id/send-to-visma', async (req, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        customer: true, article: true, priceOverrides: true,
        invoiceRows: { include: { article: true }, orderBy: { sortOrder: 'asc' } },
        billingSplits: { include: { customer: true }, orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!project) return res.status(404).json({ success: false, error: 'Projekt hittades inte' });

    const hasSplits = project.billingSplits.length > 0;
    const hasInvoiceRows = project.invoiceRows.length > 0;

    // Require article only if no invoice rows (main row needs it)
    if (!hasInvoiceRows && !project.article?.vismaArticleId) {
      return res.json({ success: false, error: 'Ingen Visma-artikel kopplad' });
    }

    if (!hasSplits) {
      // Original logic: single invoice to project customer
      if (!hasInvoiceRows && !project.monthlyPrice) return res.json({ success: false, error: 'Inget pris satt' });
      if (!project.customer) return res.json({ success: false, error: 'Ingen kund kopplad' });
      if (!project.customer.vismaCustomerId) return res.json({ success: false, error: 'Kunden saknar Visma-ID' });
    } else {
      // Validate all splits have Visma customer IDs
      for (const split of project.billingSplits) {
        if (!split.customer.vismaCustomerId) {
          return res.json({ success: false, error: `Kund "${split.customer.name}" saknar Visma-ID` });
        }
      }
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthNames = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];

    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();

    // Look up Visma project by order number
    let vismaProjectId = null;
    if (project.orderNumber) {
      const vismaProject = await client.findProjectByNumber(project.orderNumber);
      if (vismaProject) vismaProjectId = vismaProject.Id || vismaProject.id;
    }

    if (!hasSplits) {
      // --- Original single-invoice path ---
      const override = project.priceOverrides.find(o =>
        new Date(o.month).getFullYear() === monthStart.getFullYear() &&
        new Date(o.month).getMonth() === monthStart.getMonth()
      );
      const price = override ? override.price : project.monthlyPrice;
      const periodText = `${project.title} — ${monthNames[now.getMonth()]} ${now.getFullYear()}`;

      const rows = [];
      let totalAmount = 0;

      if (project.invoiceRows.length > 0) {
        // Use invoice rows as the full invoice (no separate main row)
        for (let i = 0; i < project.invoiceRows.length; i++) {
          const ir = project.invoiceRows[i];
          const artId = ir.article?.vismaArticleId || project.article?.vismaArticleId;
          if (!artId) return res.json({ success: false, error: `Fakturarad "${ir.text}" saknar Visma-artikel` });
          rows.push({
            ArticleId: artId,
            Text: ir.text,
            UnitPrice: ir.unitPrice,
            Quantity: ir.quantity,
            LineNumber: i + 1,
            ...(vismaProjectId && { ProjectId: vismaProjectId }),
          });
          totalAmount += ir.unitPrice * ir.quantity;
        }
      } else {
        // No invoice rows — use main article + price as single row
        if (!project.article?.vismaArticleId) return res.json({ success: false, error: 'Ingen Visma-artikel kopplad' });
        rows.push({
          ArticleId: project.article.vismaArticleId,
          Text: periodText,
          UnitPrice: price,
          Quantity: 1,
          LineNumber: 1,
          ...(vismaProjectId && { ProjectId: vismaProjectId }),
        });
        totalAmount = price;
      }

      const draftData = {
        CustomerId: project.customer.vismaCustomerId,
        YourReference: project.yourReference || project.customer.yourReference || null,
        BuyersOrderReference: project.buyersOrderRef || null,
        OurReference: project.ourReference || project.customer.ourReference || null,
        InvoiceDate: now.toISOString().slice(0, 10),
        ...(project.invoiceText && { InvoiceText: project.invoiceText }),
        Rows: rows,
      };

      const draft = await client.createInvoiceDraft(draftData);

      await prisma.project.update({
        where: { id: project.id },
        data: { lastInvoicedMonth: monthStart, nextInvoiceMonth: calcNextInvoiceMonth(monthStart, project.billingInterval) },
      });

      res.json({
        success: true,
        info: `Fakturautkast skapat i Visma (${formatSEK(totalAmount)}, ${rows.length} rader)`,
        draftId: draft.id || draft.Id,
      });
    } else {
      // --- Split invoice path: one draft per split ---
      const splitResults = [];
      let allOk = true;

      for (let si = 0; si < project.billingSplits.length; si++) {
        const split = project.billingSplits[si];
        const periodText = split.label || `${project.title} — ${monthNames[now.getMonth()]} ${now.getFullYear()}`;

        const rows = [];
        rows.push({
          ArticleId: project.article.vismaArticleId,
          Text: periodText,
          UnitPrice: split.amount,
          Quantity: 1,
          LineNumber: 1,
          ...(vismaProjectId && { ProjectId: vismaProjectId }),
        });

        // Extra invoice rows only on the first split
        let totalExtra = 0;
        if (si === 0) {
          for (let i = 0; i < project.invoiceRows.length; i++) {
            const ir = project.invoiceRows[i];
            const artId = ir.article?.vismaArticleId || project.article.vismaArticleId;
            rows.push({
              ArticleId: artId,
              Text: ir.text,
              UnitPrice: ir.unitPrice,
              Quantity: ir.quantity,
              LineNumber: i + 2,
              ...(vismaProjectId && { ProjectId: vismaProjectId }),
            });
            totalExtra += ir.unitPrice * ir.quantity;
          }
        }

        const yourRef = split.yourReference || project.yourReference || split.customer.yourReference || null;
        const draftData = {
          CustomerId: split.customer.vismaCustomerId,
          YourReference: yourRef,
          BuyersOrderReference: project.buyersOrderRef || null,
          OurReference: project.ourReference || split.customer.ourReference || null,
          InvoiceDate: now.toISOString().slice(0, 10),
          ...(project.invoiceText && { InvoiceText: project.invoiceText }),
          Rows: rows,
        };

        try {
          const draft = await client.createInvoiceDraft(draftData);
          splitResults.push({ customer: split.customer.name, amount: split.amount + totalExtra, success: true, draftId: draft.id || draft.Id });
        } catch (err) {
          splitResults.push({ customer: split.customer.name, amount: split.amount, success: false, error: err.message });
          allOk = false;
        }
      }

      // Only mark as invoiced if ALL splits succeeded
      if (allOk) {
        await prisma.project.update({
          where: { id: project.id },
          data: { lastInvoicedMonth: monthStart, nextInvoiceMonth: calcNextInvoiceMonth(monthStart, project.billingInterval) },
        });
      }

      const totalAmount = splitResults.filter(r => r.success).reduce((s, r) => s + r.amount, 0);
      const succeeded = splitResults.filter(r => r.success).length;

      res.json({
        success: allOk,
        info: allOk
          ? `${succeeded} fakturautkast skapade i Visma (${formatSEK(totalAmount)})`
          : `${succeeded}/${project.billingSplits.length} utkast skapade, vissa misslyckades`,
        splitResults,
      });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

function formatSEK(n) { return Math.round(n).toLocaleString('sv-SE') + ' kr'; }

const INTERVAL_MONTHS = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };
function calcNextInvoiceMonth(currentMonth, billingInterval) {
  const months = INTERVAL_MONTHS[billingInterval] || 1;
  const next = new Date(currentMonth);
  next.setMonth(next.getMonth() + months);
  return new Date(next.getFullYear(), next.getMonth(), 1);
}

// Trigger Blikk contact sync
router.post('/sync/contacts', async (req, res) => {
  try {
    const { syncBlikkContacts } = require('../services/blikk-sync');
    const result = await syncBlikkContacts();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Show unsent invoices grouped by month
router.get('/preview/unsent', async (req, res) => {
  try {
    const { BlikkClient } = require('../services/blikk-client');
    const client = new BlikkClient();
    const allInvoices = await client.getAllInvoices();

    const unsent = allInvoices.filter(inv => !inv.sentToEconomySystem);

    // Group by month
    const byMonth = {};
    for (const inv of unsent) {
      const d = new Date(inv.fromDate || inv.invoiceDate);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth[key]) byMonth[key] = { count: 0, totalSum: 0, invoices: [] };
      byMonth[key].count++;
      byMonth[key].totalSum += inv.sum || 0;
      if (byMonth[key].invoices.length < 3) {
        byMonth[key].invoices.push({
          id: inv.id,
          customer: inv.customer?.name,
          sum: inv.sum,
          fromDate: inv.fromDate,
          toDate: inv.toDate,
        });
      }
    }

    res.json({
      totalInBlikk: allInvoices.length,
      totalUnsent: unsent.length,
      byMonth,
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Preview raw Blikk data (for debugging field names)
router.get('/preview/blikk', async (req, res) => {
  try {
    const { BlikkClient } = require('../services/blikk-client');
    const client = new BlikkClient();

    const result = {};

    // Test each endpoint individually
    const endpoints = [
      { key: 'contacts', path: '/v1/Core/Contacts', label: 'Kontakter' },
      { key: 'invoices', path: '/v1/core/invoices', label: 'Fakturor' },
      { key: 'projects', path: '/v1/Core/Projects', label: 'Projekt' },
      { key: 'articles', path: '/v1/Core/Articles', label: 'Artiklar' },
    ];

    for (const ep of endpoints) {
      try {
        const data = await client.get(ep.path, { page: 1, pageSize: 2 });
        result[ep.key] = {
          status: 'OK',
          totalItemCount: data.totalItemCount,
          data: data.items || data,
        };
      } catch (err) {
        result[ep.key] = { status: 'FEL', error: err.message };
      }
    }

    // Also fetch one invoice detail (with rows) to see the full structure
    try {
      const listData = await client.get('/v1/core/invoices', { page: 1, pageSize: 1 });
      const firstInvoice = listData.items?.[0];
      if (firstInvoice) {
        const detail = await client.get(`/v1/core/invoices/${firstInvoice.id}`);
        result.invoiceDetail = {
          _note: `Detail for invoice ${firstInvoice.id}`,
          topLevelKeys: Object.keys(detail),
          data: detail,
        };
      }
    } catch (err) {
      result.invoiceDetail = { status: 'FEL', error: err.message };
    }

    res.json(result);
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Faktueringstillfällen för innevarande månad (eller ?month=2026-02)
router.get('/preview/payment-plans', async (req, res) => {
  try {
    const { BlikkClient } = require('../services/blikk-client');
    const client = new BlikkClient();
    const all = await client.getAllPaymentPlans();

    // Bestäm målmånad
    const now = new Date();
    const monthParam = req.query.month; // t.ex. "2026-02"
    const targetYear = monthParam ? parseInt(monthParam.split('-')[0]) : now.getFullYear();
    const targetMonth = monthParam ? parseInt(monthParam.split('-')[1]) - 1 : now.getMonth();

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

    // Filtrera på date-fältet (planerat faktureringsdatum)
    const filtered = all.filter(pp => {
      if (!pp.date) return false;
      const d = new Date(pp.date);
      return d >= monthStart && d <= monthEnd;
    });

    // Sortera efter datum (nyast först)
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    const monthLabel = monthStart.toLocaleDateString('sv-SE', { year: 'numeric', month: 'long' });

    res.json({
      month: monthLabel,
      total: all.length,
      filtered: filtered.length,
      totalAmount: filtered.reduce((s, pp) => s + (pp.price || 0) * (pp.units || 1), 0),
      items: filtered,
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ── Visma recurring invoices probe ───────────────────────────

// Debug: try multiple potential endpoints for recurring invoices
router.get('/debug/visma-recurring', async (req, res) => {
  try {
    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();
    const results = {};

    // Try potential endpoints
    const paths = [
      '/customerinvoicedrafts/recurring',
      '/recurringinvoicedrafts',
      '/recurringinvoices',
      '/customerinvoicedrafts?$filter=IsRecurring eq true',
      '/customerinvoicetemplates',
      '/invoicetemplates',
      '/subscriptions',
    ];

    for (const path of paths) {
      try {
        const data = await client.get(path, { $pagesize: 3 });
        const items = data.Data || data.data || data;
        results[path] = {
          status: 'OK',
          count: Array.isArray(items) ? items.length : (data.TotalCount || data.Meta?.TotalCount || '?'),
          fields: Array.isArray(items) && items[0] ? Object.keys(items[0]) : [],
          sample: Array.isArray(items) ? items.slice(0, 2) : items,
        };
      } catch (e) {
        results[path] = { status: e.message.includes('404') ? '404' : 'ERROR', error: e.message.slice(0, 200) };
      }
    }

    // Also try fetching regular invoices to see if there's a recurring flag
    try {
      const invoices = await client.get('/customerinvoices', { $pagesize: 3 });
      const items = invoices.Data || invoices.data || invoices;
      const first = Array.isArray(items) ? items[0] : null;
      results['/customerinvoices (fields)'] = {
        fields: first ? Object.keys(first) : [],
        sample: first,
      };
    } catch (e) {
      results['/customerinvoices'] = { status: 'ERROR', error: e.message.slice(0, 200) };
    }

    // Try drafts too
    try {
      const drafts = await client.get('/customerinvoicedrafts', { $pagesize: 3 });
      const items = drafts.Data || drafts.data || drafts;
      const first = Array.isArray(items) ? items[0] : null;
      results['/customerinvoicedrafts (fields)'] = {
        fields: first ? Object.keys(first) : [],
        sample: first,
      };
    } catch (e) {
      results['/customerinvoicedrafts'] = { status: 'ERROR', error: e.message.slice(0, 200) };
    }

    res.json(results);
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ── Ekonomi sync & debug ─────────────────────────────────────

// Trigger ekonomi sync — supports step-by-step: ?type=pl|kpi|service_revenue or all
router.post('/sync/ekonomi', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const type = req.query.type || 'all';
    const { syncVismaFinancials, syncBlikkKpis, syncServiceRevenue, syncAll } = require('../services/ekonomi-sync');

    let result;
    if (type === 'pl') result = await syncVismaFinancials(year);
    else if (type === 'kpi') result = await syncBlikkKpis(year);
    else if (type === 'service_revenue') result = await syncServiceRevenue(year);
    else result = await syncAll(year);

    res.json({ success: true, year, type, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debug: inspect Blikk time report structure
router.get('/debug/blikk-timereports', async (req, res) => {
  try {
    const { BlikkClient } = require('../services/blikk-client');
    const client = new BlikkClient();
    const data = await client.get('/v1/Core/TimeReports', { page: 1, pageSize: 5 });
    const items = data.items || data.data || data;
    const first = Array.isArray(items) ? items[0] : items;
    res.json({
      totalItemCount: data.totalItemCount,
      fields: first ? Object.keys(first) : [],
      sample: Array.isArray(items) ? items.slice(0, 3) : items,
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug: inspect Visma account balances with pagination test
router.get('/debug/visma-accountbalances', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { SpirisClient } = require('../services/spiris-client');
    const client = new SpirisClient();

    const results = {};

    // Test 1: no pagination
    try {
      const data = await client.get(`/accountbalances/${date}`);
      const items = data.Data || data.data || data;
      const arr = Array.isArray(items) ? items : [];
      const last = arr[arr.length - 1];
      results['no_params'] = { count: arr.length, firstAcct: arr[0]?.AccountNumber, lastAcct: last?.AccountNumber };
    } catch (e) { results['no_params'] = { error: e.message.slice(0, 150) }; }

    // Test 2: $pagesize=200
    try {
      const data = await client.get(`/accountbalances/${date}`, { $pagesize: 200 });
      const items = data.Data || data.data || data;
      const arr = Array.isArray(items) ? items : [];
      const last = arr[arr.length - 1];
      results['pagesize_200'] = { count: arr.length, firstAcct: arr[0]?.AccountNumber, lastAcct: last?.AccountNumber };
    } catch (e) { results['pagesize_200'] = { error: e.message.slice(0, 150) }; }

    // Test 3: $page=2
    try {
      const data = await client.get(`/accountbalances/${date}`, { $page: 2, $pagesize: 50 });
      const items = data.Data || data.data || data;
      const arr = Array.isArray(items) ? items : [];
      const last = arr[arr.length - 1];
      results['page2_size50'] = { count: arr.length, firstAcct: arr[0]?.AccountNumber, lastAcct: last?.AccountNumber };
    } catch (e) { results['page2_size50'] = { error: e.message.slice(0, 150) }; }

    // Test 4: $page=3
    try {
      const data = await client.get(`/accountbalances/${date}`, { $page: 3, $pagesize: 50 });
      const items = data.Data || data.data || data;
      const arr = Array.isArray(items) ? items : [];
      const last = arr[arr.length - 1];
      results['page3_size50'] = { count: arr.length, firstAcct: arr[0]?.AccountNumber, lastAcct: last?.AccountNumber };
    } catch (e) { results['page3_size50'] = { error: e.message.slice(0, 150) }; }

    // Test 5: raw response keys
    try {
      const data = await client.get(`/accountbalances/${date}`);
      results['response_keys'] = Object.keys(data);
      if (data.Meta) results['meta'] = data.Meta;
      if (data.TotalCount !== undefined) results['totalCount'] = data.TotalCount;
    } catch (e) { results['response_keys'] = { error: e.message.slice(0, 100) }; }

    res.json(results);
  } catch (error) {
    res.json({ error: error.message });
  }
});

module.exports = router;
