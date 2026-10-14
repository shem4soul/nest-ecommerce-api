import { BadGatewayException, ConflictException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import crypto from 'node:crypto';
import { DataSource } from 'typeorm';
import { Env } from '../config/env';
import { transitionOrder } from '../orders/order-lifecycle';
import { PAYMENT_GATEWAY, PaymentGateway, verifyPaystackSignature } from './payment-gateway';

export type WebhookOutcome =
  | 'applied' | 'duplicate' | 'already_applied' | 'unknown_reference'
  | 'amount_mismatch' | 'late_payment' | 'duplicate_payment' | 'ignored';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Starts (or returns the already-started) payment for an unpaid order. */
  async initializeForOrder(orderId: string, userId: string) {
    const rows = await this.ds.query(
      `SELECT o.status, o.total_kobo, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1 AND o.user_id = $2`,
      [orderId, userId],
    );
    if (!rows[0]) throw new NotFoundException('Order not found');
    if (rows[0].status !== 'PENDING_PAYMENT') throw new ConflictException(`Order is ${rows[0].status}, it cannot be paid`);

    const open = await this.ds.query(
      `SELECT reference, authorization_url FROM payments
        WHERE order_id = $1 AND status = 'PENDING' AND authorization_url IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    );
    if (open[0]) return { reference: open[0].reference as string, authorizationUrl: open[0].authorization_url as string };

    const attempt = (await this.ds.query(`SELECT count(*)::int AS n FROM payments WHERE order_id = $1`, [orderId]))[0].n + 1;
    const reference = `ORD-${orderId.replace(/-/g, '').slice(0, 16)}-${attempt}`;
    // The payment row exists before we call the provider, so a webhook can never arrive for a reference we don't know.
    await this.ds.query(`INSERT INTO payments (order_id, reference, amount_kobo) VALUES ($1, $2, $3)`, [orderId, reference, rows[0].total_kobo]);
    try {
      const { authorizationUrl } = await this.gateway.initialize({
        email: rows[0].email,
        amountKobo: Number(rows[0].total_kobo),
        reference,
        callbackUrl: this.config.get('PAYMENT_CALLBACK_URL', { infer: true }),
      });
      await this.ds.query(`UPDATE payments SET authorization_url = $2 WHERE reference = $1`, [reference, authorizationUrl]);
      return { reference, authorizationUrl };
    } catch (err) {
      await this.ds.query(`UPDATE payments SET status = 'FAILED' WHERE reference = $1`, [reference]);
      this.logger.warn(`payment init failed for order ${orderId}: ${(err as Error).message}`);
      throw new BadGatewayException('Could not start the payment, please try again');
    }
  }

  /** Fallback for a missed webhook: ask the provider directly and apply the result. */
  async verifyForOrder(orderId: string, userId: string) {
    const rows = await this.ds.query(
      `SELECT p.reference, p.status FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.order_id = $1 AND o.user_id = $2 ORDER BY p.created_at DESC LIMIT 1`,
      [orderId, userId],
    );
    if (!rows[0]) throw new NotFoundException('No payment found for this order');

    if (rows[0].status === 'PENDING') {
      const result = await this.gateway.verify(rows[0].reference);
      if (result.status === 'success') await this.applySuccess(rows[0].reference, result.amountKobo, result.currency);
      else if (result.status === 'failed') await this.ds.query(`UPDATE payments SET status = 'FAILED' WHERE reference = $1 AND status = 'PENDING'`, [rows[0].reference]);
    }
    const now = await this.ds.query(
      `SELECT p.status AS payment_status, o.status AS order_status FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.reference = $1`,
      [rows[0].reference],
    );
    return { paymentStatus: now[0].payment_status, orderStatus: now[0].order_status };
  }

  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<WebhookOutcome> {
    if (!verifyPaystackSignature(rawBody, signature, this.config.get('PAYSTACK_SECRET_KEY', { infer: true }))) {
      throw new UnauthorizedException('Invalid signature');
    }
    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid payload');
    }
    const d = event?.data;
    if (event?.event !== 'charge.success' || !d?.reference || (d.status && d.status !== 'success')) return 'ignored';

    return this.applySuccess(String(d.reference), Number(d.amount), String(d.currency), {
      eventKey: crypto.createHash('sha256').update(rawBody).digest('hex'),
      eventType: event.event,
      payload: event,
    });
  }

  /**
   * Marks an order paid. Everything happens in one transaction so a failure rolls the dedupe record
   * back too, which lets the provider's retry succeed. The amount is always checked against what we
   * asked for: a signed webhook for the wrong amount must not release an order.
   */
  private async applySuccess(
    reference: string,
    amountKobo: number,
    currency: string,
    evt?: { eventKey: string; eventType: string; payload: unknown },
  ): Promise<WebhookOutcome> {
    return this.ds.transaction(async (m) => {
      if (evt) {
        const fresh = await m.query(
          `INSERT INTO webhook_events (event_key, provider, event_type, payload) VALUES ($1, 'paystack', $2, $3)
           ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,
          [evt.eventKey, evt.eventType, JSON.stringify(evt.payload)],
        );
        if (!fresh.length) return 'duplicate';
      }

      const pay = await m.query(`SELECT id, order_id, amount_kobo, status FROM payments WHERE reference = $1 FOR UPDATE`, [reference]);
      if (!pay[0]) {
        this.logger.warn(`webhook for unknown reference ${reference}`);
        return 'unknown_reference';
      }
      if (pay[0].status === 'SUCCESS') return 'already_applied';
      if (Number(pay[0].amount_kobo) !== amountKobo || currency !== 'NGN') {
        await m.query(`UPDATE payments SET status = 'MISMATCH' WHERE id = $1`, [pay[0].id]);
        this.logger.error(`amount mismatch on ${reference}: expected ${pay[0].amount_kobo}, got ${amountKobo} ${currency}`);
        return 'amount_mismatch';
      }

      const order = await m.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [pay[0].order_id]);
      await m.query(`UPDATE payments SET status = 'SUCCESS', paid_at = now() WHERE id = $1`, [pay[0].id]);
      if (order[0].status === 'PENDING_PAYMENT') {
        await transitionOrder(m, pay[0].order_id, 'PAID', { note: `Paid via paystack (${reference})` });
        return 'applied';
      }
      // Money arrived for an order that is no longer waiting for it (expired, cancelled, or already paid).
      await m.query(`UPDATE orders SET needs_refund = TRUE, updated_at = now() WHERE id = $1`, [pay[0].order_id]);
      return order[0].status === 'PAID' ? 'duplicate_payment' : 'late_payment';
    });
  }
}
