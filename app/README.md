# Seasonal Management App

This app is a static Next.js export designed to run either in a browser during development or inside the Tauri Windows desktop shell. The working schedule state remains local-first in IndexedDB; the remote backend is selected through `src/lib/remoteStore.ts`.

## Development

```bash
npm run dev
npm run test:rules
npm run build
```

## Remote Backend

The app defaults to Firebase/Firestore when Supabase is not configured, which keeps the current Firebase project usable during migration. To use Managed Supabase, set:

```bash
NEXT_PUBLIC_REMOTE_BACKEND=supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-or-publishable-key>
```

Do not put `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, or `TELEGRAM_CHAT_ID` in the native app environment. The Telegram values are Supabase Edge Function secrets for `schedule-telegram-notify`.

See `supabase.env.example` for the runtime and operator-only environment keys.

Apply the database schema in `supabase/schema.sql` before enabling Supabase in the app. The schema creates the app tables, indexes, authenticated RLS policies, and `sync_season_workspace` RPC used for atomic sync/version checks.

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
