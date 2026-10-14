import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { pageMeta } from '../common/pagination';
import { rowsOf } from '../common/rows';
import { Env } from '../config/env';
import { CheckoutDto } from './dto/orders.dto';
import { restockOrder, transitionOrder } from './order-lifecycle';
import { ADMIN_SETTABLE, OrderStatus, computeTotals } from './order-status';

@Injectable()
export class OrdersService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Turns the cart into an order and reserves stock in one transaction.
   * Stock is taken with a conditional UPDATE per product, so two shoppers racing for the last unit
   * can't both get it. The Idempotency-Key makes a retried request (flaky network, double click)
   * return the original order instead of creating a second one.
   */
  async checkout(userId: string, idempotencyKey: string, dto: CheckoutDto): Promise<{ orderId: string; replay: boolean }> {
    const existing = await this.findByKey(userId, idempotencyKey);
    if (existing) return { orderId: existing, replay: true };

    const ttl = this.config.get('ORDER_TTL_MINUTES', { infer: true });
    try {
      const orderId = await this.ds.transaction(async (m) => {
        const cart: Array<{ product_id: string; quantity: number }> = await m.query(
          `SELECT ci.product_id, ci.quantity FROM carts c JOIN cart_items ci ON ci.cart_id = c.id
            WHERE c.user_id = $1 ORDER BY ci.product_id`,
          [userId],
        );
        if (!cart.length) throw new BadRequestException('Your cart is empty');

        const lines: Array<{ productId: string; sku: string; name: string; unitPriceKobo: number; quantity: number }> = [];
        for (const item of cart) {
          const rows = rowsOf(
            await m.query(
              `UPDATE products SET stock_quantity = stock_quantity - $2, updated_at = now()
                WHERE id = $1 AND is_active AND stock_quantity >= $2
                RETURNING id, sku, name, price_kobo`,
              [item.product_id, item.quantity],
            ),
          );
          if (!rows[0]) {
            const p = await m.query(`SELECT name FROM products WHERE id = $1`, [item.product_id]);
            throw new ConflictException(`Not enough stock for "${p[0]?.name ?? 'an item in your cart'}"`);
          }
          lines.push({ productId: rows[0].id, sku: rows[0].sku, name: rows[0].name, unitPriceKobo: Number(rows[0].price_kobo), quantity: item.quantity });
        }

        const subtotal = lines.reduce((s, l) => s + l.unitPriceKobo * l.quantity, 0);
        const totals = computeTotals(
          subtotal,
          this.config.get('SHIPPING_FLAT_KOBO', { infer: true }),
          this.config.get('FREE_SHIPPING_OVER_KOBO', { infer: true }),
        );
        const order = await m.query(
          `INSERT INTO orders (user_id, status, subtotal_kobo, shipping_kobo, total_kobo, shipping_address, idempotency_key, expires_at)
           VALUES ($1, 'PENDING_PAYMENT', $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)
           RETURNING id`,
          [userId, totals.subtotalKobo, totals.shippingKobo, totals.totalKobo, JSON.stringify({ country: 'NG', ...dto.shippingAddress }), idempotencyKey, String(ttl)],
        );
        const id: string = order[0].id;

        for (const l of lines) {
          await m.query(
            `INSERT INTO order_items (order_id, product_id, sku, name, unit_price_kobo, quantity, line_total_kobo)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, l.productId, l.sku, l.name, l.unitPriceKobo, l.quantity, l.unitPriceKobo * l.quantity],
          );
          await m.query(
            `INSERT INTO stock_movements (product_id, delta, reason, ref_type, ref_id, actor_id) VALUES ($1, $2, 'ORDER_RESERVED', 'ORDER', $3, $4)`,
            [l.productId, -l.quantity, id, userId],
          );
        }
        await m.query(`INSERT INTO order_status_history (order_id, from_status, to_status, actor_id) VALUES ($1, NULL, 'PENDING_PAYMENT', $2)`, [id, userId]);
        await m.query(`DELETE FROM cart_items WHERE cart_id = (SELECT id FROM carts WHERE user_id = $1)`, [userId]);
        return id;
      });
      return { orderId, replay: false };
    } catch (err) {
      // Two identical requests at the same instant: the loser hits the unique key and gets the winner's order.
      if (err instanceof QueryFailedError && (err as any).driverError?.constraint?.includes('idempotency_key')) {
        const winner = await this.findByKey(userId, idempotencyKey);
        if (winner) return { orderId: winner, replay: true };
      }
      throw err;
    }
  }

  private async findByKey(userId: string, key: string): Promise<string | null> {
    const rows = await this.ds.query(`SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2`, [userId, key]);
    return rows[0]?.id ?? null;
  }

  async get(orderId: string, user: { id: string; role: string }) {
    const orders = await this.ds.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    const o = orders[0];
    // Someone else's order looks exactly like one that doesn't exist.
    if (!o || (user.role !== 'ADMIN' && o.user_id !== user.id)) throw new NotFoundException('Order not found');

    const [items, payments, history] = await Promise.all([
      this.ds.query(`SELECT product_id, sku, name, unit_price_kobo, quantity, line_total_kobo FROM order_items WHERE order_id = $1 ORDER BY name`, [orderId]),
      this.ds.query(`SELECT reference, status, authorization_url, paid_at FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [orderId]),
      this.ds.query(`SELECT from_status, to_status, note, created_at FROM order_status_history WHERE order_id = $1 ORDER BY id`, [orderId]),
    ]);
    return {
      id: o.id,
      status: o.status as OrderStatus,
      subtotalKobo: Number(o.subtotal_kobo),
      shippingKobo: Number(o.shipping_kobo),
      totalKobo: Number(o.total_kobo),
      currency: o.currency,
      shippingAddress: o.shipping_address,
      needsRefund: o.needs_refund,
      expiresAt: o.expires_at,
      paidAt: o.paid_at,
      createdAt: o.created_at,
      items: items.map((i: any) => ({
        productId: i.product_id, sku: i.sku, name: i.name,
        unitPriceKobo: Number(i.unit_price_kobo), quantity: i.quantity, lineTotalKobo: Number(i.line_total_kobo),
      })),
      payment: payments[0]
        ? {
            reference: payments[0].reference,
            status: payments[0].status,
            authorizationUrl: payments[0].status === 'PENDING' ? payments[0].authorization_url : null,
            paidAt: payments[0].paid_at,
          }
        : null,
      history: history.map((h: any) => ({ from: h.from_status, to: h.to_status, note: h.note, at: h.created_at })),
    };
  }

  async listMine(userId: string, page: number, limit: number) {
    const [rows, count] = await Promise.all([
      this.ds.query(
        `SELECT id, status, total_kobo, currency, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, (page - 1) * limit],
      ),
      this.ds.query(`SELECT count(*)::int AS n FROM orders WHERE user_id = $1`, [userId]),
    ]);
    return { data: rows.map(this.summary), meta: pageMeta(page, limit, count[0].n) };
  }

  async adminList(status: OrderStatus | undefined, page: number, limit: number) {
    const [rows, count] = await Promise.all([
      this.ds.query(
        `SELECT id, status, total_kobo, currency, created_at, needs_refund FROM orders
          WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [status ?? null, limit, (page - 1) * limit],
      ),
      this.ds.query(`SELECT count(*)::int AS n FROM orders WHERE ($1::text IS NULL OR status = $1)`, [status ?? null]),
    ]);
    return { data: rows.map((r: any) => ({ ...this.summary(r), needsRefund: r.needs_refund })), meta: pageMeta(page, limit, count[0].n) };
  }

  private summary = (r: any) => ({ id: r.id, status: r.status, totalKobo: Number(r.total_kobo), currency: r.currency, createdAt: r.created_at });

  /** Customers can only cancel an order they haven't paid for yet. */
  async cancelMine(userId: string, orderId: string) {
    await this.ds.transaction(async (m) => {
      const rows = await m.query(`SELECT user_id, status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!rows[0] || rows[0].user_id !== userId) throw new NotFoundException('Order not found');
      if (rows[0].status !== 'PENDING_PAYMENT') throw new ConflictException('Only unpaid orders can be cancelled. Please contact support.');
      await transitionOrder(m, orderId, 'CANCELLED', { actorId: userId, note: 'Cancelled by customer' });
      await restockOrder(m, orderId, 'ORDER_CANCELLED', userId);
    });
    return this.get(orderId, { id: userId, role: 'CUSTOMER' });
  }

  async adminUpdateStatus(adminId: string, orderId: string, to: OrderStatus, note?: string) {
    if (!ADMIN_SETTABLE.includes(to)) throw new BadRequestException(`Admins can set SHIPPED, DELIVERED or CANCELLED. ${to} is set automatically.`);
    await this.ds.transaction(async (m) => {
      const from = await transitionOrder(m, orderId, to, { actorId: adminId, note });
      if (to === 'CANCELLED') {
        await restockOrder(m, orderId, 'ORDER_CANCELLED', adminId);
        // Money was already taken, so someone has to refund it.
        if (from === 'PAID') await m.query(`UPDATE orders SET needs_refund = TRUE WHERE id = $1`, [orderId]);
      }
    });
    return this.get(orderId, { id: adminId, role: 'ADMIN' });
  }

  /** Releases stock held by orders nobody paid for. SKIP LOCKED lets several instances run this without colliding. */
  async expireStale(limit = 50): Promise<number> {
    return this.ds.transaction(async (m) => {
      const rows: Array<{ id: string }> = await m.query(
        `SELECT id FROM orders WHERE status = 'PENDING_PAYMENT' AND expires_at < now()
          ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      for (const r of rows) {
        await transitionOrder(m, r.id, 'EXPIRED', { note: 'Payment window elapsed' });
        await restockOrder(m, r.id, 'ORDER_EXPIRED');
      }
      return rows.length;
    });
  }
}
