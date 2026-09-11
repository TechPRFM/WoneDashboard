# WoneDashboard

Next.js operations dashboard for production catalog health, verification operations, adapter discovery, and reliability monitoring.

## Architecture

- The dashboard and main product use the same production Clerk instance and database.
- Dashboard catalog reads use a database role that can only select.
- Entry writes go through `https://www.wone.one/api/admin/entries/*`; this repository does not mutate user entries with SQL.
- The signed-in administrator's Clerk JWT is forwarded server-to-server. The main app checks `users.isAdmin` and records that user in `admin_actions`.
- Nightly discovery and reliability logs use a separate role restricted to adapter monitoring/staging tables.
- Raw source rows, verification diagnostics, email, and date of birth are not included in the bulk client payload. Private evidence is fetched per entry, on demand.

## Entry Operations

| Dashboard action | Main app route |
| --- | --- |
| Fetch with a unique result link | `POST /api/admin/entries/{id}/verify-link` |
| Run the mapped adapter without a link | `POST /api/admin/entries/{id}/rearm` with `runNow: true` |
| Mark DNS, DNF, or untimed | `POST /api/admin/entries/{id}/outcome` |
| Correct unverified fields | `PATCH /api/admin/entries/{id}` |

Verified entries are immutable through these routes. Strava-only is displayed as an entry state, not saved as an outcome. DQ is intentionally not offered by the dashboard contract.

## Local Setup

Create `.env.local` from `.env.example` and provide real values without committing them:

```env
DATABASE_URL="postgresql://ops_readonly.fpynisjwugworsctojie:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require"
ADAPTER_OPS_DATABASE_URL="postgresql://ops_monitoring.fpynisjwugworsctojie:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require"
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/ops
MAIN_APP_URL=https://www.wone.one
```

Then run:

```powershell
npm install
npm run typecheck
npm run dev
```

Open `http://localhost:3050/ops`.

## Production Setup

1. Add `ops.wone.one` to the dashboard Vercel project.
2. Add Vercel's requested CNAME in the DNS provider for `wone.one` and wait for verification.
3. Add the production Clerk keys to the dashboard Vercel project under Production only.
4. Set `CLERK_AUTHORIZED_PARTIES=https://wone.one,https://www.wone.one,https://ops.wone.one` on the main WONE Vercel project.
5. Remove `OPS_BASIC_AUTH_USER` and `OPS_BASIC_AUTH_PASSWORD`; Clerk replaces shared Basic Auth.
6. Set `MAIN_APP_URL=https://www.wone.one`. The bare domain redirects, and the canonical host avoids losing the bearer token during a redirect.

Never store `sk_live_*`, database passwords, or `CRON_SECRET` in Git or Preview-scoped variables.

## Database Roles

Generate strong passwords outside source control, then run once in the production Supabase SQL editor:

```sql
create role ops_readonly with login password '<strong-read-password>';
grant connect on database postgres to ops_readonly;
grant usage on schema public to ops_readonly;
grant select on all tables in schema public to ops_readonly;
alter default privileges for role postgres in schema public grant select on tables to ops_readonly;
revoke select on strava_accounts, gmail_import_tokens, oauth_states from ops_readonly;
alter role ops_readonly set statement_timeout = '30s';

create role ops_monitoring with login password '<strong-monitoring-password>';
grant connect on database postgres to ops_monitoring;
grant usage on schema public to ops_monitoring;
grant select on public.race_edition_mappings to ops_monitoring;
grant select, insert, update on public.adapter_upcoming_events to ops_monitoring;
grant select, insert, update on public.adapter_ops_runs to ops_monitoring;
grant select, insert, update on public.adapter_ops_adapter_results to ops_monitoring;
grant usage, select on sequence public.adapter_ops_adapter_results_id_seq to ops_monitoring;
alter role ops_monitoring set statement_timeout = '5min';
```

Verify `ops_readonly` using `select current_user;`, then run an update that affects no rows. PostgreSQL must still return `permission denied`.

## Adapter Operations

Apply the additive monitoring schema once with `npm run db:adapter-ops`. It adds only adapter staging and monitoring objects.

- `ADAPTER_DISCOVERY_URL` returns `{ events: [...], adapters: [...] }`.
- `ADAPTER_STRESS_URL` returns `overall` and `byAdapter` reliability results.
- `ADAPTER_SERVICE_TOKEN` authenticates those service calls.
- `CRON_SECRET` protects `/api/cron/adapters` in both the proxy and route handler.
- The Vercel cron runs at `20:00 UTC`, or `01:30 IST` the following day.

Adapter matching searches every category/division, uses age and gender only to corroborate a name/bib match, preserves DNS/DNF/DQ source evidence, and returns a result link for an open admin decision when no structured row exists.

## Verification

```powershell
npm run typecheck
npm run build
npm audit --omit=dev
```

Only set `PG_REJECT_UNAUTHORIZED=false` when a trusted local network injects a self-signed certificate. Do not use that override in Vercel.
