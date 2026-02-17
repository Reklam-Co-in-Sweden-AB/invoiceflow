# FakturaFlöde — Teknisk Plan (v3 — Node.js)

## Sammanfattning

Webbapp som automatiserar faktureringsflödet mellan Blikk och Visma eEkonomi.
Hämtar fakturor från Blikk, lägger till månadsbeteckning, fördelar jämnt över
4 veckor, exporterar till Visma, och skriver tillbaka status till Blikk.

---

## Arkitektur

```
┌─────────────┐                ┌──────────────────┐                ┌─────────────────┐
│   Blikk     │   1. Pull      │  FakturaFlöde    │   4. Push      │ Visma eEkonomi  │
│   API       │ ──────────▶    │  (Node.js)       │ ──────────▶    │ API             │
│             │  GET /invoices │                  │  POST drafts   │                 │
│             │  (ej skickade) │  ┌────────────┐  │                │                 │
│             │                │  │  MySQL 8    │  │                │                 │
│             │◀────────────── │  │  (Prisma)   │  │◀────────────── │                 │
│             │   6. Writeback │  └────────────┘  │  5. Bekräftelse│                 │
│             │  PATCH sent-   │                  │  (fakturanr)   │                 │
│             │  toeconomy-    │  Dashboard +     │                │                 │
│             │  system        │  Review UI       │                │                 │
└─────────────┘                └──────────────────┘                └─────────────────┘
                                ▲
┌─────────────┐                │
│ Webbhotell  │  Lokalt UI ────┘
│ (eget)      │
└─────────────┘
```

### Detaljerat flöde

```
Steg  Källa → Mål              API-anrop                          Beskrivning
────  ──────────────            ─────────                          ───────────
1     Blikk → FakturaFlöde     GET /v1/core/invoices              Hämta alla invoices där
                                (sentToEconomySystem = null)       sentToEconomySystem är null
                                                                   Inkl. rader, kund, period

2     FakturaFlöde              —                                  Lägg till månadsbeteckning
                                                                   på varje rad baserat på
                                                                   invoice.fromDate/toDate

3     FakturaFlöde              —                                  Användaren granskar,
                                                                   redigerar, godkänner

4     FakturaFlöde              —                                  LPT-algoritm fördelar
                                                                   godkända fakturor över
                                                                   4 veckor

5     FakturaFlöde → Visma      POST /v2/customerinvoicedrafts     Skapa fakturadraft i Visma
                                                                   med artiklar, text, belopp

6     FakturaFlöde → Blikk      PATCH /v1/core/invoices/:id/       Markera Blikk-fakturan
                                setsenttoeconomysystem              som skickad med datum +
                                ?date=YYYY-MM-DD                   Visma-fakturanummer
                                &economySystemInvoiceNumber=X
```

---

## Techstack

| Komponent | Val | Motivering |
|-----------|-----|------------|
| Runtime | Node.js 18+ | cPanel Node.js App (Passenger) |
| Backend | Express.js | Lättviktigt, beprövat, enkel routing |
| Templates | EJS | Server-rendered, inget byggsteg |
| Interaktivitet | htmx + Alpine.js (CDN) | Livewire-känsla utan React/Vue-bygge |
| CSS | Tailwind CSS (CDN) | Snabb prototypning |
| Diagram | Chart.js 4 (CDN) | Inga npm-beroenden |
| Databas | MySQL 8 | Tillgänglig på Oderland |
| ORM | Prisma | Migrations, typsäkerhet, bra DX |
| Auth | express-session + bcrypt | Ett konto, enkelt |
| Schemaläggning | node-cron / cPanel cron | Synk + export automatiskt |
| HTTP-klient | undici | API-anrop mot Blikk + Visma |

---

## Projektstruktur

