import 'dotenv/config';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
  });
  await ds.initialize();
  const ran = await ds.runMigrations();
  console.log(ran.length ? `applied: ${ran.map((m) => m.name).join(', ')}` : 'database is up to date');
  await ds.destroy();
}
main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
