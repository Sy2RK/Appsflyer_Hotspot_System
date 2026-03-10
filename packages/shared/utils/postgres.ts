import { Pool, QueryResult } from 'pg';
import { env } from '../config/env.js';

const pool = new Pool({
  connectionString: env.postgresUrl,
  max: 10
});

export async function pgQuery<T extends object = Record<string, unknown>>(
  text: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}

export async function pgClose(): Promise<void> {
  await pool.end();
}
