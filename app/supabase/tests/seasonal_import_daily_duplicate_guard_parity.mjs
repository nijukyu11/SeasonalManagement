import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const chain = [
  '../schema.sql',
  '../migrations/20260828083000_allow_alphanumeric_stand_values.sql',
  '../migrations/20260828090000_daily_schedule_import_v1.sql',
  '../migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql',
  '../migrations/20260829150000_canonical_flight_leg_store.sql',
  '../migrations/20260829153000_daily_schedule_canonical_commit.sql',
  '../migrations/20260829160000_canonical_manual_modifications.sql',
  '../migrations/20260829163000_canonical_effective_read.sql',
  '../migrations/20260829170000_seasonal_canonical_authority.sql',
  '../migrations/20260831103000_daily_overlay_lineage_match.sql',
  '../migrations/20260831124500_daily_overlay_authority_scope_match.sql',
  '../migrations/20260902140000_daily_import_conflict_http_status.sql',
  '../migrations/20260904183000_daily_import_stage_indexed_ops_date.sql',
  '../migrations/20260906010000_import_terminal_coverage_and_identity.sql',
  '../migrations/20260906011000_active_seasonal_export_snapshot.sql',
  '../migrations/20260914090000_daily_loose_identity_live_row_precedence.sql',
  '../migrations/20260915100000_canonical_overlay_deletion_authority.sql',
];
const guardUrl = new URL(
  '../migrations/20260920170000_seasonal_import_daily_duplicate_guard.sql',
  import.meta.url,
);

const db = await createSupabasePGlite();
const digest = async () => {
  const result = await db.query(
    `select pg_get_functiondef('public.stage_seasonal_import_v3(jsonb)'::regprocedure) as definition`,
  );
  const definition = result.rows[0].definition;
  return {
    md5: createHash('md5').update(definition, 'utf8').digest('hex'),
    length: definition.length,
  };
};

try {
  for (const file of chain) {
    await db.exec(await readFile(new URL(file, import.meta.url), 'utf8'));
  }
  const pre = await digest();
  const guardSql = await readFile(guardUrl, 'utf8');
  await db.exec(guardSql);
  const post = await digest();
  await db.exec(guardSql);
  const postSecond = await digest();
  const rollbackSql = await readFile(
    new URL('../../../tmp/audit/seasonal-guard/bundle/rollback.sql', import.meta.url),
    'utf8',
  );
  await db.exec(`reset role`);
  await db.exec(rollbackSql);
  const rolledBack = await digest();
  await db.exec(guardSql);
  const reapplied = await digest();
  console.log(
    JSON.stringify({
      pre,
      post,
      postSecond,
      idempotent: post.md5 === postSecond.md5,
      rollbackRestoresPreimage: rolledBack.md5 === pre.md5,
      rolledBack,
      reapplied,
      reapplyMatchesPost: reapplied.md5 === post.md5,
      expectedProductionPre: '6cad4bcc172bc6d267bda4c13d5a0d07',
      preMatchesProduction: pre.md5 === '6cad4bcc172bc6d267bda4c13d5a0d07',
    }),
  );
} finally {
  await db.close();
}
