import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const schemaSql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const db = await createSupabasePGlite();

async function assertStagingForeignKey(label) {
  const constraints = await db.query(`
    select constraint_name
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'season_import_batches'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'season_import_batches_season_id_fkey'
  `);
  assert.equal(constraints.rows.length, 1, `${label}: staging season FK is missing`);

  await assert.rejects(
    db.query(
      `insert into public.season_import_batches (
         request_id, season_id, season_code, checksum, status, created_by
       ) values ($1, 'missing-season', 'TST', 'orphan-check', 'staged', $2)`,
      [randomUUID(), randomUUID()]
    ),
    (error) => error?.code === '23503',
    `${label}: orphan seasonal import batch was accepted`
  );
}

async function runSchema(label) {
  await db.exec(schemaSql);
  await assertStagingForeignKey(label);
}

try {
  await runSchema('first');
  await db.query(
    `insert into public.seasons (
       id, season_code, name, file_name, uploaded_at,
       effective_start, effective_end, total_legs, total_source_rows, data_version
     ) values ('schema-twice-season', 'TST', 'Schema Twice', '', 0, '', '', 0, 0, 0)`
  );
  await db.query(
    `insert into public.season_import_batches (
       request_id, season_id, season_code, checksum, status, created_by
     ) values ($1, 'schema-twice-season', 'TST', 'before-second-run', 'staged', $2)`,
    [randomUUID(), randomUUID()]
  );

  await runSchema('second');
  const persisted = await db.query(
    `select count(*)::integer as count
     from public.season_import_batches
     where season_id = 'schema-twice-season'`
  );
  assert.equal(persisted.rows[0].count, 0, 'second schema run retained a stale staging batch');
  console.log(JSON.stringify({ suite: 'schema-twice', runs: 2, status: 'passed' }));
} finally {
  await db.close();
}
