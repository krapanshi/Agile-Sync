import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
export const digestToken = token => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, parameters);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, salt, hex] = (encoded || '').split('$');
  const valid = algorithm === 'scrypt' && /^[a-f0-9]{32}$/.test(salt || '') && /^[a-f0-9]{128}$/.test(hex || '');
  // Run the same expensive operation for unknown users and malformed hashes.
  const actual = await scrypt(password, valid ? salt : '0'.repeat(32), 64, parameters);
  return valid && timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}

export function cookieToken(req) {
  const match = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('agile_session='));
  const token = match?.slice('agile_session='.length);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}

export function cookieOptions(production) {
  return { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
}

export const permissions = {
  owner: ['workspace:read', 'members:manage', 'boards:write', 'tasks:write'],
  admin: ['workspace:read', 'members:manage', 'boards:write', 'tasks:write'],
  member: ['workspace:read', 'boards:write', 'tasks:write'],
  viewer: ['workspace:read']
};

export const can = (role, permission) => Object.hasOwn(permissions, role) && permissions[role].includes(permission);
