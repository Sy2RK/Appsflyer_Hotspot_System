import { env } from '../config/env.js';
import type { AfMetricScope, AfSourceSurface } from './afMetricScopes.js';
import { compatibleSnapshotScopes } from './afMetricScopes.js';
import { md5Hex } from './hash.js';
import { pgQuery } from './postgres.js';
import { stableStringify } from './stableStringify.js';

export type AfOfficialSnapshotStatus =
  | 'pending'
  | 'ready'
  | 'provisional'
  | 'partial'
  | 'corrected'
  | 'stale'
  | 'failed';

export interface AfExpectedSnapshotComponent {
  source_api?: string;
  app_key?: string;
  platform?: string;
  app_id?: string;
  window_from?: string;
  window_to?: string;
}

export interface AfOfficialSnapshotRecord {
  id: number;
  snapshot_id: string;
  metric_scope: AfMetricScope;
  source_surface: AfSourceSurface;
  source_api: string;
  app_key: string;
  platform: string;
  app_id: string;
  window_from: string;
  window_to: string;
  timezone: string;
  currency: string;
  query_params_json: Record<string, unknown>;
  row_count: number;
  content_signature: string;
  source_updated_at: string | null;
  fetched_at: string;
  status: AfOfficialSnapshotStatus;
  is_provisional: boolean;
  previous_snapshot_id: string | null;
  diff_json: Record<string, unknown>;
  error: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AfOfficialBatchSnapshot {
  snapshot_id: string;
  metric_scope: AfMetricScope;
  source_surface: AfSourceSurface;
  window_from: string;
  window_to: string;
  timezone: string;
  currency: string;
  status: AfOfficialSnapshotStatus;
  is_provisional: boolean;
  snapshot_count: number;
  expected_component_count: number;
  missing_component_count: number;
  missing_components: AfExpectedSnapshotComponent[];
  source_updated_at: string | null;
  fetched_at: string | null;
  component_snapshot_ids: string[];
}

export interface UpsertAfOfficialSnapshotInput {
  snapshotId?: string;
  metricScope: AfMetricScope;
  sourceSurface: AfSourceSurface;
  sourceApi: string;
  appKey?: string;
  platform?: string;
  appId?: string;
  windowFrom: string;
  windowTo: string;
  timezone?: string;
  currency?: string;
  queryParams?: Record<string, unknown>;
  rowCount?: number;
  contentSignature?: string;
  sourceUpdatedAt?: string | null;
  fetchedAt?: string;
  status?: AfOfficialSnapshotStatus;
  isProvisional?: boolean;
  diffJson?: Record<string, unknown>;
  error?: string | null;
  metadataJson?: Record<string, unknown>;
}

let ensureAfOfficialSnapshotsSchemaPromise: Promise<void> | null = null;

export async function ensureAfOfficialSnapshotsSchema(): Promise<void> {
  if (!ensureAfOfficialSnapshotsSchemaPromise) {
    ensureAfOfficialSnapshotsSchemaPromise = (async () => {
      await pgQuery(`CREATE TABLE IF NOT EXISTS af_official_snapshots (
        id BIGSERIAL PRIMARY KEY,
        snapshot_id TEXT NOT NULL UNIQUE,
        metric_scope TEXT NOT NULL,
        source_surface TEXT NOT NULL,
        source_api TEXT NOT NULL,
        app_key TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        app_id TEXT NOT NULL DEFAULT '',
        window_from DATE NOT NULL,
        window_to DATE NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'preferred',
        currency TEXT NOT NULL DEFAULT 'preferred',
        query_params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        row_count INTEGER NOT NULL DEFAULT 0,
        content_signature TEXT NOT NULL DEFAULT '',
        source_updated_at TIMESTAMPTZ,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'ready',
        is_provisional BOOLEAN NOT NULL DEFAULT FALSE,
        previous_snapshot_id TEXT,
        diff_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_af_official_snapshots_lookup
           ON af_official_snapshots (source_surface, metric_scope, window_from, window_to, app_key, platform, fetched_at DESC)`
      );
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_af_official_snapshots_signature
           ON af_official_snapshots (source_surface, source_api, app_key, platform, window_from, window_to, content_signature)`
      );
    })().catch((error) => {
      ensureAfOfficialSnapshotsSchemaPromise = null;
      throw error;
    });
  }
  await ensureAfOfficialSnapshotsSchemaPromise;
}

export function buildAfContentSignature(value: unknown): string {
  return md5Hex(stableStringify(value));
}

function normalizePlatform(platform?: string): string {
  return String(platform || '').trim().toLowerCase();
}

function normalizeText(value?: string): string {
  return String(value || '').trim();
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }
  const text = String(value || '').trim();
  const direct = /^\d{4}-\d{2}-\d{2}/.exec(text);
  if (direct) {
    return direct[0];
  }
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return text.slice(0, 10);
}

function rowToAfOfficialSnapshotRecord(row: Record<string, unknown>): AfOfficialSnapshotRecord {
  return {
    id: Number(row.id || 0),
    snapshot_id: String(row.snapshot_id || ''),
    metric_scope: String(row.metric_scope || 'dashboard_selected_window') as AfMetricScope,
    source_surface: String(row.source_surface || 'master_pivot') as AfSourceSurface,
    source_api: String(row.source_api || ''),
    app_key: String(row.app_key || ''),
    platform: String(row.platform || ''),
    app_id: String(row.app_id || ''),
    window_from: normalizeDate(row.window_from),
    window_to: normalizeDate(row.window_to),
    timezone: String(row.timezone || 'preferred'),
    currency: String(row.currency || 'preferred'),
    query_params_json: (row.query_params_json || {}) as Record<string, unknown>,
    row_count: Number(row.row_count || 0),
    content_signature: String(row.content_signature || ''),
    source_updated_at: row.source_updated_at ? String(row.source_updated_at) : null,
    fetched_at: String(row.fetched_at || ''),
    status: String(row.status || 'ready') as AfOfficialSnapshotStatus,
    is_provisional: row.is_provisional === true,
    previous_snapshot_id: row.previous_snapshot_id ? String(row.previous_snapshot_id) : null,
    diff_json: (row.diff_json || {}) as Record<string, unknown>,
    error: row.error ? String(row.error) : null,
    metadata_json: (row.metadata_json || {}) as Record<string, unknown>,
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || '')
  };
}

function componentKey(component: AfExpectedSnapshotComponent): string {
  return [
    normalizeText(component.source_api),
    normalizeText(component.app_key),
    normalizePlatform(component.platform),
    normalizeText(component.app_id),
    normalizeDate(String(component.window_from || '')),
    normalizeDate(String(component.window_to || ''))
  ].join('|');
}

function snapshotComponentKey(row: AfOfficialSnapshotRecord): string {
  return componentKey({
    source_api: row.source_api,
    app_key: row.app_key,
    platform: row.platform,
    app_id: row.app_id,
    window_from: row.window_from,
    window_to: row.window_to
  });
}

function normalizeExpectedComponent(
  component: AfExpectedSnapshotComponent,
  fallback: {
    windowFrom: string;
    windowTo: string;
  }
): AfExpectedSnapshotComponent {
  return {
    source_api: normalizeText(component.source_api),
    app_key: normalizeText(component.app_key),
    platform: normalizePlatform(component.platform),
    app_id: normalizeText(component.app_id),
    window_from: normalizeDate(String(component.window_from || fallback.windowFrom)),
    window_to: normalizeDate(String(component.window_to || fallback.windowTo))
  };
}

async function findPreviousComparableSnapshot(input: {
  sourceSurface: AfSourceSurface;
  sourceApi: string;
  appKey: string;
  platform: string;
  appId: string;
  windowFrom: string;
  windowTo: string;
}): Promise<AfOfficialSnapshotRecord | null> {
  await ensureAfOfficialSnapshotsSchema();
  const result = await pgQuery<Record<string, unknown>>(
    `SELECT *
       FROM af_official_snapshots
      WHERE source_surface = $1
        AND source_api = $2
        AND app_key = $3
        AND platform = $4
        AND app_id = $5
        AND window_from = $6::date
        AND window_to = $7::date
        AND status <> 'failed'
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1`,
    [
      input.sourceSurface,
      input.sourceApi,
      input.appKey,
      input.platform,
      input.appId,
      input.windowFrom,
      input.windowTo
    ]
  );
  return result.rows[0] ? rowToAfOfficialSnapshotRecord(result.rows[0]) : null;
}

function buildSnapshotId(
  input: UpsertAfOfficialSnapshotInput,
  contentSignature: string,
  status: AfOfficialSnapshotStatus,
  fetchedAt: string
): string {
  if (input.snapshotId) {
    return input.snapshotId;
  }
  const identity = {
    metric_scope: input.metricScope,
    source_surface: input.sourceSurface,
    source_api: input.sourceApi,
    app_key: normalizeText(input.appKey),
    platform: normalizePlatform(input.platform),
    app_id: normalizeText(input.appId),
    window_from: input.windowFrom,
    window_to: input.windowTo,
    content_signature: contentSignature
  };
  if (status === 'failed') {
    return `af_failed_${md5Hex(stableStringify({
      ...identity,
      fetched_at: fetchedAt,
      error: input.error ?? ''
    })).slice(0, 24)}`;
  }
  return `af_${md5Hex(stableStringify(identity)).slice(0, 24)}`;
}

export async function upsertAfOfficialSnapshot(
  input: UpsertAfOfficialSnapshotInput
): Promise<AfOfficialSnapshotRecord> {
  await ensureAfOfficialSnapshotsSchema();
  const appKey = normalizeText(input.appKey);
  const platform = normalizePlatform(input.platform);
  const appId = normalizeText(input.appId);
  const timezone = normalizeText(input.timezone) || 'preferred';
  const currency = normalizeText(input.currency) || 'preferred';
  const queryParams = input.queryParams ?? {};
  const metadataJson = input.metadataJson ?? {};
  const contentSignature =
    input.contentSignature || buildAfContentSignature({ queryParams, metadataJson, rowCount: input.rowCount ?? 0 });
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const previous = await findPreviousComparableSnapshot({
    sourceSurface: input.sourceSurface,
    sourceApi: input.sourceApi,
    appKey,
    platform,
    appId,
    windowFrom: input.windowFrom,
    windowTo: input.windowTo
  });
  const changed = Boolean(previous?.content_signature && previous.content_signature !== contentSignature);
  const status =
    input.status ??
    (input.error
      ? 'failed'
      : input.isProvisional
        ? 'provisional'
        : changed
          ? 'corrected'
          : 'ready');
  const snapshotId = buildSnapshotId(input, contentSignature, status, fetchedAt);
  const result = await pgQuery<Record<string, unknown>>(
    `INSERT INTO af_official_snapshots (
       snapshot_id, metric_scope, source_surface, source_api, app_key, platform, app_id,
       window_from, window_to, timezone, currency, query_params_json, row_count,
       content_signature, source_updated_at, fetched_at, status, is_provisional,
       previous_snapshot_id, diff_json, error, metadata_json
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8::date, $9::date, $10, $11, $12::jsonb, $13,
       $14, $15::timestamptz, COALESCE($16::timestamptz, NOW()), $17, $18,
       $19, $20::jsonb, $21, $22::jsonb
     )
     ON CONFLICT (snapshot_id) DO UPDATE
        SET fetched_at = EXCLUDED.fetched_at,
            status = EXCLUDED.status,
            is_provisional = EXCLUDED.is_provisional,
            source_updated_at = EXCLUDED.source_updated_at,
            row_count = EXCLUDED.row_count,
            query_params_json = EXCLUDED.query_params_json,
            diff_json = EXCLUDED.diff_json,
            error = EXCLUDED.error,
            metadata_json = EXCLUDED.metadata_json,
            updated_at = NOW()
     RETURNING *`,
    [
      snapshotId,
      input.metricScope,
      input.sourceSurface,
      input.sourceApi,
      appKey,
      platform,
      appId,
      input.windowFrom,
      input.windowTo,
      timezone,
      currency,
      JSON.stringify(queryParams),
      Math.max(0, Math.floor(Number(input.rowCount || 0))),
      contentSignature,
      input.sourceUpdatedAt ?? null,
      fetchedAt,
      status,
      input.isProvisional ?? status === 'provisional',
      previous?.snapshot_id ?? null,
      JSON.stringify({
        changed,
        previous_content_signature: previous?.content_signature ?? null,
        ...(input.diffJson ?? {})
      }),
      input.error ?? null,
      JSON.stringify(metadataJson)
    ]
  );
  return rowToAfOfficialSnapshotRecord(result.rows[0]);
}

export async function listAfOfficialSnapshots(input: {
  metricScope?: AfMetricScope;
  sourceSurface?: AfSourceSurface;
  sourceApi?: string;
  appKey?: string;
  platform?: string;
  windowFrom?: string;
  windowTo?: string;
  limit?: number;
} = {}): Promise<AfOfficialSnapshotRecord[]> {
  await ensureAfOfficialSnapshotsSchema();
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace('?', `$${values.length}`));
  };
  if (input.metricScope) add('metric_scope = ?', input.metricScope);
  if (input.sourceSurface) add('source_surface = ?', input.sourceSurface);
  if (input.sourceApi) add('source_api = ?', input.sourceApi);
  if (input.appKey) add('app_key = ?', input.appKey);
  if (input.platform) add('platform = ?', normalizePlatform(input.platform));
  if (input.windowFrom) add('window_from >= ?::date', input.windowFrom);
  if (input.windowTo) add('window_to <= ?::date', input.windowTo);
  const limit = Math.min(500, Math.max(1, Math.floor(Number(input.limit || 100))));
  const result = await pgQuery<Record<string, unknown>>(
    `SELECT *
       FROM af_official_snapshots
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY fetched_at DESC, id DESC
      LIMIT ${limit}`
    , values
  );
  return result.rows.map(rowToAfOfficialSnapshotRecord);
}

export async function buildAfOfficialBatchSnapshot(input: {
  metricScope: AfMetricScope;
  sourceSurface: AfSourceSurface;
  windowFrom: string;
  windowTo: string;
  timezone?: string;
  currency?: string;
  appKey?: string;
  platform?: string;
  expectedComponents?: AfExpectedSnapshotComponent[];
}): Promise<AfOfficialBatchSnapshot> {
  await ensureAfOfficialSnapshotsSchema();
  const compatibleScopes = compatibleSnapshotScopes(input.metricScope);
  const values: unknown[] = [
    input.sourceSurface,
    compatibleScopes,
    input.windowFrom,
    input.windowTo,
    normalizeText(input.appKey),
    normalizePlatform(input.platform)
  ];
  const result = await pgQuery<Record<string, unknown>>(
    `WITH ranked AS (
       SELECT *,
              row_number() OVER (
                PARTITION BY source_surface, source_api, app_key, platform, app_id, window_from, window_to
                ORDER BY fetched_at DESC, id DESC
              ) AS rn
         FROM af_official_snapshots
        WHERE source_surface = $1
          AND metric_scope = ANY($2::text[])
          AND window_from >= $3::date
          AND window_to <= $4::date
          AND status <> 'failed'
          AND ($5::text = '' OR app_key = $5::text)
          AND ($6::text = '' OR platform = $6::text)
     )
     SELECT *
       FROM ranked
      WHERE rn = 1
      ORDER BY app_key ASC, platform ASC, window_from ASC, window_to ASC, snapshot_id ASC`,
    values
  );
  const snapshots = result.rows.map(rowToAfOfficialSnapshotRecord);
  const expectedComponents = (input.expectedComponents ?? []).map((component) =>
    normalizeExpectedComponent(component, {
      windowFrom: input.windowFrom,
      windowTo: input.windowTo
    })
  );
  const snapshotKeys = new Set(snapshots.map(snapshotComponentKey));
  const missingComponents = expectedComponents.filter((component) => !snapshotKeys.has(componentKey(component)));
  const status: AfOfficialSnapshotStatus =
    snapshots.length === 0
      ? 'stale'
      : missingComponents.length > 0
        ? 'partial'
        : snapshots.some((row) => row.status === 'stale')
        ? 'stale'
        : snapshots.some((row) => row.status === 'provisional' || row.is_provisional)
          ? 'provisional'
          : snapshots.some((row) => row.status === 'corrected')
            ? 'corrected'
            : 'ready';
  const fetchedAtValues = snapshots.map((row) => row.fetched_at).filter(Boolean).sort();
  const sourceUpdatedValues = snapshots.map((row) => row.source_updated_at).filter(Boolean).sort();
  const componentIds = snapshots.map((row) => row.snapshot_id);
  const snapshotId =
    componentIds.length > 0
      ? `af_batch_${md5Hex(stableStringify({ input, componentIds })).slice(0, 24)}`
      : `af_batch_missing_${md5Hex(stableStringify(input)).slice(0, 16)}`;

  return {
    snapshot_id: snapshotId,
    metric_scope: input.metricScope,
    source_surface: input.sourceSurface,
    window_from: input.windowFrom,
    window_to: input.windowTo,
    timezone: input.timezone ?? env.timezone,
    currency: input.currency ?? 'preferred',
    status,
    is_provisional: snapshots.some((row) => row.status === 'provisional' || row.is_provisional),
    snapshot_count: snapshots.length,
    expected_component_count: expectedComponents.length,
    missing_component_count: missingComponents.length,
    missing_components: missingComponents,
    source_updated_at: sourceUpdatedValues[sourceUpdatedValues.length - 1] ?? null,
    fetched_at: fetchedAtValues[fetchedAtValues.length - 1] ?? null,
    component_snapshot_ids: componentIds
  };
}
