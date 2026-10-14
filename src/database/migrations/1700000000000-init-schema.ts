import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The schema is written as plain SQL on purpose: CHECK constraints, partial indexes, the generated
 * full-text column and the idempotency key are part of the design, not ORM details.
 */
export class InitSchema1700000000000 implements MigrationInterface {
  name = 'InitSchema1700000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (role IN ('CUSTOMER', 'ADMIN')),
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Refresh tokens are stored hashed and rotate on every use. family_id lets us revoke a whole
      -- login chain if a rotated token is ever replayed.
      CREATE TABLE refresh_tokens (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        family_id   UUID NOT NULL,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        revoked_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_refresh_family ON refresh_tokens (family_id);

      CREATE TABLE categories (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name       TEXT NOT NULL UNIQUE,
        slug       TEXT NOT NULL UNIQUE,
        parent_id  UUID REFERENCES categories (id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE products (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sku            TEXT NOT NULL UNIQUE,
        name           TEXT NOT NULL,
        slug           TEXT NOT NULL UNIQUE,
        description    TEXT,
        price_kobo     BIGINT NOT NULL CHECK (price_kobo >= 0),
        currency       TEXT NOT NULL DEFAULT 'NGN',
        stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
        category_id    UUID REFERENCES categories (id) ON DELETE SET NULL,
        is_active      BOOLEAN NOT NULL DEFAULT TRUE,
        search         TSVECTOR GENERATED ALWAYS AS (
                         setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
                         setweight(to_tsvector('english', coalesce(description, '')), 'B')
                       ) STORED,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_products_search ON products USING GIN (search);
      CREATE INDEX idx_products_category ON products (category_id) WHERE is_active;
      CREATE INDEX idx_products_price ON products (price_kobo) WHERE is_active;

      -- Every stock change is a row here, so the current quantity can always be explained.
      CREATE TABLE stock_movements (
        id         BIGSERIAL PRIMARY KEY,
        product_id UUID NOT NULL REFERENCES products (id),
        delta      INTEGER NOT NULL,
        reason     TEXT NOT NULL,
        ref_type   TEXT,
        ref_id     TEXT,
        actor_id   UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_stock_movements_product ON stock_movements (product_id, created_at DESC);

      CREATE TABLE carts (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE cart_items (
        cart_id    UUID NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
        quantity   INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
        PRIMARY KEY (cart_id, product_id)
      );

      CREATE TABLE orders (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          UUID NOT NULL REFERENCES users (id),
        status           TEXT NOT NULL CHECK (status IN
                           ('PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'EXPIRED')),
        subtotal_kobo    BIGINT NOT NULL CHECK (subtotal_kobo >= 0),
        shipping_kobo    BIGINT NOT NULL CHECK (shipping_kobo >= 0),
        total_kobo       BIGINT NOT NULL CHECK (total_kobo >= 0),
        currency         TEXT NOT NULL DEFAULT 'NGN',
        shipping_address JSONB NOT NULL,
        idempotency_key  TEXT NOT NULL,
        needs_refund     BOOLEAN NOT NULL DEFAULT FALSE,
        expires_at       TIMESTAMPTZ,
        paid_at          TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX idx_orders_user ON orders (user_id, created_at DESC);
      CREATE INDEX idx_orders_expiry ON orders (expires_at) WHERE status = 'PENDING_PAYMENT';

      CREATE TABLE order_items (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id         UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        product_id       UUID NOT NULL REFERENCES products (id),
        sku              TEXT NOT NULL,
        name             TEXT NOT NULL,
        unit_price_kobo  BIGINT NOT NULL,
        quantity         INTEGER NOT NULL CHECK (quantity > 0),
        line_total_kobo  BIGINT NOT NULL
      );
      CREATE INDEX idx_order_items_order ON order_items (order_id);

      CREATE TABLE order_status_history (
        id          BIGSERIAL PRIMARY KEY,
        order_id    UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        actor_id    UUID,
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_order_history_order ON order_status_history (order_id, id);

      CREATE TABLE payments (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id           UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        provider           TEXT NOT NULL DEFAULT 'paystack',
        reference          TEXT NOT NULL UNIQUE,
        amount_kobo        BIGINT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'MISMATCH')),
        authorization_url  TEXT,
        paid_at            TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_payments_order ON payments (order_id);

      -- Every webhook body we have applied. A redelivery hits the primary key and is ignored.
      CREATE TABLE webhook_events (
        event_key   TEXT PRIMARY KEY,
        provider    TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        payload     JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TABLE IF EXISTS webhook_events, payments, order_status_history, order_items, orders,
        cart_items, carts, stock_movements, products, categories, refresh_tokens, users CASCADE;
    `);
  }
}
