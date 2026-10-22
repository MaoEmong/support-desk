import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

export const hashPassword = (plain: string, rounds: number) => bcrypt.hash(plain, rounds);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/** 사용자 미존재 시에도 같은 시간만큼 bcrypt 비교를 해서 계정 존재 여부를 타이밍으로 흘리지 않는다. */
let dummyHash: string | null = null;
export async function burnPasswordCheck(plain: string, rounds: number) {
  dummyHash ??= await bcrypt.hash('dummy-password-for-timing', rounds);
  await bcrypt.compare(plain, dummyHash);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
