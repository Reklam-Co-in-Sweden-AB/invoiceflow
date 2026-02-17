const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'prisma', 'dev.db'), { readonly: true });

function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  const s = String(val).replace(/'/g, "''");
  return "'" + s + "'";
}

function toTs(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + new Date(val).toISOString() + "'";
}

function toBool(val) {
  if (val === null || val === undefined) return 'NULL';
  return (val === 1 || val === true) ? 'true' : 'false';
}

const tables = [
  { name: 'users', cols: ['id','email','password_hash','name','created_at','updated_at'], dates: ['created_at','updated_at'] },
  { name: 'customers', cols: ['id','blikk_contact_id','visma_customer_id','customer_number','name','org_number','email','your_reference','our_reference','created_at','updated_at'], dates: ['created_at','updated_at'] },
  { name: 'articles', cols: ['id','article_number','name','visma_article_id','service_type','default_price','vat_rate','created_at','updated_at'], dates: ['created_at','updated_at'] },
  { name: 'batches', cols: ['id','invoice_month','week_number','scheduled_date','invoice_count','total_amount','status','created_at','updated_at'], dates: ['invoice_month','scheduled_date','created_at','updated_at'] },
  { name: 'invoices', cols: ['id','customer_id','blikk_invoice_id','visma_draft_id','visma_invoice_number','service_type','invoice_month','month_label','from_date','to_date','scheduled_date','scheduled_week','total_amount','status','batch_id','blikk_synced_at','blikk_writeback_at','visma_exported_at','error_message','created_at','updated_at'], dates: ['invoice_month','from_date','to_date','scheduled_date','blikk_synced_at','blikk_writeback_at','visma_exported_at','created_at','updated_at'] },
  { name: 'invoice_lines', cols: ['id','invoice_id','article_id','blikk_row_id','text','quantity','unit_price','discount','line_total','sort_order','created_at','updated_at'], dates: ['created_at','updated_at'] },
  { name: 'hosting_subscriptions', cols: ['id','customer_id','domain','billing_interval','next_billing_date','is_active','notes','created_at','updated_at'], dates: ['next_billing_date','created_at','updated_at'], bools: ['is_active'] },
  { name: 'hosting_subscription_lines', cols: ['id','subscription_id','article_id','description','quantity','unit_price','created_at','updated_at'], dates: ['created_at','updated_at'] },
  { name: 'projects', cols: ['id','blikk_project_id','order_number','title','category','category_color','invoice_type','customer_id','status','is_completed','monthly_price','billing_interval','invoice_week','article_id','start_date','end_date','last_invoiced_month','pause_from','pause_until','created_at','updated_at'], dates: ['start_date','end_date','last_invoiced_month','pause_from','pause_until','created_at','updated_at'], bools: ['is_completed'] },
  { name: 'project_invoice_rows', cols: ['id','project_id','article_id','text','unit_price','quantity','sort_order','created_at','updated_at'], dates: ['created_at','updated_at'] },
  { name: 'project_price_overrides', cols: ['id','project_id','month','price','note','created_at','updated_at'], dates: ['month','created_at','updated_at'] },
  { name: 'project_billing_splits', cols: ['id','project_id','customer_id','amount','label','your_reference','sort_order','created_at','updated_at'], dates: ['created_at','updated_at'] },
  { name: 'api_tokens', cols: ['id','provider','access_token','refresh_token','expires_at','token_data','created_at','updated_at'], dates: ['expires_at','created_at','updated_at'] },
  { name: 'sync_logs', cols: ['id','type','status','invoice_id','batch_id','details','error','created_at'], dates: ['created_at'] },
  { name: 'settings', cols: ['id','key','value','created_at','updated_at'], dates: ['created_at','updated_at'] },
];

let sql = '';

for (const t of tables) {
  const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
  if (rows.length === 0) continue;

  for (const row of rows) {
    const vals = t.cols.map(c => {
      if (t.bools && t.bools.includes(c)) return toBool(row[c]);
      if (t.dates && t.dates.includes(c)) return toTs(row[c]);
      return esc(row[c]);
    });
    sql += `INSERT INTO "${t.name}" ("${t.cols.join('","')}") VALUES (${vals.join(',')});\n`;
  }
  sql += '\n';
}

// Reset sequences
for (const t of tables) {
  sql += `SELECT setval(pg_get_serial_sequence('"${t.name}"', 'id'), COALESCE((SELECT MAX(id) FROM "${t.name}"), 0) + 1, false);\n`;
}

fs.writeFileSync(path.join(__dirname, '..', 'migrate-data.sql'), sql);
console.log(`Done — ${sql.split('\n').filter(l => l.startsWith('INSERT')).length} INSERT statements written to migrate-data.sql`);
db.close();
