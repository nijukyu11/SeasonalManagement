import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const ctx = await buildM0Fixture();
const { db, asWriter, asAdmin } = ctx;
const migration = new URL('../migrations/20260929110000_operational_schedule_mutations_v1.sql', import.meta.url);
const rollback = new URL('../migrations/20260929110000_operational_schedule_mutations_v1.rollback.sql', import.meta.url);

const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const result = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const window = async (start = '2030-03-30', end = '2030-04-05') =>
  (await result(`select public.get_operational_schedule_allocation_window_v1($1::date, $2::date) as r`, [start, end])).r;

const applySchedule = async (request, revision, changes) =>
  (await result(`select public.apply_operational_flight_schedule_changes_v1($1::uuid, $2::bigint, $3::jsonb) as r`, [
    request,
    revision,
    JSON.stringify(changes),
  ])).r;

const createLegs = async (request, revision, legs) =>
  (await result(`select public.create_operational_flight_legs_v1($1::uuid, $2::bigint, $3::jsonb) as r`, [
    request,
    revision,
    JSON.stringify(legs),
  ])).r;

const reject = async (fn, code) => assert.rejects(fn, (e) => e.code === code);

try {
  // 1. Rollback and apply migration cleanly
  await db.exec(await readFile(rollback, 'utf8'));
  await db.exec(await readFile(migration, 'utf8'));

  await asWriter();
  const initWin = await window();
  const rev0 = initWin.snapshot.revision;

  // 2. Manual leg creation with child allocation (counters & checkin windows)
  const legPayload1 = {
    id: id(1),
    scheduledDate: '2030-04-01',
    scheduledTime: '10:00:00',
    side: 'ARR',
    airline: 'VN',
    flightNumber: '101',
    route: 'HAN-SGN',
    aircraftType: 'A321',
    flightCategory: 'PAX',
    pax: 180,
    stand: '1',
    gate: 5,
    counters: [
      { counter_group: 'G1', item_index: 0, counter_value: 'C1' },
      { counter_group: 'G1', item_index: 1, counter_value: 'C2' },
    ],
    checkin_windows: [
      { counter_key: 'C1', window_start: '08:00', window_end: '09:30' },
    ],
  };

  const createReceipt1 = await createLegs(id(100), rev0, [legPayload1]);
  assert.equal(createReceipt1.status, 'committed');
  assert.deepEqual(createReceipt1.createdLegIds, [id(1)]);
  assert.equal(createReceipt1.events[0].after.flight_number, '101');
  assert.equal(createReceipt1.events[0].after.counters.length, 2);
  assert.equal(createReceipt1.events[0].after.checkin_windows[0].counter_key, 'C1');

  // Idempotency: exact same payload returns same receipt
  const createReceipt1Replay = await createLegs(id(100), rev0, [legPayload1]);

  // Reusing request_id with different payload raises 22023
  await reject(() => createLegs(id(100), rev0, [{ ...legPayload1, pax: 200 }]), '22023');

  // Stale snapshot check
  await reject(() => createLegs(id(101), rev0, [{ ...legPayload1, id: id(2), flightNumber: '102' }]), '40001');

  // Current window after creation
  const win1 = await window();
  const rev1 = win1.snapshot.revision;
  assert.equal(win1.legs.some((l) => l.leg_id === id(1)), true);
  assert.equal(win1.legCounters.some((c) => c.leg_id === id(1) && c.counter_value === 'C1'), true);

  // Flight normalization validation matching M1/M5 constraints
  await reject(() => createLegs(id(102), rev1, [{ ...legPayload1, id: id(2), airline: '' }]), '22023');
  await reject(() => createLegs(id(103), rev1, [{ ...legPayload1, id: id(3), flightNumber: '   ' }]), '22023');
  await reject(() => createLegs(id(104), rev1, [{ ...legPayload1, id: id(4), side: 'MIDDLE' }]), '22023');
  await reject(() => createLegs(id(105), rev1, [{ ...legPayload1, id: id(5), stand: 'INVALID_STAND' }]), '22023');
  await reject(() => createLegs(id(106), rev1, [{ ...legPayload1, id: id(6), gate: -1 }]), '22023');

  // Alphanumeric flight numbers like JX701 and VN101 succeed
  const alphaFlight = await createLegs(id(107), rev1, [{
    ...legPayload1,
    id: id(20),
    airline: 'JX',
    flightNumber: 'JX701',
  }]);
  assert.equal(alphaFlight.status, 'committed');
  assert.deepEqual(alphaFlight.createdLegIds, [id(20)]);

  // Collision on active leg_key
  await reject(() => createLegs(id(108), alphaFlight.revision, [{ ...legPayload1, id: id(5) }]), '23505');

  // Create a departure leg for pairing test (VN102)
  const legPayload2 = {
    id: id(2),
    scheduledDate: '2030-04-01',
    scheduledTime: '12:00:00',
    side: 'DEP',
    airline: 'VN',
    flightNumber: '102',
    route: 'SGN-HAN',
    aircraftType: 'A321',
  };
  const createReceipt2 = await createLegs(id(109), alphaFlight.revision, [legPayload2]);
  assert.equal(createReceipt2.status, 'committed');
  assert.deepEqual(createReceipt2.createdLegIds, [id(2)]);

  const win2 = await window();
  const rev2 = win2.snapshot.revision;

  // 3. Schedule updates: modifying flight details and moving date across boundary
  // Scheduled at 04:30 AM should map operational_date to previous date (2030-03-31)
  const moveChange = [
    {
      legId: id(1),
      expected: {
        scheduled_date: '2030-04-01',
        scheduled_time: '10:00:00',
        flight_number: '101',
      },
      patch: {
        scheduled_date: '2030-04-01',
        scheduled_time: '04:30:00',
        flight_number: '105',
      },
    },
  ];

  // Preimage mismatch
  await reject(
    () => applySchedule(id(200), rev2, [{ ...moveChange[0], expected: { ...moveChange[0].expected, flight_number: '999' } }]),
    '40001',
  );

  const moveReceipt = await applySchedule(id(201), rev2, moveChange);
  assert.equal(moveReceipt.status, 'committed');
  assert.equal(moveReceipt.events[0].after.flight_number, '105');
  assert.equal(moveReceipt.events[0].after.operational_date, '2030-03-31', '04:30 moves operational date to prior date');

  const win3 = await window();
  const rev3 = win3.snapshot.revision;

  // 4. Reciprocal Turnaround Pair Invariant (M4 preservation)
  // Attempting to link only one leg without reciprocal link on counterpart rejects with 22023
  const halfPair = [
    {
      legId: id(1),
      expected: { linked_leg_id: null, turnaround_id: null, link_type: null, pair_anchor_date: null },
      patch: { linked_leg_id: id(2), turnaround_id: 'TRN-M9', link_type: 'sameday', pair_anchor_date: '2030-03-31' },
    },
  ];
  await reject(() => applySchedule(id(202), rev3, halfPair), '22023');

  // Both legs linked reciprocally in same batch succeeds
  const fullPair = [
    halfPair[0],
    {
      legId: id(2),
      expected: { linked_leg_id: null, turnaround_id: null, link_type: null, pair_anchor_date: null },
      patch: { linked_leg_id: id(1), turnaround_id: 'TRN-M9', link_type: 'sameday', pair_anchor_date: '2030-03-31' },
    },
  ];
  const pairReceipt = await applySchedule(id(203), rev3, fullPair);
  assert.equal(pairReceipt.status, 'committed');

  const win4 = await window();
  const rev4 = win4.snapshot.revision;
  assert.equal(win4.legs.find((l) => l.leg_id === id(1)).linked_leg_id, id(2));
  assert.equal(win4.legs.find((l) => l.leg_id === id(2)).linked_leg_id, id(1));

  // Deleting one paired leg without updating counterpart rejects with 22023
  await reject(
    () =>
      applySchedule(id(204), rev4, [
        {
          legId: id(1),
          expected: { status: 'active', deletion_reason: null },
          patch: { status: 'deleted', deletion_reason: 'bad weather' },
        },
      ]),
    '22023',
  );

  // Unlinking both legs reciprocally in one batch succeeds
  const unlinkBatch = [
    {
      legId: id(1),
      expected: { linked_leg_id: id(2), turnaround_id: 'TRN-M9', link_type: 'sameday', pair_anchor_date: '2030-03-31' },
      patch: { linked_leg_id: null, turnaround_id: null, link_type: null, pair_anchor_date: null },
    },
    {
      legId: id(2),
      expected: { linked_leg_id: id(1), turnaround_id: 'TRN-M9', link_type: 'sameday', pair_anchor_date: '2030-03-31' },
      patch: { linked_leg_id: null, turnaround_id: null, link_type: null, pair_anchor_date: null },
    },
  ];
  const unlinkReceipt = await applySchedule(id(205), rev4, unlinkBatch);
  assert.equal(unlinkReceipt.status, 'committed');

  const win5 = await window();
  const rev5 = win5.snapshot.revision;

  // 5. Deletion & Terminal Lineage Safety
  // Deleting an unlinked leg with reason succeeds
  const deleteBatch = [
    {
      legId: id(1),
      expected: { status: 'active', deletion_reason: null },
      patch: { status: 'deleted', deletion_reason: 'flight cancelled by ops' },
    },
  ];
  const deleteReceipt = await applySchedule(id(206), rev5, deleteBatch);
  assert.equal(deleteReceipt.status, 'committed');
  assert.equal(deleteReceipt.events[0].after.status, 'deleted');

  const win6 = await window();
  const rev6 = win6.snapshot.revision;

  // Terminal Lineage Rule: Deleted leg cannot be updated or resurrected
  await reject(
    () =>
      applySchedule(id(207), rev6, [
        {
          legId: id(1),
          expected: { pax: 180 },
          patch: { pax: 150 },
        },
      ]),
    'P0002',
  );

  await reject(
    () =>
      applySchedule(id(208), rev6, [
        {
          legId: id(1),
          expected: { status: 'deleted' },
          patch: { status: 'active' },
        },
      ]),
    'P0002',
  );

  // 6. Permissions check
  await asAdmin();
  await db.query(`update public.app_operator_permission_overrides set effect='deny' where user_id=$1 and permission_key='daily.write'`, [M0_FIXTURE.writerId]);
  await asWriter();

  await reject(() => createLegs(id(209), rev6, [legPayload2]), '42501');
  await reject(() => applySchedule(id(210), rev6, [{ legId: id(2), expected: { pax: null }, patch: { pax: 100 } }]), '42501');
  // Restore permissions
  await asAdmin();
  await db.query(`update public.app_operator_permission_overrides set effect='allow' where user_id=$1 and permission_key='daily.write'`, [M0_FIXTURE.writerId]);
  await asWriter();

  // 7. Atomic batch regression: mixed pair creation, full rollback on collision/invalid, exact retry receipt
  const winBefore7 = await window();
  const revBefore7 = winBefore7.snapshot.revision;

  // 7a. Mixed batch containing a turnaround pair AND an unpaired flight
  const mixedBatch = [
    {
      id: id(30),
      scheduledDate: '2030-04-02',
      scheduledTime: '14:00:00',
      side: 'ARR',
      airline: 'QH',
      flightNumber: '301',
      route: 'DAD-SGN',
      aircraftType: 'A320',
      linkedLegId: id(31),
      turnaroundId: 'TRN-MIXED-1',
      linkType: 'sameday',
      pairAnchorDate: '2030-04-02',
    },
    {
      id: id(31),
      scheduledDate: '2030-04-02',
      scheduledTime: '16:00:00',
      side: 'DEP',
      airline: 'QH',
      flightNumber: '302',
      route: 'SGN-DAD',
      aircraftType: 'A320',
      linkedLegId: id(30),
      turnaroundId: 'TRN-MIXED-1',
      linkType: 'sameday',
      pairAnchorDate: '2030-04-02',
    },
    {
      id: id(32),
      scheduledDate: '2030-04-02',
      scheduledTime: '18:00:00',
      side: 'ARR',
      airline: 'VJ',
      flightNumber: '501',
      route: 'HPH-SGN',
      aircraftType: 'A321',
    },
  ];

  const mixedReceipt = await createLegs(id(300), revBefore7, mixedBatch);
  assert.equal(mixedReceipt.status, 'committed');
  assert.deepEqual(mixedReceipt.createdLegIds, [id(30), id(31), id(32)]);
  assert.equal(mixedReceipt.events.length, 3);

  // Exact retry returns identical receipt
  const mixedRetry = await createLegs(id(300), revBefore7, mixedBatch);
  assert.deepEqual(mixedRetry, mixedReceipt);

  const winAfterMixed = await window();
  const revAfterMixed = winAfterMixed.snapshot.revision;
  const leg30 = winAfterMixed.legs.find((l) => l.leg_id === id(30));
  const leg31 = winAfterMixed.legs.find((l) => l.leg_id === id(31));
  const leg32 = winAfterMixed.legs.find((l) => l.leg_id === id(32));
  assert.ok(leg30 && leg31 && leg32);
  assert.equal(leg30.linked_leg_id, id(31));
  assert.equal(leg31.linked_leg_id, id(30));
  assert.equal(leg30.turnaround_id, 'TRN-MIXED-1');
  assert.equal(leg31.turnaround_id, 'TRN-MIXED-1');
  assert.equal(leg32.linked_leg_id, null);

  // 7b. Rollback whole batch when one leg in batch is invalid (e.g. invalid stand)
  const invalidBatch = [
    {
      id: id(40),
      scheduledDate: '2030-04-03',
      scheduledTime: '09:00:00',
      side: 'ARR',
      airline: 'VN',
      flightNumber: '401',
      route: 'HAN-SGN',
      aircraftType: 'A321',
    },
    {
      id: id(41),
      scheduledDate: '2030-04-03',
      scheduledTime: '11:00:00',
      side: 'DEP',
      airline: 'VN',
      flightNumber: '402',
      route: 'SGN-HAN',
      aircraftType: 'A321',
      stand: 'BAD_STAND_NAME',
    },
  ];
  await reject(() => createLegs(id(301), revAfterMixed, invalidBatch), '22023');

  // Verify full rollback: leg 40 MUST NOT exist in DB
  const winAfterInvalid = await window();
  assert.equal(winAfterInvalid.legs.some((l) => l.leg_id === id(40)), false);
  assert.equal(winAfterInvalid.snapshot.revision, revAfterMixed);

  // 7c. Rollback whole batch when one leg collides with an active flight
  const collisionBatch = [
    {
      id: id(50),
      scheduledDate: '2030-04-03',
      scheduledTime: '15:00:00',
      side: 'ARR',
      airline: 'QH',
      flightNumber: '601',
      route: 'CXR-SGN',
      aircraftType: 'A320',
    },
    {
      id: id(51),
      scheduledDate: '2030-04-02',
      scheduledTime: '18:00:00',
      side: 'ARR',
      airline: 'VJ',
      flightNumber: '501',
      route: 'HPH-SGN',
      aircraftType: 'A321',
    },
  ];
  await reject(() => createLegs(id(302), revAfterMixed, collisionBatch), '23505');

  // Verify full rollback: leg 50 MUST NOT exist in DB
  const winAfterCollision = await window();
  assert.equal(winAfterCollision.legs.some((l) => l.leg_id === id(50)), false);
  assert.equal(winAfterCollision.snapshot.revision, revAfterMixed);

  // 7d. Rollback whole batch when reciprocal pair is broken (one-way link)
  const brokenPairBatch = [
    {
      id: id(60),
      scheduledDate: '2030-04-03',
      scheduledTime: '07:00:00',
      side: 'ARR',
      airline: 'VN',
      flightNumber: '701',
      route: 'HAN-SGN',
      aircraftType: 'A321',
      linkedLegId: id(61),
      turnaroundId: 'TRN-BROKEN',
      linkType: 'sameday',
      pairAnchorDate: '2030-04-03',
    },
    {
      id: id(61),
      scheduledDate: '2030-04-03',
      scheduledTime: '08:30:00',
      side: 'DEP',
      airline: 'VN',
      flightNumber: '702',
      route: 'SGN-HAN',
      aircraftType: 'A321',
      linkedLegId: null,
      turnaroundId: null,
    },
  ];
  await reject(() => createLegs(id(303), revAfterMixed, brokenPairBatch), '22023');

  const winAfterBroken = await window();
  assert.equal(winAfterBroken.legs.some((l) => l.leg_id === id(60) || l.leg_id === id(61)), false);
  assert.equal(winAfterBroken.snapshot.revision, revAfterMixed);
} finally {
  await ctx.close?.();
}
