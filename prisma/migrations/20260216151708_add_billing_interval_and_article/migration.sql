-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_projects" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "blikk_project_id" INTEGER NOT NULL,
    "order_number" TEXT,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "category_color" TEXT,
    "invoice_type" TEXT,
    "customer_id" INTEGER,
    "status" TEXT,
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "monthly_price" REAL,
    "billing_interval" TEXT NOT NULL DEFAULT 'monthly',
    "invoice_week" INTEGER,
    "article_id" INTEGER,
    "start_date" DATETIME,
    "end_date" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "projects_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "projects_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_projects" ("blikk_project_id", "category", "category_color", "created_at", "customer_id", "end_date", "id", "invoice_type", "invoice_week", "is_completed", "monthly_price", "order_number", "start_date", "status", "title", "updated_at") SELECT "blikk_project_id", "category", "category_color", "created_at", "customer_id", "end_date", "id", "invoice_type", "invoice_week", "is_completed", "monthly_price", "order_number", "start_date", "status", "title", "updated_at" FROM "projects";
DROP TABLE "projects";
ALTER TABLE "new_projects" RENAME TO "projects";
CREATE UNIQUE INDEX "projects_blikk_project_id_key" ON "projects"("blikk_project_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
