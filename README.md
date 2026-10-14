# Nest E-commerce API

A production-style online shop backend: catalog with full-text search, carts, race-safe checkout, Paystack payments with signed webhooks, an order state machine, and role-based access. Built to be correct under concurrency, not just to pass a demo.

**NestJS 11 · TypeScript · PostgreSQL · TypeORM · Paystack · Jest · Docker**

## Features

- **Auth:** JWT access tokens plus rotating refresh tokens. A replayed refresh token revokes the whole login chain. Roles: `CUSTOMER`, `ADMIN`.
- **Catalog:** products and categories, Postgres full-text search with relevance ranking (`websearch_to_tsquery` + GIN index), price and stock filters, sorting, pagination.
- **Inventory ledger:** every stock change is a row in `stock_movements`, so the current quantity can always be explained.
- **Cart:** one server-side cart per customer, with availability flags so the client can warn before checkout.
- **Checkout:** one transaction turns the cart into an order, reserves stock, snapshots prices and applies shipping rules. Idempotent via the `Idempotency-Key` header.
- **Payments:** Paystack initialize and verify, plus a signature-checked, idempotent webhook that validates the paid amount.
- **Order lifecycle:** `PENDING_PAYMENT → PAID → SHIPPED → DELIVERED`, with `CANCELLED` and `EXPIRED`. Every change is recorded in `order_status_history`.
- **Automatic expiry:** unpaid orders are expired every minute and their stock goes back on the shelf.
- **Platform:** validation on every input, one consistent error shape, rate limiting, Helmet, Swagger docs at `/docs`, health endpoints.

## Design decisions worth knowing

| Concern | What the code does |
| --- | --- |
| Overselling | Stock is taken with a conditional `UPDATE ... WHERE stock_quantity >= qty` per product, inside the checkout transaction. Five shoppers racing for the last unit: exactly one wins (covered by an e2e test). A `CHECK (stock_quantity >= 0)` is the backstop. |
| Double checkout | `Idempotency-Key` is unique per user in the database. A retry, or two identical requests at the same instant, returns the original order and reserves stock once. |
| Money | Integer kobo everywhere (`BIGINT`), never floats. Item prices are copied into the order, so later price edits don't change past orders. |
| Webhook authenticity | Paystack signs the raw body with HMAC-SHA512 using your secret key. The app keeps the raw bytes (`rawBody: true`) and compares in constant time. |
| Webhook replays | Each applied event is stored by body hash in the same transaction as the status change. A redelivery is ignored, and a failure rolls everything back so Paystack's retry can succeed. |
| Wrong amount | A validly signed webhook for the wrong amount does not release the order. The payment is marked `MISMATCH`. |
| Late or duplicate payment | Money for an expired, cancelled or already-paid order is recorded and the order is flagged `needs_refund` for a human. Nothing is silently lost. |
| Concurrent state changes | Order rows are locked (`SELECT ... FOR UPDATE`) before a status change, so a webhook racing the expiry job is applied in sequence. Locks are taken in a fixed order to avoid deadlocks. |
| Multiple instances | The expiry sweep uses `FOR UPDATE SKIP LOCKED`, so several API instances can run it safely. |
| Refresh tokens | Stored as SHA-256 hashes. Claiming a token is one conditional `UPDATE`, so two simultaneous refreshes can't both succeed. |
| Privacy | Someone else's order returns 404, the same as one that doesn't exist. Public product responses hide exact stock. |

The concurrency-critical paths use plain SQL on purpose, with TypeORM entities for ordinary CRUD. The schema lives in a hand-written migration so constraints and indexes are explicit.

## Quick start with Docker

```bash
git clone https://github.com/shem4soul/nest-ecommerce-api.git
cd nest-ecommerce-api
cp .env.example .env     # set JWT_ACCESS_SECRET and your Paystack TEST secret key
docker compose up --build
```

The API is on http://localhost:3000 and the docs on http://localhost:3000/docs. Create the first admin:

```bash
docker compose exec api node dist/database/seed-admin.js
```

## Quick start without Docker

Needs Node 20+ and PostgreSQL 14+ (a database called `shop`, user `shop`, password `shop` matches `.env.example`).

```bash
npm install
cp .env.example .env
npm run build
npm run migrate          # creates the tables
npm run seed:admin       # first admin from ADMIN_EMAIL / ADMIN_PASSWORD
npm run start:dev        # watch mode
```

## Try the whole flow without Paystack

