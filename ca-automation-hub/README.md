# CA Practice Desk

A self-hosted client document collection and compliance dashboard for Indian CA practices. Manage client checklists, share client upload portals, retain submitted files for review, track statutory dates, and optionally send reminder payloads to an n8n workflow.

## Quick start

Requirements: Node.js 18 or newer.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`. For Google sign-in, set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and the server-only `SUPABASE_SERVICE_ROLE_KEY`; otherwise the local password login remains available.

3. Start the application:

   ```sh
   npm start
   ```

4. Open `http://localhost:3000` for the workspace or `http://localhost:3000/landing.html` for the product page. Add a client from **＋ Add client**, or update the initial example records in `config/clients.json`.

## Product features

- **Practice dashboard:** client summary, document progress, search and status filters.
- **Client onboarding:** create client records and custom document checklists from the dashboard.
- **Bulk client import:** import `.xlsx` or `.csv` files with `Business Name`, `Contact Name`, `Email`, `Phone`, and `GSTIN` columns. Imported clients receive Sales Register, Bank Statement, and Purchase Invoices checklist items.
- **Google sign-in:** authenticate CA practices with Supabase OAuth; client records are stored and queried by the authenticated Supabase user ID (`ca_id`).
- **Scheduled reminders:** at 9:00 AM server local time each day, email and/or n8n reminders are sent for clients whose due day has arrived, who still have outstanding documents, and whose automatic reminders are enabled. Each message lists only that client's unsubmitted checklist items and links to their upload portal.
- **Client portal:** share a per-client capability link backed by a random upload token, not the database client ID. Clients can submit PDF, JPEG, PNG, or WebP files up to 10 MB each; public portal APIs require that token and do not return internal client records or dashboard statistics.
- **Document retention:** accepted uploads are stored in `data/uploads/`; staff can download them from the authenticated dashboard. Keep this directory private and include it in your secured backup plan.
- **Activity log:** client creation, document receipts, and successful reminder dispatches are stored with the application state.
- **Compliance calendar:** shows upcoming dates based on `config/settings.json`.
- **Optional integrations:** Anthropic parsing is used only when `ANTHROPIC_API_KEY` is configured. Without it, files are still retained for manual review and are never presented with made-up extracted figures. Configure an n8n reminder webhook in **Settings** to connect your own delivery workflow.

The reminder button sends native email when email credentials are configured and also calls the configured n8n webhook when present. Email and webhook delivery can be used together. No email credentials or webhook are configured by default.

## Configuration

### Environment

Copy `.env.example` to `.env` and configure:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`) |
| `FIRM_PASSWORD` | Staff dashboard password; overrides `auth.firmPassword` from local settings |
| `SUPABASE_URL` | Optional Supabase project URL; takes precedence over `DATABASE_URL` |
| `SUPABASE_ANON_KEY` | Supabase publishable/anon key; accepted for initialization, but generally blocked from private tables by RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | Recommended server-only key for Supabase table reads/writes; bypasses RLS, must never be exposed in frontend code |
| `EMAIL_SERVICE` | Nodemailer service name (defaults to `gmail`) |
| `EMAIL_USER` | Sender account for native reminder email |
| `EMAIL_PASS` | Sender password or Gmail app password; keep it secret |
| `EMAIL_FROM` | Optional sender display/address override; defaults to `EMAIL_USER` |
| `PUBLIC_PORTAL_URL` | Optional public origin used to construct client upload links; falls back to the Public portal URL setting |
| `INBOUND_WEBHOOK_SECRET` | Required shared secret in the `x-webhook-secret` header for `/api/webhook/inbound` |
| `DATABASE_URL` | Optional PostgreSQL (`postgresql://`) or MongoDB (`mongodb://` / `mongodb+srv://`) URI |
| `ANTHROPIC_API_KEY` | Optional; enables automated document parsing |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Optional; service account JSON for Google Sheets integration |

Database precedence is Supabase, then PostgreSQL or MongoDB from `DATABASE_URL`, then local JSON. With `SUPABASE_URL` configured, protected client, settings, and audit operations fail closed if Supabase is unavailable; they never serve or write local client data as a fallback. Local JSON is used only when no cloud database is configured. Practice settings are initialized from local defaults on first tenant access; demo clients are not automatically inserted into Supabase.

