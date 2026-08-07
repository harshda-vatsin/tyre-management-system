# EBTMS — EV Bus Tyre Management System

Full-stack fleet tyre management system for an EV bus operator, per the
project SRS: depot/bus/tyre master data, tyre card lifecycle tracking,
threshold-based alerting, role-based access control, and a full audit trail.

## Stack

- **Backend**: Node.js + Express, JWT auth, bcrypt password hashing,
  PostgreSQL via `pg` (a hand-written better-sqlite3-shaped adapter in
  `db.js`, so most route/service code reads like synchronous SQLite calls
  with `await` added)
- **Frontend**: Next.js (App Router), plain CSS — a pure client-rendered
  SPA against the Express API (no Next.js API routes / server actions;
  the Express backend remains the only server)
- **Storage**: PostgreSQL (`DATABASE_URL` in `backend/.env`); uploaded MIS
  Excel workbooks are kept on local disk at `backend/uploads/mis-imports/`
  (created automatically on first upload)
- **Background jobs**: `pg-boss` (Postgres-native queue, same database --
  no Redis/separate broker) for the MIS Excel importer's Confirm phase

## Project layout

```
ebtms/
  backend/
    src/
      routes/       one file per resource (auth, depots, busModels, buses,
                     tyres, events, thresholds, alerts, users, audit,
                     reports, dashboard)
      middleware/    auth.js — JWT verification + role-based access control
      utils/         roles.js (shared role constants), auditLog.js,
                      tyreEvents.js, readingValidation.js
      db.js          schema (idempotent CREATE TABLE IF NOT EXISTS, applied
                      on every boot) + Postgres connection pool
      misImport/     MIS Excel importer: parsers, Replay Engine, pg-boss
                      job queue, import session store
      seed.js        seed script (depots, bus models, buses, tyres, users,
                      thresholds)
      index.js       Express app entry point -- also starts the pg-boss
                      job queue before accepting HTTP connections
  frontend/
    app/             Next.js App Router routes. (protected)/ route group
                      shares one auth-guarded layout (sidebar + topbar);
                      /login sits outside it.
    components/      AuthContext, Layout, ProtectedRoute, Providers,
                      Pagination, FilterBar, Modal, TyreSelect
    lib/             api.js (fetch wrapper with JWT attached), roles.js
    next.config.js    dev-mode rewrite of /api/* to the Express server
                      (production traffic never hits this -- Nginx proxies
                      /api/* straight to the backend, see deploy/nginx.conf)
```

## Setup

Requires a running PostgreSQL instance first (a local Docker container is
the easiest path for dev: `docker run -d --name ebtms-pg -e POSTGRES_PASSWORD=devpassword -p 5432:5432 postgres:16`,
then create the `ebtms` database). `backend/.env`'s `DATABASE_URL` must
point at it before anything else below will connect.

```bash
# Backend
cd ebtms/backend
npm ci
cp .env.example .env   # set DATABASE_URL if it differs from the default
npm run seed     # wipes and reseeds all tables with demo data
npm start        # http://localhost:4000 -- also creates the MIS schema,
                  # the pg-boss job-queue schema, and backend/uploads/ on
                  # first run

# Frontend (separate terminal)
cd ebtms/frontend
npm ci
npm run dev       # http://localhost:3000
```

The frontend dev server rewrites `/api/*` to `http://localhost:4000/api/*`
(see `next.config.js`), so both must be running for the app to work.

## Seeded users

All seeded users share the password `Passw0rd!`.

| Username  | Role                    | Depot scope |
|-----------|-------------------------|-------------|
| admin     | System Administrator    | All         |
| nfm       | National Fleet Manager  | All         |
| dm_del    | Depot Manager           | Delhi Central Depot |
| dm_mum    | Depot Manager           | Mumbai West Depot |
| ts_del    | Tyre Supervisor         | Delhi Central Depot |
| ts_mum    | Tyre Supervisor         | Mumbai West Depot |
| auditor   | Read-Only Auditor       | All |

