import { pbkdf2Sync, randomBytes } from 'node:crypto';

const pin = process.env.ANNUAL_KPI_PIN ?? '';
if (pin.length < 4 || pin.length > 128) {
  throw new Error('Set ANNUAL_KPI_PIN to a value between 4 and 128 characters.');
}

const iterations = 310_000;
const salt = randomBytes(24);
const digest = pbkdf2Sync(pin, salt, iterations, 32, 'sha256');
const encode = (value) => value.toString('base64url');

process.stdout.write(`pbkdf2_sha256$${iterations}$${encode(salt)}$${encode(digest)}\n`);
