import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

async function main() {
  const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error('Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters)');
  }
  const ds = new DataSource({ type: 'postgres', url: DATABASE_URL });
  await ds.initialize();
  const res = await ds.query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'Admin', 'ADMIN')
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [ADMIN_EMAIL.toLowerCase(), await bcrypt.hash(ADMIN_PASSWORD, 10)],
  );
  console.log(res.length ? `admin created: ${ADMIN_EMAIL}` : `admin already exists: ${ADMIN_EMAIL}`);
  await ds.destroy();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