## Status

**Working: Authentication + Master Data Layer + Operational Tyre Lifecycle.**

- Auth: JWT login, RBAC middleware, audit logging on every mutation
- Depot Master (FR-DM-01/02/03): full CRUD, Administrator-only write
- Bus Model / tyre-position templates (FR-BM-XX): full CRUD, admin picks a
  total tyre count and the position layout/codes are auto-generated,
  Administrator-only write
- Bus Master (FR-BM-01/02/03): full CRUD, search/filter/pagination,
  status management, transfer-between-depots (cascades to mounted
  tyres), bus detail page with live tyre position map
- Tyre Master (FR-TC-01): full CRUD, search/filter/pagination, status
  management, tyre detail page
- User Management (SRS 8.2): full CRUD, deactivate, reset password,
  role/depot assignment, Administrator-only
- Threshold Configuration (SRS 8.1): NSD/Pressure/Inspection
  Interval/Escalation Days, global + depot/bus-model overrides,
  validation, audit logging
- Tyre Card event log (FR-TC-02/03): all 8 SRS event types (NSD
  reading, pressure reading, rotation, replacement, puncture repair,
  inter-bus transfer, send-to-store, condemnation), append-only,
  filterable by type and date range
- Bus Tyre Position Map (FR-TC-04): live last-NSD/last-pressure/last-
  event-date per position, with threshold-breach coloring
- Batch Inspection (FR-RW-01): bus-wide NSD+pressure entry in one
  session, creating individual tyre card events
- **Business Rules Engine (FR-AL-01 to 04, §7.4)**: threshold
  evaluation on every NSD/Pressure reading (depot/bus-model override →
  global precedence), automatic breach alerts (one active alert per
  tyre+parameter, updated not duplicated on repeat breaches),
  auto-resolution on in-range readings, manual acknowledge/resolve
  (mandatory note), automatic escalation of stale Open alerts,
  automatic Inspection Overdue alerts. Reconciliation (escalation +
  inspection sync) runs synchronously on every alerts/compliance read
  — no background job scheduler was added.
- **Dashboard Layer (§7.1/§7.2)**: role-adaptive landing page ("/") —
  National Dashboard (Admin/NFM/Auditor: fleet summary cards, tyre
  status + alert severity charts, inspection due/overdue, top 10
  flagged buses, depot-wise compliance score with click-through
  drill-down) and Depot Dashboard (Depot Manager/Tyre Supervisor: own
  depot only — bus summary, active alerts, tyres in store with age,
  upcoming inspections, compliance stats). One aggregation service
  (`dashboardService.js`) backs both views; the depot dashboard is the
  same functions called with a depot filter, not a second
  implementation.

- **Reporting & Export (§7.3)**: all 10 standard reports (Tyre Status,
  Flagged Tyres, Tyre History, Bus Tyre Health, Rotation & Replacement
  Log, Puncture Incident, Inter-Bus Transfer Log, Tyre Life, Inspection
  Compliance, Condemned Tyres) with their exact SRS filter sets, paginated
  preview + full unpaginated XLSX/PDF export (report name, generation
  timestamp, applied filters, generated-by user, PDF page numbers,
  company-branding placeholder on every export). One `reportService.js`
  registry backs preview and export identically; report 9 reuses
  `inspectionService` directly rather than redefining "overdue".

- **MIS Excel Import** (Admin-only, `/admin/mis-import`): imports the
  company's monthly MIS workbook -- Consumption, Puncture Repair,
  Retread, Scrap, Warranty, NSD, Rotation, and Wheel Alignment sheets --
  as a permanent, immutable system-of-record (`mis_*` tables) that
  generates lifecycle events through the same `createTyreEvent()` path
  as manual entry, never bypassing it. Two-phase: a synchronous Preview
  (parse + validate + a dry-run replay that's rolled back, so nothing is
  written) followed by a background-job Confirm (`pg-boss`) that commits
  for real, with live progress reporting. Duplicate re-imports are
  detected via a fingerprint hashed over resolved references (new / exact
  duplicate / conflicting duplicate). Admin-only kill switch
  (`mis_import_enabled` under System Parameters) and zip-bomb/row-count
  limits guard the upload path.

