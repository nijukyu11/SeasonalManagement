# Seasonal Management App

This app is a static Next.js export designed for development in a browser and operational use inside the Tauri Windows desktop shell. Authenticated self-hosted Supabase is the normal durable read/write authority. Zustand keeps operator-scoped server snapshots in memory so route remounts can render immediately; IndexedDB and SQLite are not schedule-read or failure fallbacks.

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

Apply the tracked schema/migrations before enabling a new client. Workspace reads use the shared V2 coordinator and bounded `get_season_schedule_allocation_window_v2` keyset pages. Seasonal Import V3 sends canonical source rows to `stage_seasonal_import_v3`, displays the server preview, and commits the persisted staged set through `commit_seasonal_import_v3`; export uses `get_seasonal_export_snapshot_v2`. V3 never falls back to Import V2, direct-table writes, or SQLite. V1 workspace compatibility is allowed only when the V2 workspace signature is confirmed missing, never after timeout/network failure.

Local integration/load commands require isolated test credentials and never default to production:

```bash
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