**Supabase setup:** run [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL editor. This creates `clients`, `app_state`, `authorized_tenants`, `practice_settings`, and `activity_logs`, adds tenant/reminder fields, and assigns random upload tokens to existing clients while keeping tables closed to public roles. Configure Google as an OAuth provider in Supabase and add the app URL and `/` callback to its allowed redirect URLs. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and the server-only `SUPABASE_SERVICE_ROLE_KEY`. Existing client rows receive a null `ca_id` and remain hidden until explicitly assigned to their owner. Staff APIs fail closed when Supabase authorization or protected audit storage is unavailable.

When Supabase is configured, every staff API requires a valid Google session and a verified email on the active `authorized_tenants` allowlist; the shared-password fallback is disabled. To grant a workspace, run `insert into public.authorized_tenants (email, practice_name) values ('ca@example.com', 'Example Practice');` in the Supabase SQL editor. To revoke access, set `is_active = false` for that email. The verified Supabase user ID becomes the tenant `ca_id`. Existing client rows with null `ca_id` remain hidden until explicitly assigned to their owner. The `activity_logs` table stores email, action, client, and timestamp for each successful dispatch and user action. The service requires the server-only service-role key to query these RLS-protected tables; it fails closed on authorization or audit-storage errors.

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` as server environment variables. The service-role key is required for server-side access to RLS-protected tables and must never be exposed in frontend code. Do not add broad public policies for client records. With Supabase configured, an unavailable or misconfigured Supabase service blocks staff operations instead of falling back to local client data. For PostgreSQL via `DATABASE_URL`, the app creates the `app_state` table on first connection. For MongoDB, it creates/uses the `app_state` collection in the database named in the URI, or `ca_automation_hub` if no database is specified.

### Settings and clients

- `config/settings.json`: initial practice name, due dates, reminder interval, optional n8n webhook, spreadsheet names, and public portal base URL. With a database configured, the database state is authoritative after initial seeding.
- `config/clients.json`: sample client records for local mode only. Production tenants should add or import their own clients after being authorized.
- `config/audit_logs.json`: local-mode audit log and initial cloud database seed.
- `data/uploads/`: uploaded documents. This folder is created on first upload and is excluded from source control.

`render.yaml` configures a persistent disk for uploads on Render. On Railway, attach a persistent volume mounted at `/app/data`; without it, uploaded documents may be lost on redeploy. Set the **Public portal URL** to the HTTPS address clients will use. Configure TLS and all secrets in the hosting provider, not in committed files.

The service exposes `GET /health` for hosting-provider health checks. Render and Railway configuration files use `npm ci` and `npm start`.

**Render:** connect the repository and deploy from `render.yaml`, then provide either `SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY` (and the anon key if required by your project) or a PostgreSQL/MongoDB `DATABASE_URL`. Render generates `FIRM_PASSWORD`.

**Railway:** deploy from `railway.json`, set `FIRM_PASSWORD` and the database variables in the Railway service settings, and attach a volume at `/app/data` for uploaded files.

### Google Sheets

To enable Sheets sync, configure `GOOGLE_SERVICE_ACCOUNT_JSON`, set the spreadsheet ID in `config/settings.json`, share the spreadsheet with the service account, and ensure the expected tabs/headers exist. Sheets sync is optional; the local client list and uploads remain the system of record for this MVP.

### n8n reminder workflow

Create a workflow that accepts the reminder JSON payload, configure its HTTPS webhook URL under **Settings**, and set the public portal URL there as well. The payload contains client contact details, missing document labels, upload link, due dates, and timestamp. Secure the webhook with your n8n authentication controls before connecting it.

### Native email reminders

Set `EMAIL_USER` and `EMAIL_PASS` in `.env` or the hosting provider's secret settings. For Gmail, enable 2-step verification and use a Google app password; do not use your normal account password. Set `PUBLIC_PORTAL_URL` to the deployed HTTPS origin. The dashboard button calls the authenticated `POST /api/send-reminders` endpoint. Each recipient gets only their own unsubmitted checklist items and `/upload/:clientId` link. The daily cron uses the same delivery settings.

## Run and troubleshoot

```sh
npm start
```

- **Dashboard says unauthorized:** ensure the password in browser `localStorage` under `firmPassword` matches `FIRM_PASSWORD`, or the local `auth.firmPassword`.
- **Cloud database unavailable:** check the provider logs and credentials. A connection/query failure is logged and the service continues against local JSON; on ephemeral hosting that fallback data is not durable.
- **Client data does not load:** check the server terminal and confirm the browser is using the same port as the running app.
- **Automatic parsing is unavailable:** set `ANTHROPIC_API_KEY`; uploads remain available without it.
- **Reminders are not sent:** configure and test an n8n webhook URL. The app reports delivery failures rather than claiming that an unconfigured reminder was sent.

## Before selling or using with real client records

This is an early-stage self-hosted product, not a certified accounting or document-management platform. Before accepting real client documents, configure a managed database and persistent upload storage, deploy behind HTTPS, replace demo credentials, secure and restrict server access, test backups and restores, define a retention/deletion policy, and review applicable professional, privacy, and data-protection obligations. The current dashboard uses a shared firm password, and document binaries remain on the server filesystem; add managed object storage and individual user accounts before multi-user or high-volume production use.
