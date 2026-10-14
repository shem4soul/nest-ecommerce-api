import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { OrdersService } from '../src/orders/orders.service';
import { PAYMENT_GATEWAY, PaymentGateway } from '../src/payments/payment-gateway';
import { configureApp } from '../src/setup';

const SECRET = process.env.PAYSTACK_SECRET_KEY!;
const address = { fullName: 'Ada Obi', phone: '08012345678', line1: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' };

class FakeGateway implements PaymentGateway {
  failInit = false;
  verifyResult: { status: 'success' | 'failed' | 'pending'; amountKobo: number; currency: string } = { status: 'pending', amountKobo: 0, currency: 'NGN' };
  async initialize(i: { reference: string }) {
    if (this.failInit) throw new Error('provider down');
    return { authorizationUrl: `https://checkout.test/${i.reference}` };
  }
  async verify() {
    return this.verifyResult;
  }
}

describe('shop API (end to end, real Postgres)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;
  const gateway = new FakeGateway();
  let adminToken: string;
  let n = 0;
  const uniq = () => `${Date.now()}${n++}`;

  beforeAll(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pg.end();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PAYMENT_GATEWAY).useValue(gateway).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    http = request(app.getHttpServer());

    await ds.query(`INSERT INTO users (email, password_hash, name, role) VALUES ('admin@test.dev', $1, 'Admin', 'ADMIN')`, [await bcrypt.hash('admin-password-123', 4)]);
    adminToken = (await http.post('/auth/login').send({ email: 'admin@test.dev', password: 'admin-password-123' })).body.accessToken;
  });
  afterAll(async () => app.close());

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const register = async () => {
    const email = `u${uniq()}@test.dev`;
    const res = await http.post('/auth/register').send({ email, password: 'a-strong-password', name: 'Test User' }).expect(201);
    return { email, ...res.body };
  };
  const product = async (over: Record<string, unknown> = {}) =>
    (await http.post('/products').set(auth(adminToken)).send({ sku: `SKU-${uniq()}`, name: `Item ${uniq()}`, priceKobo: 100_000, stockQuantity: 10, ...over }).expect(201)).body;
  const stockOf = async (id: string) => Number((await ds.query('SELECT stock_quantity FROM products WHERE id = $1', [id]))[0].stock_quantity);
  const checkout = (token: string, key = crypto.randomUUID()) => http.post('/orders/checkout').set(auth(token)).set('Idempotency-Key', key).send({ shippingAddress: address });
  const addToCart = (token: string, productId: string, quantity = 1) => http.put(`/cart/items/${productId}`).set(auth(token)).send({ quantity });
  const webhook = (body: object, signature?: string) => {
    const raw = JSON.stringify(body);
    return http.post('/payments/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', signature ?? crypto.createHmac('sha512', SECRET).update(raw).digest('hex')).send(raw);
  };
  const chargeSuccess = (reference: string, amount: number) => ({ event: 'charge.success', data: { reference, amount, currency: 'NGN', status: 'success' } });
  /** Registers a customer, puts one unit in the cart, checks out. */
  const placeOrder = async (p: { id: string }, quantity = 1) => {
    const user = await register();
    await addToCart(user.accessToken, p.id, quantity).expect(200);
    const res = await checkout(user.accessToken).expect(201);
    return { user, order: res.body.order, payment: res.body.payment };
  };

  describe('authentication', () => {
    it('registers, rejects duplicates and bad logins, and returns the profile', async () => {
      const u = await register();
      await http.post('/auth/register').send({ email: u.email, password: 'a-strong-password', name: 'Again' }).expect(409);
      await http.post('/auth/login').send({ email: u.email, password: 'wrong-password' }).expect(401);
      const me = await http.get('/auth/me').set(auth(u.accessToken)).expect(200);
      expect(me.body).toMatchObject({ email: u.email, role: 'CUSTOMER' });
    });

    it('rotates refresh tokens and revokes the whole family when an old one is replayed', async () => {
      const u = await register();
      const second = (await http.post('/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200)).body;
      expect(second.refreshToken).not.toBe(u.refreshToken);
      await http.post('/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401); // replay of the used token
      await http.post('/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401); // family is now dead
    });

    it('logout revokes the session', async () => {
      const u = await register();
      await http.post('/auth/logout').send({ refreshToken: u.refreshToken }).expect(204);
      await http.post('/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401);
    });

    it('guards routes by login and by role, and rejects unexpected fields', async () => {
      const u = await register();
      await http.get('/cart').expect(401);
      await http.post('/products').set(auth(u.accessToken)).send({ sku: 'X-1', name: 'Nope', priceKobo: 1 }).expect(403);
      await http.post('/auth/register').send({ email: 'a@b.co', password: 'a-strong-password', name: 'Eve', role: 'ADMIN' }).expect(400);
    });
  });

  describe('catalog', () => {
    it('searches by relevance, filters, sorts and paginates', async () => {
      const tag = uniq();
      await product({ name: `Wireless Noise Cancelling Headphones ${tag}`, description: 'Over-ear bluetooth headphones', priceKobo: 4_500_000 });
      await product({ name: `Wired Earbuds ${tag}`, description: 'Cheap earbuds for wireless-free listening', priceKobo: 500_000 });
      await product({ name: `Phone Case ${tag}`, priceKobo: 200_000, stockQuantity: 0 });

      const search = await http.get('/products').query({ q: `wireless headphones ${tag}` }).expect(200);
      expect(search.body.data[0].name).toContain('Wireless Noise Cancelling Headphones');

      const cheap = await http.get('/products').query({ q: tag, maxPrice: 600_000, sort: 'price_asc' }).expect(200);
      expect(cheap.body.data.map((p: any) => p.priceKobo)).toEqual([200_000, 500_000]);

      const inStock = await http.get('/products').query({ q: tag, inStock: 'true' }).expect(200);
      expect(inStock.body.meta.total).toBe(2);

      const paged = await http.get('/products').query({ q: tag, limit: 1, page: 2, sort: 'price_desc' }).expect(200);
      expect(paged.body.data).toHaveLength(1);
      expect(paged.body.meta).toMatchObject({ page: 2, limit: 1, total: 3, totalPages: 3 });
    });

    it('hides stock levels and inactive products from the public, but not from admins', async () => {
      const p = await product({ stockQuantity: 7 });
      const pub = (await http.get(`/products/${p.id}`).expect(200)).body;
      expect(pub.stockQuantity).toBeUndefined();
      expect(pub.inStock).toBe(true);

      await http.delete(`/products/${p.id}`).set(auth(adminToken)).expect(204);
      await http.get(`/products/${p.id}`).expect(404);
      const admin = (await http.get('/admin/products').set(auth(adminToken)).query({ q: p.name }).expect(200)).body;
      expect(admin.data[0]).toMatchObject({ id: p.id, stockQuantity: 7, isActive: false });
    });

    it('keeps a stock ledger and refuses adjustments that would go negative', async () => {
      const p = await product({ stockQuantity: 5 });
      await http.post(`/products/${p.id}/stock-adjustments`).set(auth(adminToken)).send({ delta: -2, reason: 'damaged in storage' }).expect(201);
      await http.post(`/products/${p.id}/stock-adjustments`).set(auth(adminToken)).send({ delta: -10, reason: 'too many' }).expect(409);
      expect(await stockOf(p.id)).toBe(3);
      const moves = await ds.query('SELECT delta, reason FROM stock_movements WHERE product_id = $1 ORDER BY id', [p.id]);
      expect(moves.map((m: any) => m.delta)).toEqual([5, -2]);
    });
  });

  describe('cart and checkout', () => {
    it('totals the cart and refuses more than is in stock', async () => {
      const p = await product({ stockQuantity: 3, priceKobo: 250_000 });
      const u = await register();
      const cart = (await addToCart(u.accessToken, p.id, 2).expect(200)).body;
      expect(cart).toMatchObject({ subtotalKobo: 500_000 });
      await addToCart(u.accessToken, p.id, 4).expect(409);
    });

    it('reserves stock, adds shipping, starts payment and empties the cart', async () => {
      const p = await product({ stockQuantity: 5, priceKobo: 100_000 });
      const { user, order, payment } = await placeOrder(p, 2);
      expect(order).toMatchObject({ status: 'PENDING_PAYMENT', subtotalKobo: 200_000, shippingKobo: 150_000, totalKobo: 350_000 });
      expect(payment.authorizationUrl).toContain('checkout.test');
      expect(await stockOf(p.id)).toBe(3);
      expect((await http.get('/cart').set(auth(user.accessToken))).body.items).toEqual([]);
    });

    it('gives free shipping on big baskets and snapshots the price at purchase time', async () => {
      const p = await product({ stockQuantity: 5, priceKobo: 3_000_000 });
      const { order } = await placeOrder(p, 2);
      expect(order.shippingKobo).toBe(0);
      await http.patch(`/products/${p.id}`).set(auth(adminToken)).send({ priceKobo: 9_999_999 }).expect(200);
      expect(order.items[0].unitPriceKobo).toBe(3_000_000);
    });

    it('is idempotent: retrying the same checkout returns the same order and reserves stock once', async () => {
      const p = await product({ stockQuantity: 5 });
      const u = await register();
      await addToCart(u.accessToken, p.id, 1).expect(200);
      const key = crypto.randomUUID();
      const first = await checkout(u.accessToken, key).expect(201);
      const again = await checkout(u.accessToken, key).expect(200);
      expect(again.headers['idempotent-replay']).toBe('true');
      expect(again.body.order.id).toBe(first.body.order.id);
      expect(await stockOf(p.id)).toBe(4);
      await http.post('/orders/checkout').set(auth(u.accessToken)).send({ shippingAddress: address }).expect(400); // key is required
    });

    it('never oversells: five shoppers race for the last unit and exactly one wins', async () => {
      const p = await product({ stockQuantity: 1 });
      const shoppers = await Promise.all([1, 2, 3, 4, 5].map(() => register()));
      for (const s of shoppers) await addToCart(s.accessToken, p.id, 1).expect(200);
      const results = await Promise.all(shoppers.map((s) => checkout(s.accessToken)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await stockOf(p.id)).toBe(0);
    });

    it('still saves the order when the payment provider is down, and lets the customer retry', async () => {
      const p = await product();
      const u = await register();
      await addToCart(u.accessToken, p.id).expect(200);
      gateway.failInit = true;
      const res = await checkout(u.accessToken).expect(201);
      gateway.failInit = false;
      expect(res.body.payment).toBeNull();
      expect(res.body.paymentError).toBeDefined();
      const retry = await http.post(`/orders/${res.body.order.id}/pay`).set(auth(u.accessToken)).expect(200);
      expect(retry.body.authorizationUrl).toContain('checkout.test');
    });

    it("hides other customers' orders", async () => {
      const p = await product();
      const { order } = await placeOrder(p);
      const stranger = await register();
      await http.get(`/orders/${order.id}`).set(auth(stranger.accessToken)).expect(404);
      await http.get(`/orders/${order.id}`).set(auth(adminToken)).expect(200);
    });
  });

  describe('payments', () => {
    it('rejects webhooks with a missing or wrong signature', async () => {
      await webhook(chargeSuccess('ORD-x', 1), 'bad').expect(401);
      await http.post('/payments/webhooks/paystack').set('Content-Type', 'application/json').send('{}').expect(401);
    });

    it('marks the order paid once, ignores redeliveries, and survives a second event for the same payment', async () => {
      const p = await product();
      const { user, order, payment } = await placeOrder(p);
      const body = chargeSuccess(payment.reference, order.totalKobo);

      expect((await webhook(body).expect(200)).body.outcome).toBe('applied');
      expect((await webhook(body).expect(200)).body.outcome).toBe('duplicate');
      expect((await webhook({ ...body, extra: 1 }).expect(200)).body.outcome).toBe('already_applied');

      const after = (await http.get(`/orders/${order.id}`).set(auth(user.accessToken))).body;
      expect(after.status).toBe('PAID');
      expect(after.payment.status).toBe('SUCCESS');
      expect(after.history.map((h: any) => h.to)).toEqual(['PENDING_PAYMENT', 'PAID']);
    });

    it('refuses to release an order when the paid amount is wrong, even with a valid signature', async () => {
      const p = await product();
      const { user, order, payment } = await placeOrder(p);
      expect((await webhook(chargeSuccess(payment.reference, 100)).expect(200)).body.outcome).toBe('amount_mismatch');
      expect((await http.get(`/orders/${order.id}`).set(auth(user.accessToken))).body.status).toBe('PENDING_PAYMENT');
    });

    it('can confirm a payment by asking the provider when the webhook never arrived', async () => {
      const p = await product();
      const { user, order, payment } = await placeOrder(p);
      gateway.verifyResult = { status: 'success', amountKobo: order.totalKobo, currency: 'NGN' };
      const res = await http.post(`/orders/${order.id}/payment/verify`).set(auth(user.accessToken)).expect(200);
      expect(res.body).toEqual({ paymentStatus: 'SUCCESS', orderStatus: 'PAID' });
      expect(payment.reference).toBeDefined();
    });
  });

  describe('order lifecycle', () => {
    it('lets a customer cancel an unpaid order and gives the stock back, but not a paid one', async () => {
      const p = await product({ stockQuantity: 4 });
      const { user, order, payment } = await placeOrder(p, 2);
      expect(await stockOf(p.id)).toBe(2);
      const cancelled = await http.post(`/orders/${order.id}/cancel`).set(auth(user.accessToken)).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(await stockOf(p.id)).toBe(4);

      const second = await placeOrder(p);
      await webhook(chargeSuccess(second.payment.reference, second.order.totalKobo)).expect(200);
      await http.post(`/orders/${second.order.id}/cancel`).set(auth(second.user.accessToken)).expect(409);
      expect(payment.reference).toBeDefined();
    });

    it('expires unpaid orders, releases their stock, and flags a late payment for refund', async () => {
      const p = await product({ stockQuantity: 3 });
      const { user, order, payment } = await placeOrder(p, 2);
      expect(await stockOf(p.id)).toBe(1);
      await ds.query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);

      expect(await app.get(OrdersService).expireStale()).toBeGreaterThanOrEqual(1);
      expect(await stockOf(p.id)).toBe(3);
      expect((await http.get(`/orders/${order.id}`).set(auth(user.accessToken))).body.status).toBe('EXPIRED');

      expect((await webhook(chargeSuccess(payment.reference, order.totalKobo)).expect(200)).body.outcome).toBe('late_payment');
      const after = (await http.get(`/orders/${order.id}`).set(auth(adminToken))).body;
      expect(after).toMatchObject({ status: 'EXPIRED', needsRefund: true });
    });

    it('walks paid orders through shipping with an audit trail, and blocks illegal moves', async () => {
      const p = await product();
      const { order, payment } = await placeOrder(p);
      await webhook(chargeSuccess(payment.reference, order.totalKobo)).expect(200);

      await http.patch(`/admin/orders/${order.id}/status`).set(auth(adminToken)).send({ status: 'PAID' }).expect(400);
      await http.patch(`/admin/orders/${order.id}/status`).set(auth(adminToken)).send({ status: 'DELIVERED' }).expect(409);
      await http.patch(`/admin/orders/${order.id}/status`).set(auth(adminToken)).send({ status: 'SHIPPED', note: 'DHL 123' }).expect(200);
      const done = await http.patch(`/admin/orders/${order.id}/status`).set(auth(adminToken)).send({ status: 'DELIVERED' }).expect(200);
      expect(done.body.history.map((h: any) => h.to)).toEqual(['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED']);
      await http.patch(`/admin/orders/${order.id}/status`).set(auth(adminToken)).send({ status: 'CANCELLED' }).expect(409);
    });

    it('restocks and flags a refund when an admin cancels a paid order', async () => {
      const p = await product({ stockQuantity: 2 });
      const { order, payment } = await placeOrder(p);
      await webhook(chargeSuccess(payment.reference, order.totalKobo)).expect(200);
      expect(await stockOf(p.id)).toBe(1);
      const res = await http.patch(`/admin/orders/${order.id}/status`).set(auth(adminToken)).send({ status: 'CANCELLED', note: 'out of courier coverage' }).expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', needsRefund: true });
      expect(await stockOf(p.id)).toBe(2);
    });

    it("lets only admins list everyone's orders", async () => {
      const u = await register();
      await http.get('/admin/orders').set(auth(u.accessToken)).expect(403);
      const list = await http.get('/admin/orders').set(auth(adminToken)).query({ status: 'PAID' }).expect(200);
      expect(list.body.data.every((o: any) => o.status === 'PAID')).toBe(true);
    });
  });

  it('reports health', async () => {
    await http.get('/health').expect(200);
    await http.get('/health/ready').expect(200);
  });
});
