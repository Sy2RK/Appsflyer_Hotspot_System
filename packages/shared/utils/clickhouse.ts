import { createClient } from '@clickhouse/client';
import { env } from '../config/env.js';

export const clickhouse = createClient({
  url: `http://${env.clickhouse.host}:${env.clickhouse.port}`,
  username: env.clickhouse.user,
  password: env.clickhouse.password,
  database: env.clickhouse.database,
  clickhouse_settings: {
    async_insert: 0
  }
});

export async function chQuery<T = Record<string, unknown>>(
  query: string,
  query_params?: Record<string, unknown>
): Promise<T[]> {
  const result = await clickhouse.query({
    query,
    query_params,
    format: 'JSONEachRow'
  });
  return result.json<T>();
}

export async function chExec(query: string, query_params?: Record<string, unknown>): Promise<void> {
  await clickhouse.exec({
    query,
    query_params
  });
}

export async function chInsertJSON<T extends object>(
  table: string,
  values: T[]
): Promise<void> {
  if (values.length === 0) {
    return;
  }

  await clickhouse.insert({
    table,
    values,
    format: 'JSONEachRow'
  });
}
