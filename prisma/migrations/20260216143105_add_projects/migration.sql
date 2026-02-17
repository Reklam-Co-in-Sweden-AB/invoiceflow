-- CreateTable
CREATE TABLE "projects" (
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
    "start_date" DATETIME,
    "end_date" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "projects_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_blikk_project_id_key" ON "projects"("blikk_project_id");
