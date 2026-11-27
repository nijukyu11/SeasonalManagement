import { readFile, readdir } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

// Shared bootstrap for the Seasonal/Operational separation suites (M0+).
//
// The PGlite chain starts at the first migration that is not embedded in
// schema.sql, matching the other suites in this directory.
//
// One migration is skipped: 20260829190000_public_traffic_canonical_cutover.sql
// reads canonical.flight_number from reporting.canonical_effective_flight_legs.
// Production satisfies that because its reporting.effective_flight_operations
// was hand-patched to an overlay-merge definition that exposes flight_number
// (pg_get_viewdef md5 7906c3cc65a25914fa1343c7c5ff7ad9), while schema.sql
// carries a different shape that exposes flight. The repo chain therefore
// keeps the pre-cutover reporting.public_traffic_candidates shape; the report
// function digests below still assert that every function this suite consumes
// matches production byte-for-byte.
const FIRST_CHAIN_MIGRATION = '20260828083000';

export const SKIPPED_CHAIN_MIGRATIONS = new Map([
  [
    '20260829190000_public_traffic_canonical_cutover.sql',
    'requires canonical.flight_number from the production-patched effective view; schema.sql baseline exposes flight',
  ],
]);

// Byte-exact production digests, recorded for chain-parity assertions.
export const PRODUCTION_REPORT_V2_DIGEST = 'cc32feac705426cdd309359e447e4bb0';
export const PRODUCTION_REPORTING_VIEWS = {
  effective_flight_operations: '7906c3cc65a25914fa1343c7c5ff7ad9',
  canonical_effective_flight_legs: 'd6748b16961c8a3c1c3ea825526de46c',
  public_traffic_candidates: '30f1c9b2664ac9d9bd03a3d274bdc0b3',
};

export async function listChainMigrations() {
  const migrationsUrl = new URL('../migrations/', import.meta.url);
  return (await readdir(migrationsUrl))
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.rollback.sql'))
    .sort()
    .filter((name) => name.slice(0, 14) >= FIRST_CHAIN_MIGRATION);
}

// psql meta-commands (\echo ...) are valid for the production apply path but
// not for PGlite's parser; strip only meta-command lines, never SQL content.
export function stripPsqlMetaCommands(sql) {
  return sql.replace(/^\s*\\[a-z]+.*$/gm, '');
}

// Historical milestone suites assert rollback contracts as they stood when that
// milestone shipped. Unwind every later chain migration newest-first through its
// shipped rollback file; a migration without one fails here instead of silently
// leaving later definitions in place.
export async function rollbackChainMigrationsAfter(db, lastKeptMigration) {
  const migrationsUrl = new URL('../migrations/', import.meta.url);
  const later = (await listChainMigrations()).filter((name) => name > lastKeptMigration).reverse();
  for (const name of later) {
    if (SKIPPED_CHAIN_MIGRATIONS.has(name)) continue;
    const rollbackUrl = new URL(name.replace(/\.sql$/, '.rollback.sql'), migrationsUrl);
    await db.exec(stripPsqlMetaCommands(await readFile(rollbackUrl, 'utf8')));
  }
}

// A supplied DB implements exec/query/close, allowing the same chain to prove
// behavior against real PostgreSQL as well as the default isolated PGlite.
export async function createSeasonalOperationalSeparationDb(db = null) {
  db ??= await createSupabasePGlite();
  const migrationsUrl = new URL('../migrations/', import.meta.url);
  const applied = [];
  await db.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  for (const name of await listChainMigrations()) {
    if (SKIPPED_CHAIN_MIGRATIONS.has(name)) continue;
    const sql = stripPsqlMetaCommands(await readFile(new URL(name, migrationsUrl), 'utf8'));
    await db.exec(sql);
    applied.push(name);
  }
  return { db, applied };
}

export async function reportingViewDigest(db, viewName) {
  const row = (
    await db.query(
      `select md5(pg_get_viewdef($1::regclass, true)) as digest,
              length(pg_get_viewdef($1::regclass, true)) as length`,
      [viewName]
    )
  ).rows[0];
  return { digest: row.digest, length: Number(row.length) };
}