```
fakturaflode/
├── prisma/
│   ├── schema.prisma          # Databasschema
│   └── seed.js                # Artikelregister + admin-konto
├── src/
│   ├── server.js              # Express-app, middleware, start
│   ├── routes/
│   │   ├── auth.js            # Login/logout
│   │   ├── dashboard.js       # Översikt
│   │   ├── invoices.js        # Granska + alla fakturor
│   │   ├── batches.js         # Batcher/veckofördelning
│   │   ├── hosting.js         # Webbhotell CRUD
│   │   ├── customers.js       # Kundlista
│   │   ├── settings.js        # Inställningar
│   │   └── api.js             # htmx-endpoints (partials)
│   ├── services/
│   │   ├── blikk-client.js    # Blikk API (auth, rate limit, paginering)
│   │   ├── blikk-sync.js      # Synka fakturor från Blikk
│   │   ├── visma-client.js    # Visma API (OAuth 2.0)
│   │   ├── visma-export.js    # Exportera drafts till Visma
│   │   ├── blikk-writeback.js # Markera som skickad i Blikk
│   │   ├── distributor.js     # LPT-algoritm
│   │   ├── month-label.js     # Månadsbeteckning-logik
│   │   └── scheduler.js       # Cron-jobb
│   ├── middleware/
│   │   └── auth.js            # Session-check
│   └── views/
│       ├── layout.ejs         # Huvudlayout med sidebar
│       ├── login.ejs
│       ├── dashboard.ejs
│       ├── review.ejs
│       ├── invoices.ejs
│       ├── batches.ejs
│       ├── hosting.ejs
│       ├── customers.ejs
│       ├── settings.ejs
│       └── partials/
│           ├── sidebar.ejs
│           ├── topbar.ejs
│           ├── invoice-row.ejs    # htmx-partial
│           ├── invoice-table.ejs  # htmx-partial
│           └── batch-card.ejs     # htmx-partial
├── public/
│   └── css/
│       └── app.css            # Custom styles
├── package.json
├── .env
└── .env.example
```

---

## Databasschema

### customers
Synkad från Blikk-kontakter + manuella webbhotellkunder.

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| blikk_contact_id | int nullable | Blikk Contact.id |
| visma_customer_id | string nullable | Visma CustomerID |
| customer_number | string | Kundnummer |
| name | string | Företagsnamn |
| org_number | string nullable | Organisationsnummer |
| email | string nullable | Fakturamail |
| your_reference | string nullable | Er referens |
| our_reference | string nullable | Vår referens |
| created_at | datetime | |
| updated_at | datetime | |

### articles
Artikelregister med mappning mellan system.

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| article_number | string unique | 101, 103, 108, 211, 2101 |
| name | string | Artikelnamn |
| visma_article_id | string nullable | Visma ArticleId |
| service_type | enum | marknadskoordinator, supportavtal, webbhotell |
| default_price | decimal(10,2) | Standardpris |
| vat_rate | decimal(4,2) default 25.00 | Momssats |
| created_at | datetime | |
| updated_at | datetime | |

### invoices
Huvudentitet — en rad per faktura. Kopplar till Blikk-faktura via blikk_invoice_id.

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| customer_id | FK customers | |
| blikk_invoice_id | int nullable unique | Blikk Invoice.id |
| visma_draft_id | string nullable | Visma draft-ID efter export |
| visma_invoice_number | string nullable | Visma fakturanummer |
| service_type | enum | marknadskoordinator, supportavtal, webbhotell |
| invoice_month | date | Månad (YYYY-MM-01) |
| month_label | string | "Mars 2026" |
| from_date | date nullable | Blikk fromDate |
| to_date | date nullable | Blikk toDate |
| scheduled_date | date nullable | Planerat exportdatum |
| scheduled_week | tinyint nullable | Vecka 1-4 |
| total_amount | decimal(10,2) | Totalbelopp |
| status | enum | Se statusflöde nedan |
| batch_id | FK batches nullable | |
| blikk_synced_at | datetime nullable | När hämtad från Blikk |
| blikk_writeback_at | datetime nullable | När markerad i Blikk |
| visma_exported_at | datetime nullable | När exporterad till Visma |
| error_message | text nullable | Senaste felmeddelande |
| created_at | datetime | |
| updated_at | datetime | |

**Statusflöde:**
```
pending_review → approved → scheduled → exporting → exported → confirmed
                                                   ↘ failed (kan retry)
pending_review → skipped
```

- `pending_review` — Hämtad från Blikk, väntar granskning
- `approved` — Godkänd av användaren
- `scheduled` — Tilldelad en batch/vecka
- `exporting` — Håller på att exporteras till Visma
- `exported` — Skapad som draft i Visma, väntar bekräftelse
- `confirmed` — Visma-draft OK + markerad i Blikk (slutstatus)
- `failed` — Export eller writeback misslyckades
- `skipped` — Användaren valde att hoppa över

### invoice_lines
Fakturarader med månadsbeteckning.

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| invoice_id | FK invoices | |
| article_id | FK articles nullable | |
| blikk_row_id | int nullable | Blikk row.id |
| text | string | "Supportavtal-Small — Mars 2026" |
| quantity | decimal(10,2) | |
| unit_price | decimal(10,2) | |
| discount | decimal(5,2) default 0 | |
| line_total | decimal(10,2) | Beräknad |
| sort_order | int | |
| created_at | datetime | |
| updated_at | datetime | |

