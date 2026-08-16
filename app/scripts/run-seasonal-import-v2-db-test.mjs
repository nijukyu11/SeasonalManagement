import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.SEASONAL_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.error('SEASONAL_TEST_DATABASE_URL is required. Use an isolated disposable database.');
  process.exit(2);
}

const files = [
  new URL('../supabase/migrations/20260718090000_seasonal_source_import_v2.sql', import.meta.url),
  new URL('../supabase/migrations/20260720193000_fix_seasonal_flight_number_normalization_v2.sql', import.meta.url),
  new URL('../supabase/migrations/20260720213000_optimize_seasonal_rls_permission_initplans.sql', import.meta.url),
  new URL('../supabase/tests/seasonal_source_import_v2.sql', import.meta.url),
];
const executable = process.platform === 'win32' ? 'psql.exe' : 'psql';

for (const file of files) {
  const result = spawnSync(executable, [databaseUrl, '--set', 'ON_ERROR_STOP=1', '--file', fileURLToPath(file)], {
    stdio: 'inherit',
    env: { ...process.env, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? '10' },
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(result.error.code === 'ENOENT' ? 127 : 1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
