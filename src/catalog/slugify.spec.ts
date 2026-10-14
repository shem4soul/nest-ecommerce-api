import { slugify } from './products.service';

describe('slugify', () => {
  it('makes url-safe slugs', () => {
    expect(slugify('Wireless Headphones (Pro) 2026!')).toBe('wireless-headphones-pro-2026');
    expect(slugify('  Café   Latte ')).toBe('cafe-latte');
  });
  it('never returns an empty slug', () => expect(slugify('***')).toBe('item'));
});