### batches
Veckogrupper för kassaflödesfördelning.

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| invoice_month | date | YYYY-MM-01 |
| week_number | tinyint | 1-4 |
| scheduled_date | date | Måndagens datum |
| invoice_count | int default 0 | |
| total_amount | decimal(12,2) default 0 | |
| status | enum | pending, exporting, exported, confirmed |
| created_at | datetime | |
| updated_at | datetime | |

### hosting_subscriptions
Webbhotellprenumerationer (ej i Blikk).

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| customer_id | FK customers | |
| domain | string | mantorp.se |
| billing_interval | enum | monthly, quarterly, semi_annual, annual |
| next_billing_date | date | |
| is_active | boolean default true | |
| notes | text nullable | |
| created_at | datetime | |
| updated_at | datetime | |

### hosting_subscription_lines
Artikelrader för webbhotellprenumerationer.

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| subscription_id | FK hosting_subscriptions | |
| article_id | FK articles | |
| description | string | |
| quantity | decimal(10,2) default 1 | |
| unit_price | decimal(10,2) | |
| created_at | datetime | |
| updated_at | datetime | |

### api_tokens
OAuth-tokens för Visma (krypterade).

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| provider | string | visma, blikk |
| access_token | text | Krypteras i applikationen |
| refresh_token | text nullable | Krypteras i applikationen |
| expires_at | datetime | |
| token_data | json nullable | Extra metadata |
| created_at | datetime | |
| updated_at | datetime | |

### sync_logs
Revisionslogg för alla synk- och exportoperationer.

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| type | enum | blikk_sync, visma_export, blikk_writeback, hosting_generate |
| status | enum | started, completed, failed |
| invoice_id | FK invoices nullable | |
| batch_id | FK batches nullable | |
| details | json nullable | Request/response-data |
| error | text nullable | |
| created_at | datetime | |

### settings
Appkonfiguration (key-value).

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| key | string unique | |
| value | text nullable | |
| created_at | datetime | |
| updated_at | datetime | |

### users
Admin-konto för inloggning.

| Kolumn | Typ | Beskrivning |
|--------|-----|-------------|
| id | int PK auto | |
| email | string unique | |
| password_hash | string | bcrypt |
| name | string | |
| created_at | datetime | |
| updated_at | datetime | |

---

## Kärnlogik

### 1. Blikk-synk (hämta fakturor)

```js
// services/blikk-sync.js
// 1. Autentisera: POST /v1/Auth/Token (Basic auth → Bearer)
// 2. GET /v1/core/invoices?page=1&pageSize=100
//    Filtrera: sentToEconomySystem = null
//    Rate limit: 4 req/s
// 3. För varje Blikk-faktura:
//    a. Matcha/skapa Customer via blikk_contact_id
//    b. Bestäm service_type från artikelnummer i raderna
//    c. Beräkna invoice_month från fromDate/toDate
//    d. Generera month_label ("Mars 2026")
//    e. Skapa Invoice + InvoiceLines med status pending_review
//    f. Lägg till månadsbeteckning på varje radtext:
//       "Supportavtal-Small" → "Supportavtal-Small — Mars 2026"
// 4. Logga i sync_logs
```

**Deduplicering:** `blikk_invoice_id` är unique — samma faktura importeras aldrig två gånger.

### 2. Veckofördelningsalgoritm (LPT)

```
Input:  Lista av godkända fakturor för en månad
Output: 4 batcher med jämn monetär fördelning

1. Beräkna 4 måndagsdatum (vecka 1-4)
2. Skapa 4 tomma batcher med löpande summa = 0
3. Sortera fakturor efter belopp (störst först)
4. För varje faktura:
   - Tilldela till batchen med lägst löpande summa
   - Uppdatera batchens summa
5. Spara scheduled_week och scheduled_date på varje faktura
```

### 3. Visma-export + Blikk-writeback

```
För varje batch som ska exporteras:
  För varje faktura i batchen:
    1. POST /v2/customerinvoicedrafts till Visma
       - CustomerID, InvoiceDate, Rows med ArticleId + Text + belopp
    2. Om lyckat:
       - Spara visma_draft_id, visma_invoice_number
       - Status → exported
    3. PATCH /v1/core/invoices/:blikk_invoice_id/setsenttoeconomysystem
       - date = exportdatum
       - economySystemInvoiceNumber = Visma-fakturanummer
    4. Om lyckat:
       - blikk_writeback_at = now
       - Status → confirmed (slutstatus)
    5. Om fel: status → failed, spara error_message
```

