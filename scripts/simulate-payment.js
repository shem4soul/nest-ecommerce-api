#!/usr/bin/env node
/**
 * Pretends to be Paystack: sends a correctly signed "charge.success" webhook to your local API,
 * so you can test the whole checkout flow without exposing localhost or making a real payment.
 *
 *   npm run simulate:payment -- <payment-reference> <amount-in-kobo>
 *
 * Take the reference and total from the checkout response (payment.reference, order.totalKobo).
 */
require('dotenv/config');
const crypto = require('node:crypto');

const [reference, amount] = process.argv.slice(2);
if (!reference || !amount) {
  console.error('Usage: npm run simulate:payment -- <payment-reference> <amount-in-kobo>');
  process.exit(1);
}
const secret = process.env.PAYSTACK_SECRET_KEY;
if (!secret) {
  console.error('PAYSTACK_SECRET_KEY is not set (it must match the one your API uses).');
  process.exit(1);
}

const url = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
const body = JSON.stringify({ event: 'charge.success', data: { reference, amount: Number(amount), currency: 'NGN', status: 'success' } });
const signature = crypto.createHmac('sha512', secret).update(body).digest('hex');

fetch(`${url}/payments/webhooks/paystack`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
  body,
})
  .then(async (res) => console.log(res.status, await res.text()))
  .catch((err) => {
    console.error('Could not reach the API:', err.message);
    process.exit(1);
  });
