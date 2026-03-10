import crypto from 'crypto';

export function md5Hex(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}
