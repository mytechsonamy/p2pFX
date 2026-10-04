import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/p2pfx');
migrate(pool)
  .then((applied) => console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date'))
  .finally(() => pool.end());
