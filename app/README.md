# Seasonal Management App

This app is a static Next.js export designed for development in a browser and operational use inside the Tauri Windows desktop shell. Authenticated self-hosted Supabase is the normal durable read/write authority. Zustand keeps operator-scoped server snapshots in memory so route remounts can render immediately; IndexedDB and SQLite are not schedule-read or failure fallbacks.

The same export also contains the isolated anonymous routes `/reports/traffic` and `/reports/traffic/dashboard`. Their `(public-report)` root does not import the Tauri/authenticated desktop graph and reads only versioned aggregate GET endpoints under `/api/report/v1`. See `../docs/runbooks/public-traffic-report-deploy.md` for the Nginx/Cloudflare staging and rollout boundary.

The current desktop/package version is `0.1.26`. Before release or migration work, read `../docs/current-implementation-status.md`: local `main`, `origin/main`, branch-only migrations, database apply and public-route activation are currently not identical states.

## Current Operating Contracts

- Desktop route reads use the shared V2 workspace coordinator and bounded `get_season_schedule_allocation_window_v2` pages. Normal failures preserve an existing server snapshot when available but never fall back to direct-table fan-out, IndexedDB or SQLite.
- Normal Save writes serialize explicit `changedFields` and call `apply_season_server_mutation_v1`; `Fetch data` forces a server-window revalidation and does not submit local drafts.
- Seasonal import uses the native Planning draft RPCs (registry contract 4), with one full-file snapshot mode and `seasonal.write` permission. The file replaces the target season's active draft scope, including absent manual flights; uniquely matched flights retain allocations. Preview lists removals and requires the season code. Import never publishes or changes Operations. Settings no longer exposes seasonal Repair/import.
- Daily import recognizes exactly one 43-column OperationalTurns/compact-LB compatible table, parses it in a Web Worker and uploads full-season data through resumable V2 chunks. Preview never reserves operational dates; one atomic commit replaces the complete affected-date scope, preserves operational overrides and records Daily authority. Cancelled-row coverage and explicitly confirmed zero-flight dates remain part of that scope. The import route requires `NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED=1`; it no longer falls back to the legacy seasonal writer.
- The source contains the public Report live-v2 path with canonical aggregates pinned by watermark, semantic `data_as_of`, filter hash and read-version token. `Pax NULL` remains missing; `Pax 0` is reported true-zero. The 2026-09-04 public endpoint check still returned the v1 contract, so consult the status document before deployment claims.
- The KPI dashboard supports two build-time read modes: immutable Daily Publication when `NEXT_PUBLIC_TRAFFIC_DASHBOARD_DAILY_PUBLICATION=true`, otherwise live `/annual-kpi`. Both poll a lightweight version endpoint every 60 seconds and retain the last-known-good snapshot on background failure.

## Planning Dashboard

The Desktop Dashboard at `/` and `/dashboard` has two tabs: Planning Overview and Planning Changes. Select a season, then the current Draft (default) or a specific Published version. KPI, Feasible STD and the trial-flight assessment use that same Planning source, not Daily live data. Planning sources are loaded through revision-fenced Draft pages or immutable Published snapshot pages rather than the legacy workspace-window path described above.

Feasible STD counts active departure processing windows `[STD−180m, STD−50m)` with an exact event sweep, including overlapping windows across operational days within the selected source. The default threshold is13; the five-minute grid is display-only. Entering an arbitrary STD evaluates that exact timestamp. This is a read-only capacity simulation, not slot approval or a Publish action.

Draft drill-down opens Detailed for the selected season/day. Published drill-down opens the selected History snapshot with restore disabled. Operational Daily/Check-in/Gate remain separate in the sidebar. Volume reports, comparison and Excel exports are available at `/reports` and retain their runtime/canonical sources.

Before enabling this client on a server, apply `supabase/migrations/20261012140000_seasonal_draft_changes_v1.sql` for the read-only Draft comparison RPC. The implementation and local packaging evidence, including unverified clean-install/upgrade gates, are recorded in `../docs/plans/dashboard_redesign_and_sidecar_removal_plan.md` §10. Desktop packaging no longer builds or bundles the Python AI sidecar; backend AI functions and historical database objects are intentionally retained.

## Development

```bash
npm run dev
npm run test:rules
npm run build
```

## Remote Backend

Operational desktop builds require Supabase configuration:

```bash
NEXT_PUBLIC_REMOTE_BACKEND=supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-or-publishable-key>
```

Do not put `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, or `TELEGRAM_CHAT_ID` in the native app environment. The Telegram values are Supabase Edge Function secrets for `schedule-telegram-notify`.

See `supabase.env.example` for the runtime and operator-only environment keys.

Apply the tracked schema/migrations before enabling a new client. Full-file Seasonal import requires `supabase/migrations/20261016090000_seasonal_full_import_v1.sql` and `NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED=1`: stage/status/preview/cancel use the native `seasonal_draft_import_v1` RPC family, then `commit_seasonal_draft_import_v1` updates Planning only. The migration invalidates uncommitted old contract-4 previews, including selective Replace; select the workbook again instead of committing an old preview. Session-storage recovery receipts are operator-scoped; a committed receipt survives reload and refresh failure, and is cleared only after the authoritative target draft reload succeeds. Draft export uses `get_seasonal_draft_export_snapshot_v1`. Workspace reads remain bounded V2 pages; V1 workspace compatibility is allowed only when the V2 signature is confirmed missing, never after timeout/network failure.

Full-season Daily import additionally requires `supabase/migrations/20261016100000_operational_daily_full_import_v2.sql` before deploying the client. Upload uses `begin_daily_schedule_import_upload_v2`, `append_daily_schedule_import_upload_v2` and `finalize_daily_schedule_import_upload_v2`; commit retains `commit_daily_schedule_import_v2`. Upload sessions expire after two hours; committed receipts remain replayable after expiry. Preview detail lists are capped at 200 entries and report their full counts and truncation explicitly. RPC staging/commit use bulk SQL with a 300-second database deadline; proxy/client deadlines must be checked separately before rollout. No production deployment is implied by local verification.

Run `npm run test:operational-daily-full-import` for isolated PGlite lifecycle, authorization, resource/pairing invariants, atomicity, rollback and 100,000-leg acceptance. Local Chromium smoke uses a separate database, not the production backend.

Local integration/load commands require isolated test credentials and never default to production:

```bash
npm run test:seasonal-full-import
npm run test:seasonal-import-v2-db
npm run test:seasonal-import-v3-db
npm run test:seasonal-import-v3-load
npm run test:workspace-window-v2-db
npm run test:seasonal-import-v2-load
npm run test:workspace-window-v2-load
npm run test:seasonal-roundtrip
```

## Migration

Run the one-time Firestore-to-Supabase migration from a trusted operator machine after applying the schema:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/migrate-firestore-to-supabase.mjs
```

The script reads the current Firebase project from `.env.local` and writes seasons, source rows, flight records, modifications, mod history, operational settings, and audit logs into Supabase.

## Native Windows Build

Tauri uses the static export in `out`:

```bash
npm run native:dev
npm run native:build
```

The Tauri config is in `src-tauri/tauri.conf.json`. Native builds require the Rust/Tauri toolchain to be installed on the machine.

## Rollback Backup

Before the Supabase/Tauri migration, a Firebase rollback backup was created at:

```text
C:\Users\tuan\Documents\SeasonalManagement\_backups\firebase-version-20260516-113223
```

That backup includes a copy of the app code, Firebase config notes, and `firebase-export/firestore-export.json`. The backup app was verified with `npm ci` and `npm run build`.