1. Log in as the admin (`POST /auth/login`) and create a product (`POST /products`, price in kobo).
2. Register a customer, add the product to the cart (`PUT /cart/items/:productId`).
3. Check out (`POST /orders/checkout` with an `Idempotency-Key` header). You get an order and a payment reference.
4. Pretend to be Paystack:

```bash
npm run simulate:payment -- <payment.reference> <order.totalKobo>
```

The order moves to `PAID`. Run it again and the webhook is recognised as a duplicate. With a real Paystack test key the checkout response also contains a hosted payment page URL.

## Using real Paystack (test mode)

1. Put your **test** secret key (`sk_test_...`) in `.env` as `PAYSTACK_SECRET_KEY`.
2. Expose your API (for example `ngrok http 3000`) and set the webhook URL in the Paystack dashboard (Settings, API Keys & Webhooks) to `https://<your-host>/payments/webhooks/paystack`.
3. Check out, open `payment.authorizationUrl`, and pay with one of Paystack's test cards (listed in their docs).
4. If you miss the webhook, `POST /orders/:id/payment/verify` asks Paystack directly and applies the result.

## API overview

Amounts are in kobo. Send `Authorization: Bearer <accessToken>` except where marked public. Full request and response shapes are in Swagger at `/docs`.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` (public); `GET /auth/me` |
| Products | `GET /products` (public; `q`, `categoryId`, `minPrice`, `maxPrice`, `inStock`, `sort`, `page`, `limit`), `GET /products/:id` (public) |
| Products (admin) | `POST /products`, `PATCH /products/:id`, `DELETE /products/:id`, `POST /products/:id/stock-adjustments`, `GET /admin/products` |
| Categories | `GET /categories` (public), `POST /categories` (admin) |
| Cart | `GET /cart`, `PUT /cart/items/:productId`, `DELETE /cart/items/:productId`, `DELETE /cart` |
| Orders | `POST /orders/checkout`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `POST /orders/:id/pay`, `POST /orders/:id/payment/verify` |
| Orders (admin) | `GET /admin/orders`, `GET /admin/orders/:id`, `PATCH /admin/orders/:id/status` |
| Payments | `POST /payments/webhooks/paystack` (called by Paystack) |
| Health | `GET /health`, `GET /health/ready` |

## Testing

```bash
npm run typecheck
npm test            # unit tests: state machine, shipping rules, webhook signature, slugs
npm run test:e2e    # 24 end-to-end tests against real Postgres
```

The e2e suite needs a database. By default it uses `postgres://shop:shop@localhost:5432/shop_test` (set `TEST_DATABASE_URL` to change it) and **wipes that database's `public` schema**, so never point it at data you care about. It covers refresh-token rotation and replay, role guards, search and filters, the five-way oversell race, idempotent checkout, signed and tampered webhooks, wrong-amount payments, expiry with a late payment, and the full admin order flow.

## Configuration

See `.env.example`. Key settings: `DATABASE_URL`, `JWT_ACCESS_SECRET` (32+ characters), `PAYSTACK_SECRET_KEY`, `ORDER_TTL_MINUTES` (how long an unpaid order holds stock), `SHIPPING_FLAT_KOBO` and `FREE_SHIPPING_OVER_KOBO`.

## Before you go live

- Use strong secrets, HTTPS, and your **live** Paystack key only in production.
- Refunds are not automated: orders flagged `needs_refund` need a person (or a future refund job) to act on them.
- Behind a proxy or load balancer, make sure `X-Forwarded-For` is set so rate limiting sees real client IPs.
- Add an email provider for order confirmations if you need them.

## Project layout

```
src/
  main.ts, app.module.ts, setup.ts
  config/env.ts              validated environment
  common/                    guards, decorators, error filter, pagination
  database/                  hand-written migration, migrate and seed scripts
  auth/                      register, login, rotating refresh tokens
  catalog/                   products, categories, search, stock ledger
  cart/                      server-side cart
  orders/                    checkout, state machine, lifecycle helpers, expiry job
  payments/                  gateway interface, Paystack, webhook handling
  health/
test/                        e2e suite
scripts/simulate-payment.js  local stand-in for Paystack's webhook
```

## Not included yet

Refund automation, coupons, product variants and images, email notifications, and a Redis cache for hot product reads.

## Author

**Emmanuel Seun Shittu**, Software Engineer

- GitHub: [github.com/shem4soul](https://github.com/shem4soul)
- LinkedIn: [linkedin.com/in/emmanuel-shittu91573915a](https://linkedin.com/in/emmanuel-shittu91573915a)

## License

MIT
