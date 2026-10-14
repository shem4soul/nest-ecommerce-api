import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OrderStatus, canTransition } from './order-status';

/**
 * Moves an order to a new status inside the caller's transaction. The row is locked first, so two
 * things racing to change the same order (a webhook and the expiry job, say) are applied one after
 * the other and the second one sees the first one's result. Returns the previous status.
 */
export async function transitionOrder(
  m: EntityManager,
  orderId: string,
  to: OrderStatus,
  opts: { actorId?: string | null; note?: string } = {},
): Promise<OrderStatus> {
  const rows: Array<{ status: OrderStatus }> = await m.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (!rows[0]) throw new NotFoundException('Order not found');
  const from = rows[0].status;
  if (!canTransition(from, to)) throw new ConflictException(`An order that is ${from} cannot become ${to}`);

  await m.query(
    `UPDATE orders SET status = $2, updated_at = now(), paid_at = CASE WHEN $2 = 'PAID' THEN now() ELSE paid_at END WHERE id = $1`,
    [orderId, to],
  );
  await m.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $3, $4, $5)`,
    [orderId, from, to, opts.actorId ?? null, opts.note ?? null],
  );
  return from;
}

/** Gives an order's stock back and records why. Products are touched in id order so concurrent restocks can't deadlock. */
export async function restockOrder(m: EntityManager, orderId: string, reason: string, actorId?: string | null) {
  const items: Array<{ product_id: string; quantity: number }> = await m.query(
    `SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id`,
    [orderId],
  );
  for (const item of items) {
    await m.query(`UPDATE products SET stock_quantity = stock_quantity + $2, updated_at = now() WHERE id = $1`, [item.product_id, item.quantity]);
    await m.query(
      `INSERT INTO stock_movements (product_id, delta, reason, ref_type, ref_id, actor_id) VALUES ($1, $2, $3, 'ORDER', $4, $5)`,
      [item.product_id, item.quantity, reason, orderId, actorId ?? null],
    );
  }
}
