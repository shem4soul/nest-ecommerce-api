import crypto from 'node:crypto';

/** What the rest of the app needs from a payment provider. Tests swap in a fake. */
export interface PaymentGateway {
  initialize(input: { email: string; amountKobo: number; reference: string; callbackUrl?: string }): Promise<{ authorizationUrl: string }>;
  verify(reference: string): Promise<{ status: 'success' | 'failed' | 'pending'; amountKobo: number; currency: string }>;
}
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/**
 * Paystack signs the raw request body with HMAC-SHA512 using your secret key and sends the hex
 * digest in the x-paystack-signature header.
 */
export function verifyPaystackSignature(rawBody: Buffer | string, signature: string | undefined, secretKey: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
