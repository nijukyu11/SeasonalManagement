const DISPOSABLE_DATABASE_PATTERN = /^seasonal_task11_[a-z0-9_]+$/;
const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const RESERVED_DATABASE_NAMES = new Set([
  'postgres',
  'supabase',
  'supabase_local',
  'supabase_dev',
  'template0',
  'template1',
  'local',
  'local_dev',
]);

export function parseDisposableDatabaseConfig(
  env,
  { requireLocalhost = true } = {},
) {
  const connectionString = env.SEASONAL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('SEASONAL_TEST_DATABASE_URL is required');
  if (env.SEASONAL_TEST_TEMP_DB !== '1') {
    throw new Error('Refusing to run without SEASONAL_TEST_TEMP_DB=1');
  }

  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`Refusing unsupported database protocol ${url.protocol}`);
  }
  if (requireLocalhost && !LOCAL_DATABASE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Task 11 database tests only run through a localhost PostgreSQL endpoint');
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (
    RESERVED_DATABASE_NAMES.has(databaseName.toLowerCase())
    || !DISPOSABLE_DATABASE_PATTERN.test(databaseName)
  ) {
    throw new Error(`Refusing non-Task11 database name ${databaseName || '<empty>'}`);
  }

  return { connectionString, databaseName, url };
}

export async function verifyConnectedDatabaseIdentity(client, expectedDatabaseName) {
  const result = await client.query('select current_database() as database_name');
  if (result.rows?.length !== 1) {
    throw new Error(
      `Database identity query returned ${result.rows?.length ?? 0} rows; expected exactly one`,
    );
  }
  const actualDatabaseName = result.rows[0]?.database_name;
  if (typeof actualDatabaseName !== 'string' || actualDatabaseName.length === 0) {
    throw new Error('Database identity query returned an empty database name');
  }
  if (actualDatabaseName !== expectedDatabaseName) {
    throw new Error(
      `Connected database identity mismatch: expected ${expectedDatabaseName}, got ${actualDatabaseName}`,
    );
  }
  return actualDatabaseName;
}

export async function verifyDatabaseIdentityOrClose(client, expectedDatabaseName) {
  try {
    return await verifyConnectedDatabaseIdentity(client, expectedDatabaseName);
  } catch (identityError) {
    try {
      await client.end();
    } catch (closeError) {
      const aggregate = new AggregateError(
        [identityError, closeError],
        'Database identity verification and client close both failed',
      );
      aggregate.databaseClientClosed = false;
      throw aggregate;
    }
    identityError.databaseClientClosed = true;
    throw identityError;
  }
}
