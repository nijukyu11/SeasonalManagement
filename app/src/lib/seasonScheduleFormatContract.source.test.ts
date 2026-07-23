import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260723090000_normalize_season_modification_schedule.sql'),
  'utf8',
);
const schema = readFileSync(join(process.cwd(), 'supabase/schema.sql'), 'utf8');

for (const [label, source] of [
  ['migration', migration],
  ['canonical schema', schema],
] as const) {
  test(`${label} canonicalizes compact modification schedules at the database boundary`, () => {
    assert.match(source, /normalize_season_modification_schedule_v1/);
    assert.match(source, /before insert or update of schedule/);
    assert.match(source, /season_modifications_schedule_format_check/);
    assert.match(source, /\^\(\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]\$/);
    assert.match(source, /using errcode = '22007'/);
  });
}
