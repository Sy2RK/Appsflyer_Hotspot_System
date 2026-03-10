import crypto from 'crypto';

const bytesArg = process.argv[2];
const bytes = bytesArg ? Number(bytesArg) : 48;

if (!Number.isFinite(bytes) || bytes <= 0) {
  throw new Error(`Invalid bytes: ${bytesArg ?? ''}`);
}

console.log(crypto.randomBytes(bytes).toString('base64url'));
