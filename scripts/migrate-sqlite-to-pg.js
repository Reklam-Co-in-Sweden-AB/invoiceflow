/**
 * One-time migration script: SQLite → PostgreSQL (Supabase)
 *
 * Prerequisites:
 *   1. Set DATABASE_URL and DIRECT_URL in .env to your Supabase connection strings
 *   2. Run `npx prisma db push` to create tables in PostgreSQL
 *   3. Run this script: node scripts/migrate-sqlite-to-pg.js
 *
 * The script reads from the local SQLite file and inserts into PostgreSQL via Prisma.
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const SQLITE_PATH = path.join(__dirname, '..', 'prisma', 'dev.db');

const prisma = new PrismaClient();
const sqlite = new Database(SQLITE_PATH, { readonly: true });

// Helper: read all rows from a SQLite table
function readTable(name) {
  return sqlite.prepare(`SELECT * FROM "${name}"`).all();
}

// Helper: convert SQLite boolean (0/1) to JS boolean
function toBool(val) {
  return val === 1 || val === true;
}

// Helper: convert SQLite date string to JS Date or null
function toDate(val) {
  return val ? new Date(val) : null;
}

async function migrate() {
  console.log('Starting SQLite → PostgreSQL migration...\n');

  // --- Users ---
  const users = readTable('users');
  console.log(`Users: ${users.length}`);
  for (const r of users) {
    await prisma.user.create({
      data: {
        id: r.id,
        email: r.email,
        passwordHash: r.password_hash,
        name: r.name,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Customers ---
  const customers = readTable('customers');
  console.log(`Customers: ${customers.length}`);
  for (const r of customers) {
    await prisma.customer.create({
      data: {
        id: r.id,
        blikkContactId: r.blikk_contact_id,
        vismaCustomerId: r.visma_customer_id,
        customerNumber: r.customer_number,
        name: r.name,
        orgNumber: r.org_number,
        email: r.email,
        yourReference: r.your_reference,
        ourReference: r.our_reference,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Articles ---
  const articles = readTable('articles');
  console.log(`Articles: ${articles.length}`);
  for (const r of articles) {
    await prisma.article.create({
      data: {
        id: r.id,
        articleNumber: r.article_number,
        name: r.name,
        vismaArticleId: r.visma_article_id,
        serviceType: r.service_type,
        defaultPrice: r.default_price,
        vatRate: r.vat_rate,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Batches ---
  const batches = readTable('batches');
  console.log(`Batches: ${batches.length}`);
  for (const r of batches) {
    await prisma.batch.create({
      data: {
        id: r.id,
        invoiceMonth: toDate(r.invoice_month),
        weekNumber: r.week_number,
        scheduledDate: toDate(r.scheduled_date),
        invoiceCount: r.invoice_count,
        totalAmount: r.total_amount,
        status: r.status,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Invoices ---
  const invoices = readTable('invoices');
  console.log(`Invoices: ${invoices.length}`);
  for (const r of invoices) {
    await prisma.invoice.create({
      data: {
        id: r.id,
        customerId: r.customer_id,
        blikkInvoiceId: r.blikk_invoice_id,
        vismaDraftId: r.visma_draft_id,
        vismaInvoiceNumber: r.visma_invoice_number,
        serviceType: r.service_type,
        invoiceMonth: toDate(r.invoice_month),
        monthLabel: r.month_label,
        fromDate: toDate(r.from_date),
        toDate: toDate(r.to_date),
        scheduledDate: toDate(r.scheduled_date),
        scheduledWeek: r.scheduled_week,
        totalAmount: r.total_amount,
        status: r.status,
        batchId: r.batch_id,
        blikkSyncedAt: toDate(r.blikk_synced_at),
        blikkWritebackAt: toDate(r.blikk_writeback_at),
        vismaExportedAt: toDate(r.visma_exported_at),
        errorMessage: r.error_message,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Invoice Lines ---
  const invoiceLines = readTable('invoice_lines');
  console.log(`Invoice Lines: ${invoiceLines.length}`);
  for (const r of invoiceLines) {
    await prisma.invoiceLine.create({
      data: {
        id: r.id,
        invoiceId: r.invoice_id,
        articleId: r.article_id,
        blikkRowId: r.blikk_row_id,
        text: r.text,
        quantity: r.quantity,
        unitPrice: r.unit_price,
        discount: r.discount,
        lineTotal: r.line_total,
        sortOrder: r.sort_order,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Hosting Subscriptions ---
  const hostingSubs = readTable('hosting_subscriptions');
  console.log(`Hosting Subscriptions: ${hostingSubs.length}`);
  for (const r of hostingSubs) {
    await prisma.hostingSubscription.create({
      data: {
        id: r.id,
        customerId: r.customer_id,
        domain: r.domain,
        billingInterval: r.billing_interval,
        nextBillingDate: toDate(r.next_billing_date),
        isActive: toBool(r.is_active),
        notes: r.notes,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Hosting Subscription Lines ---
  const hostingLines = readTable('hosting_subscription_lines');
  console.log(`Hosting Subscription Lines: ${hostingLines.length}`);
  for (const r of hostingLines) {
    await prisma.hostingSubscriptionLine.create({
      data: {
        id: r.id,
        subscriptionId: r.subscription_id,
        articleId: r.article_id,
        description: r.description,
        quantity: r.quantity,
        unitPrice: r.unit_price,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Projects ---
  const projects = readTable('projects');
  console.log(`Projects: ${projects.length}`);
  for (const r of projects) {
    await prisma.project.create({
      data: {
        id: r.id,
        blikkProjectId: r.blikk_project_id,
        orderNumber: r.order_number,
        title: r.title,
        category: r.category,
        categoryColor: r.category_color,
        invoiceType: r.invoice_type,
        customerId: r.customer_id,
        status: r.status,
        isCompleted: toBool(r.is_completed),
        monthlyPrice: r.monthly_price,
        billingInterval: r.billing_interval,
        invoiceWeek: r.invoice_week,
        articleId: r.article_id,
        startDate: toDate(r.start_date),
        endDate: toDate(r.end_date),
        lastInvoicedMonth: toDate(r.last_invoiced_month),
        pauseFrom: toDate(r.pause_from),
        pauseUntil: toDate(r.pause_until),
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Project Invoice Rows ---
  const projectRows = readTable('project_invoice_rows');
  console.log(`Project Invoice Rows: ${projectRows.length}`);
  for (const r of projectRows) {
    await prisma.projectInvoiceRow.create({
      data: {
        id: r.id,
        projectId: r.project_id,
        articleId: r.article_id,
        text: r.text,
        unitPrice: r.unit_price,
        quantity: r.quantity,
        sortOrder: r.sort_order,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Project Price Overrides ---
  const priceOverrides = readTable('project_price_overrides');
  console.log(`Project Price Overrides: ${priceOverrides.length}`);
  for (const r of priceOverrides) {
    await prisma.projectPriceOverride.create({
      data: {
        id: r.id,
        projectId: r.project_id,
        month: toDate(r.month),
        price: r.price,
        note: r.note,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Project Billing Splits ---
  const billingSplits = readTable('project_billing_splits');
  console.log(`Project Billing Splits: ${billingSplits.length}`);
  for (const r of billingSplits) {
    await prisma.projectBillingSplit.create({
      data: {
        id: r.id,
        projectId: r.project_id,
        customerId: r.customer_id,
        amount: r.amount,
        label: r.label,
        yourReference: r.your_reference,
        sortOrder: r.sort_order,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- API Tokens ---
  const apiTokens = readTable('api_tokens');
  console.log(`API Tokens: ${apiTokens.length}`);
  for (const r of apiTokens) {
    await prisma.apiToken.create({
      data: {
        id: r.id,
        provider: r.provider,
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        expiresAt: toDate(r.expires_at),
        tokenData: r.token_data,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // --- Sync Logs ---
  const syncLogs = readTable('sync_logs');
  console.log(`Sync Logs: ${syncLogs.length}`);
  for (const r of syncLogs) {
    await prisma.syncLog.create({
      data: {
        id: r.id,
        type: r.type,
        status: r.status,
        invoiceId: r.invoice_id,
        batchId: r.batch_id,
        details: r.details,
        error: r.error,
        createdAt: toDate(r.created_at),
      },
    });
  }

  // --- Settings ---
  const settings = readTable('settings');
  console.log(`Settings: ${settings.length}`);
  for (const r of settings) {
    await prisma.setting.create({
      data: {
        id: r.id,
        key: r.key,
        value: r.value,
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      },
    });
  }

  // Reset PostgreSQL sequences to max(id) + 1 for each table
  console.log('\nResetting sequences...');
  const tables = [
    'users', 'customers', 'articles', 'batches', 'invoices', 'invoice_lines',
    'hosting_subscriptions', 'hosting_subscription_lines', 'projects',
    'project_invoice_rows', 'project_price_overrides', 'project_billing_splits',
    'api_tokens', 'sync_logs', 'settings',
  ];
  for (const table of tables) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
    );
  }

  console.log('\nMigration complete!');
}

migrate()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    sqlite.close();
  });
