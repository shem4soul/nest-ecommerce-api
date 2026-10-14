import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class CartService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async get(userId: string) {
    const rows: Array<{
      product_id: string;
      name: string;
      sku: string;
      price_kobo: string;
      quantity: number;
      stock_quantity: number;
      is_active: boolean;
    }> = await this.ds.query(
      `SELECT ci.product_id, p.name, p.sku, p.price_kobo, ci.quantity, p.stock_quantity, p.is_active
         FROM carts c
         JOIN cart_items ci ON ci.cart_id = c.id
         JOIN products p ON p.id = ci.product_id
        WHERE c.user_id = $1
        ORDER BY p.name`,
      [userId],
    );
    const items = rows.map((r) => {
      const unitPriceKobo = Number(r.price_kobo);
      return {
        productId: r.product_id,
        name: r.name,
        sku: r.sku,
        unitPriceKobo,
        quantity: r.quantity,
        lineTotalKobo: unitPriceKobo * r.quantity,
        // Lets the client warn before checkout if something sold out or was withdrawn.
        available: r.is_active && r.stock_quantity >= r.quantity,
      };
    });
    return { items, subtotalKobo: items.reduce((sum, i) => sum + i.lineTotalKobo, 0), currency: 'NGN' };
  }

  async setItem(userId: string, productId: string, quantity: number) {
    const product = await this.ds.query(`SELECT stock_quantity, is_active FROM products WHERE id = $1`, [productId]);
    if (!product[0] || !product[0].is_active) throw new NotFoundException('Product not found');
    if (quantity > product[0].stock_quantity) throw new ConflictException(`Only ${product[0].stock_quantity} left in stock`);

    await this.ds.transaction(async (m) => {
      const cart = await m.query(
        `INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING id`,
        [userId],
      );
      await m.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [cart[0].id, productId, quantity],
      );
    });
    return this.get(userId);
  }

  async removeItem(userId: string, productId: string) {
    await this.ds.query(
      `DELETE FROM cart_items WHERE product_id = $2 AND cart_id = (SELECT id FROM carts WHERE user_id = $1)`,
      [userId, productId],
    );
    return this.get(userId);
  }

  async clear(userId: string) {
    await this.ds.query(`DELETE FROM cart_items WHERE cart_id = (SELECT id FROM carts WHERE user_id = $1)`, [userId]);
  }
}
