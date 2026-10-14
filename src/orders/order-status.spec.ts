import { ADMIN_SETTABLE, TRANSITIONS, canTransition, computeTotals } from './order-status';

describe('order state machine', () => {
  it('allows the normal happy path', () => {
    expect(canTransition('PENDING_PAYMENT', 'PAID')).toBe(true);
    expect(canTransition('PAID', 'SHIPPED')).toBe(true);
    expect(canTransition('SHIPPED', 'DELIVERED')).toBe(true);
  });

  it('never lets a finished order move again', () => {
    for (const final of ['DELIVERED', 'CANCELLED', 'EXPIRED'] as const) expect(TRANSITIONS[final]).toEqual([]);
  });

  it('blocks shortcuts', () => {
    expect(canTransition('PENDING_PAYMENT', 'SHIPPED')).toBe(false);
    expect(canTransition('SHIPPED', 'CANCELLED')).toBe(false);
    expect(canTransition('PAID', 'PENDING_PAYMENT')).toBe(false);
  });

  it('keeps PAID and EXPIRED out of admin hands', () => {
    expect(ADMIN_SETTABLE).not.toContain('PAID');
    expect(ADMIN_SETTABLE).not.toContain('EXPIRED');
  });
});

describe('computeTotals', () => {
  it('charges flat shipping below the free-shipping line', () => {
    expect(computeTotals(100_000, 150_000, 5_000_000)).toEqual({ subtotalKobo: 100_000, shippingKobo: 150_000, totalKobo: 250_000 });
  });

  it('makes shipping free at or above the line', () => {
    expect(computeTotals(5_000_000, 150_000, 5_000_000).shippingKobo).toBe(0);
    expect(computeTotals(6_000_000, 150_000, 5_000_000).totalKobo).toBe(6_000_000);
  });
});