### 4. Webbhotell-generering

```
// npm run hosting:generate

1. Hämta alla aktiva prenumerationer där next_billing_date <= idag
2. För varje prenumeration:
   a. Skapa Invoice + InvoiceLines från subscription_lines
   b. Lägg till månadsbeteckning
   c. Status: pending_review
   d. Uppdatera next_billing_date (nästa intervall)
```

---

## API-endpoints (Blikk)

| Metod | Endpoint | Användning |
|-------|----------|------------|
| POST | /v1/Auth/Token | Hämta Bearer token |
| GET | /v1/core/invoices | Hämta fakturor (paginerat, filter) |
| GET | /v1/core/invoices/:id | Hämta enskild faktura med rader |
| PATCH | /v1/core/invoices/:id/setsenttoeconomysystem | Markera som skickad till ekonomisystem |
| GET | /v1/Core/Contacts | Hämta kontakter/kunder |
| GET | /v1/Core/Projects/:id | Hämta projektinfo (referens) |

## API-endpoints (Visma eEkonomi)

| Metod | Endpoint | Användning |
|-------|----------|------------|
| POST | /v2/customerinvoicedrafts | Skapa fakturadraft |
| GET | /v2/customers | Hämta/matcha kunder |
| GET | /v2/articles | Hämta artiklar |

---

## Implementationsfaser

### Fas 1: Grund
- Node.js-projekt, Express, EJS, Prisma
- Alla migrations + seed
- Auth (express-session + bcrypt)
- Layout med sidebar (matchar mockup)

### Fas 2: Blikk-integration
- BlikkClient med auth, rate limiting, paginering
- BlikkInvoiceSync — hämta fakturor, skapa lokala kopior
- Kundsynk (Contacts → customers)
- Månadsbeteckning-logik

### Fas 3: Review-UI
- Fakturatabell med htmx — filter, sök, expand
- Inline-redigering av text/belopp
- Bulk-godkänn/hoppa över
- Detaljvy per faktura

### Fas 4: Fördelning
- LPT-algoritm (distributor.js)
- Batch-vy med veckokort
- Manuell justering
- Chart.js stapeldiagram

### Fas 5: Visma-integration
- VismaClient (OAuth 2.0 + refresh)
- Settings-sida: "Anslut till Visma"
- VismaExporter — skapa drafts
- BlikkWriteback — PATCH setsenttoeconomysystem
- Export med retry + felhantering

### Fas 6: Webbhotell + Dashboard
- CRUD för prenumerationer
- Automatisk fakturagenerering
- Dashboard: summor, veckodiagram, prognos, aktivitetslogg

### Fas 7: Deploy
- cPanel: Setup Node.js App
- cron-jobb
- E-postnotiser vid fel

---

## cPanel Deployment

```bash
# 1. cPanel → "Setup Node.js App"
#    Application root: /home/user/fakturaflode
#    Application URL: fakturaflode.dindoman.se
#    Application startup file: src/server.js
#    Node.js version: 18+

# 2. cPanel → MySQL Databases
#    Skapa databas + användare

# 3. SSH eller cPanel Terminal:
cd ~/fakturaflode
npm install --production
npx prisma migrate deploy
npx prisma db seed
cp .env.example .env  # Fyll i
touch tmp/restart.txt  # Passenger restart

# 4. cPanel → Cron Jobs
#    Varje minut: cd /home/user/fakturaflode && node src/cron.js
```

---

## Verifiering

1. **Blikk-synk:** `npm run sync:blikk` → verifiera att fakturor med sentToEconomySystem=null hämtas, rader skapas med månadsbeteckning
2. **Deduplicering:** Kör synk igen → inga dubbletter (blikk_invoice_id unique)
3. **Fördelning:** `npm run distribute -- --month=2026-03` → 4 batcher, jämn fördelning
4. **Visma-export:** Sandbox → verifiera drafts med korrekta artiklar/text
5. **Blikk-writeback:** Verifiera att PATCH setsenttoeconomysystem anropas med rätt datum + fakturanr
6. **Blikk-statistik:** Kontrollera i Blikk UI att fakturor visar "Skickad till ekonomisystem"
7. **Webbhotell:** Skapa prenumeration → generera → granska → exportera
8. **End-to-end:** Blikk-synk → granskning → godkänn → fördela → Visma-export → Blikk-writeback → verifiera båda systemen
