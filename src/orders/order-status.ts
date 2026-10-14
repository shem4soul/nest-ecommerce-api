export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'EXPIRED';

/** The only moves an order may make. Everything that changes status goes through this table. */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED', 'EXPIRED'],
  PAID: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => TRANSITIONS[from].includes(to);

/** Statuses an admin may set by hand. PAID and EXPIRED are only ever set by the payment flow and the expiry job. */
export const ADMIN_SETTABLE: readonly OrderStatus[] = ['SHIPPED', 'DELIVERED', 'CANCELLED'];

export function computeTotals(subtotalKobo: number, flatShippingKobo: number, freeOverKobo: number) {
  const shippingKobo = subtotalKobo >= freeOverKobo ? 0 : flatShippingKobo;
  return { subtotalKobo, shippingKobo, totalKobo: subtotalKobo + shippingKobo };
}
