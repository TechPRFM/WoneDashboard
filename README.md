# WoneDashboard

Read-only Next.js dashboard for inspecting production DB health.

## What It Shows

- Race -> Edition -> Category grouping
- Edition timelines under each Race
- Category distances and result counts
- Adapter mappings per edition
- Result, registration, and unmatched-entry counts
- Data-quality flags for cleanup work

## Current Flags

- Wrong fuzzy edition/race grouping candidates
- Race title contains a year
- Edition title repeats a year
- Edition title year differs from `edition.year`
- `edition.year` differs from `eventDate` year
- Missing event dates
- Missing location or structured city
- Editions without categories
- Editions without adapter mappings
- Distance categories with `totalDistanceKm = null`
- Category label vs `totalDistanceKm` mismatch
- Age-group labels imported as race categories
- Mapping year mismatch
- Mapping rawName title mismatch

## Setup

Create `.env.local`:

```env
DATABASE_URL="postgresql://postgres.fpynisjwugworsctojie:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require"
```

Then run:

```powershell
npm install
npm run dev
```

Open:

```text
http://localhost:3050
```

The app is read-only. It does not insert, update, or delete DB rows.

## Vercel

Import this GitHub repo into Vercel as a Next.js project.

Set this environment variable in Vercel:

```env
DATABASE_URL=postgresql://postgres.fpynisjwugworsctojie:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require
```

Only add `PG_REJECT_UNAUTHORIZED=false` if the deployed environment fails with a certificate-chain error.