**Explicitly deferred**: notifications (email/SMS/WhatsApp) beyond the
existing threshold-alert emails, QR scanning, the printable tyre-card PDF
specifically (only the 10 standard reports were in scope), 2FA, ERP
integration, scheduled/emailed reports, mid-job cancellation for the MIS
importer (only "cancel before it starts running" is implemented).

See the requirement traceability matrix in project history for the
full FR-to-file mapping.

## Production Deployment (Linux VM)

Architecture: `Browser → Nginx → Next.js (PM2, :3000)` and
`Browser → Nginx /api → Express (PM2, :4000) → PostgreSQL`. Nginx is the
only public entry point; both Node processes and Postgres bind to
`127.0.0.1` and are never exposed directly. See `deploy/nginx.conf` and
`ecosystem.config.js` at the repo root.

```bash
# 1. System prerequisites (Node 18.17+, matches Next.js 14's requirement)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx build-essential python3
sudo npm ci -g pm2

# 2. PostgreSQL (skip if using an already-managed instance -- just make
#    sure DATABASE_URL in step 4 points at it)
sudo apt-get install -y postgresql
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '<a-real-password>';"
sudo -u postgres createdb ebtms

# 3. Get the code
git clone <your-repo-url> ebtms
cd ebtms

# 4. Backend
cd backend
npm ci
cp .env.example .env
# edit .env: set a real JWT_SECRET (openssl rand -hex 32) and DATABASE_URL
# (postgres://postgres:<password>@localhost:5432/ebtms), leave PORT/HOST
npm run seed        # first deploy only -- wipes all tables, seeds demo data
cd ..

# 5. Frontend
cd frontend
npm ci
cp .env.example .env   # defaults are correct for same-VM deployment
npm run build
cd ..

# 6. Start both under PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup          # run the command it prints (systemd service, survives reboot)

# 7. Nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/ebtms
sudo sed -i 's/YOUR_DOMAIN_OR_VM_IP/<your-domain-or-ip>/' /etc/nginx/sites-available/ebtms
sudo ln -s /etc/nginx/sites-available/ebtms /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # avoid a default-site conflict
sudo nginx -t
sudo systemctl reload nginx

# 8. Health check
curl -I http://localhost/            # expect 200 from Next.js
curl -s http://localhost/api/health  # expect {"status":"ok"}
```

The backend creates everything it needs on first boot -- the application
schema, `pg-boss`'s own queue schema, and `backend/uploads/mis-imports/`
(uploaded MIS workbooks) -- as long as the OS user running PM2 can connect
to Postgres and write to the `backend/` directory. No separate migration
step.

`npm run seed` is destructive (`DELETE FROM` on every table) -- run it once
against a fresh database, never again against one with real data.

### Memory limit (zip-bomb defense in depth)

The MIS Excel importer rejects implausibly large workbooks at the
application level (`backend/src/misImport/workbookLimits.js`), but that
guard runs *after* the file is already decompressed in memory. The real
backstop against a genuinely adversarial file is a process memory limit --
`ecosystem.config.js` sets `max_memory_restart` on the backend process for
exactly this; confirm it's still appropriate for your VM's available RAM
before going live, rather than assuming the default is right.

### HTTPS and the QR scanner

The config above is HTTP-only. Everything works except the `/scan` page's
camera: browsers only allow `getUserMedia` (camera access) in a secure
context -- HTTPS, or `localhost`. Over plain HTTP on a domain or IP, `/scan`
does not crash -- it catches the camera failure and falls back to its
built-in manual tyre-number lookup -- but the actual QR scan will not start.

To enable it, point a domain at the VM and add HTTPS:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Let's Encrypt cannot issue a certificate for a bare IP address, so a domain
is required for this step.
