// Runs before every test file. The e2e suite needs a real Postgres database (see README).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://shop:shop@localhost:5432/shop_test';
process.env.RUN_MIGRATIONS = 'true';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-1234';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit_secret';
process.env.ORDER_TTL_MINUTES = '30';
process.env.SHIPPING_FLAT_KOBO = '150000';
process.env.FREE_SHIPPING_OVER_KOBO = '5000000';
