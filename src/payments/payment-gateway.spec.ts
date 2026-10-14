import crypto from 'node:crypto';
import { verifyPaystackSignature } from './payment-gateway';

const secret = 'sk_test_secret';
const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ORD-1', amount: 250000 } });
const sign = (b: string, s = secret) => crypto.createHmac('sha512', s).update(b).digest('hex');

describe('verifyPaystackSignature', () => {
  it('accepts a correctly signed body', () => expect(verifyPaystackSignature(Buffer.from(body), sign(body), secret)).toBe(true));
  it('rejects a body changed after signing', () => expect(verifyPaystackSignature(Buffer.from(body.replace('250000', '1')), sign(body), secret)).toBe(false));
  it('rejects a signature made with another key', () => expect(verifyPaystackSignature(Buffer.from(body), sign(body, 'other'), secret)).toBe(false));
  it('rejects missing or malformed signatures without throwing', () => {
    expect(verifyPaystackSignature(Buffer.from(body), undefined, secret)).toBe(false);
    expect(verifyPaystackSignature(Buffer.from(body), 'abc', secret)).toBe(false);
  });
});
