import crypto from 'crypto';
import { env } from '../config/env.js';
import type {
  BitableExportSourceType,
  FeedbackSkillVersionRecord,
  RecommendationExecutionFeedbackRecord,
  RecommendationType
} from '../types/models.js';
import { md5Hex } from './hash.js';
import { getFeishuTenantAccessToken } from './notifier.js';
import { writeOperationLog } from './operationLog.js';
import { pgQuery } from './postgres.js';
import {
  loadSevenDayLaterLookupRowsForRecommendations,
  querySevenDayLaterDataForLookupRows,
  SEVEN_DAY_LATER_FIELD_LABEL
} from './sevenDayLaterData.js';
import {
  ensureRecommendationFeedbackStorage,
  getBitableExportConfig,
  getLatestFeedbackSkillVersion,
  getLatestOperationLog,
  listBitableExportDailyTables,
  listBitableExportRecordRefsByTable,
  listRecommendationExecutionFeedbacksByRecommendations,
  releaseJobLock,
  tryAcquireJobLock,
  upsertRecommendationExecutionFeedbacks,
  insertFeedbackSkillVersion
} from './repositories.js';

interface LoggerLike {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

interface BitableRecordItem {
  record_id: string;
  fields: Record<string, unknown>;
  last_modified_time: number | null;
}

interface BitableFieldRecord {
  field_id: string;
  field_name: string;
  type: number;
}

interface BudgetFeedbackDatasetRow {
  id: number;
  app_key: string;
  product_name: string;
  platform: string;
  media_source: string;
  keyword: string;
  match_type: string;
  report_date: string;
  action: string;
  change_ratio: number;
  suggested_budget: number;
  current_cost: number;
  current_ecpi: number;
  target_ecpi: number;
  primary_metric: string;
  metric_mode: string;
  current_roas: number | null;
  target_roas: number | null;
  volume_tier: string;
  expected_installs_delta: number;
  confidence: number;
  reason_code: string;
  llm_summary: unknown;
  status: string;
  stage: string | null;
  last_installs: number | null;
  last_clicks: number | null;
  last_cpi: number | null;
  execution_status: string | null;
  is_adopted: boolean;
  validation_result: string | null;
  feedback_synced_at: string | null;
  feedback_record_id: string | null;
  feedback_table_id: string | null;
  feedback_report_date: string | null;
  bitable_last_modified_time: string | null;
}

export interface BudgetFeedbackQueryFilter {
  appKey?: string;
  platform?: string;
  status?: string;
  from?: string;
  to?: string;
  executionStatus?: string;
  isAdopted?: boolean;
  hasManualReview?: boolean;
}

export interface BitableFeedbackSyncResult {
  source_type: BitableExportSourceType;
  table_id: string;
  table_count: number;
  scanned_table_count: number;
  synced_table_ids: string[];
  scanned_record_count: number;
  synced_count: number;
  skipped_count: number;
  seven_day_data_updated_count: number;
  feedback_changed: boolean;
  synced_at: string;
  latest_skill_updated_at: string | null;
  latest_skill_dataset_row_count: number;
}

export interface BitableFeedbackSyncSnapshot {
  last_status: string;
  last_synced_at: string | null;
  last_record_count: number;
  last_error: string | null;
  latest_skill_updated_at: string | null;
}

const SOURCE_TYPE: BitableExportSourceType = 'delivery_actions';
const BUDGET_SCOPE = 'budget';
const EXECUTION_STATUS_FIELD_LABEL = '执行状态';
const ADOPTED_FIELD_LABEL = '是否采纳';
const MANUAL_REVIEW_FIELD_LABEL = '人工批复';
const BITABLE_IO_LOCK_TTL_MS = 30 * 60 * 1000;
const BITABLE_IO_LOCK_PREFIX = 'bitable:source_io';
const BITABLE_BACKFILL_LOCK_TTL_MS = 30 * 60 * 1000;
const BITABLE_BACKFILL_LOCK_PREFIX = 'bitable:feedback_backfill';
const FEISHU_TEXT_FIELD_TYPE = 1;
const SUCCESS_STATUSES = new Set(['已完成-效果符合预期']);
const RISK_STATUSES = new Set(['已完成-效果不及预期', '不执行', '无法执行', '已回滚', '暂缓执行']);
const SKILL_PROMPT_CACHE_TTL_MS = 60 * 1000;

let latestSkillPromptCache: {
  key: string;
  expiresAt: number;
  value: string;
} | null = null;

function bitableSourceIOLockName(sourceType: BitableExportSourceType): string {
  return `${BITABLE_IO_LOCK_PREFIX}:${sourceType}`;
}

function bitableFeedbackBackfillLockName(sourceType: BitableExportSourceType): string {
  return `${BITABLE_BACKFILL_LOCK_PREFIX}:${sourceType}`;
}

export async function withBitableSourceIOLock<T>(
  sourceType: BitableExportSourceType,
  work: () => Promise<T>
): Promise<T> {
  const ownerId = crypto.randomUUID();
  const acquired = await tryAcquireJobLock(bitableSourceIOLockName(sourceType), ownerId, BITABLE_IO_LOCK_TTL_MS);
  if (!acquired) {
    throw new Error(`bitable_source_io_locked:${sourceType}`);
  }
  try {
    return await work();
  } finally {
    await releaseJobLock(bitableSourceIOLockName(sourceType), ownerId);
  }
}

async function applySevenDayLaterBackfill(
  sourceType: BitableExportSourceType,
  appToken: string,
  pendingUpdates: Map<string, Array<{ record_id: string; value: string }>>,
  logger?: LoggerLike
): Promise<number> {
  if (pendingUpdates.size === 0) {
    return 0;
  }

  const ownerId = crypto.randomUUID();
  const acquired = await tryAcquireJobLock(
    bitableFeedbackBackfillLockName(sourceType),
    ownerId,
    BITABLE_BACKFILL_LOCK_TTL_MS
  );
  if (!acquired) {
    logger?.warn?.('bitable_feedback_backfill_skip_locked', {
      source_type: sourceType,
      table_count: pendingUpdates.size
    });
    return 0;
  }

  let updatedCount = 0;
  try {
    for (const [tableId, updates] of pendingUpdates.entries()) {
      try {
        await ensureSevenDayLaterFieldForFeedbackTable(appToken, tableId);
      } catch (error) {
        logger?.warn?.('bitable_feedback_backfill_field_failed', {
          source_type: sourceType,
          table_id: tableId,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      for (const update of updates) {
        try {
          await updateBitableRecordFieldsForFeedback(appToken, tableId, update.record_id, {
            [SEVEN_DAY_LATER_FIELD_LABEL]: update.value
          });
          updatedCount += 1;
        } catch (error) {
          logger?.warn?.('bitable_feedback_backfill_record_failed', {
            source_type: sourceType,
            table_id: tableId,
            record_id: update.record_id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  } finally {
    await releaseJobLock(bitableFeedbackBackfillLockName(sourceType), ownerId);
  }

  return updatedCount;
}

function parseSingleSelectValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return parseSingleSelectValue(value[0]);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.name ?? record.text ?? record.label ?? '').trim();
  }
  return String(value ?? '').trim();
}

function parseCheckboxValue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

export function shouldUpsertFeedbackRow(
  row: {
    recommendation_type: RecommendationType;
    recommendation_id: number;
    execution_status: string | null;
    is_adopted: boolean;
    validation_result: string | null;
    record_id: string;
    table_id: string;
    sync_key: string;
    report_date: string;
    raw_fields_json: unknown;
    bitable_last_modified_time: string | null;
  },
  existing: RecommendationExecutionFeedbackRecord | undefined
): boolean {
  return feedbackChangedComparedWithExisting(row, existing);
}

async function feishuJsonRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const tokenResult = await getFeishuTenantAccessToken();
  if (!tokenResult.ok) {
    throw new Error(tokenResult.error);
  }

  const params = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') {
      params.set(key, String(value));
    }
  });

  const url = `https://open.feishu.cn/open-apis${path}${params.size ? `?${params.toString()}` : ''}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tokenResult.accessToken}`,
      'content-type': 'application/json'
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {})
  });
  const json = (await response.json().catch(() => ({}))) as {
    code?: number;
    msg?: string;
    data?: T;
  };
  if (!response.ok || Number(json.code ?? 0) !== 0 || !json.data) {
    throw new Error(
      `Feishu feedback request failed: status=${response.status} code=${String(json.code ?? '')} msg=${String(json.msg ?? '')}`
    );
  }
  return json.data;
}

async function listBitableRecordsForFeedback(appToken: string, tableId: string): Promise<BitableRecordItem[]> {
  const items: BitableRecordItem[] = [];
  let pageToken = '';
  let hasMore = true;
  while (hasMore) {
    const data = await feishuJsonRequest<{
      items?: Array<{ record_id?: string; fields?: Record<string, unknown>; last_modified_time?: number }>;
      has_more?: boolean;
      page_token?: string;
    }>('GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/records`, undefined, {
      page_size: 500,
      page_token: pageToken || undefined,
      automatic_fields: true,
      field_names: JSON.stringify([
        EXECUTION_STATUS_FIELD_LABEL,
        ADOPTED_FIELD_LABEL,
        MANUAL_REVIEW_FIELD_LABEL,
        SEVEN_DAY_LATER_FIELD_LABEL
      ])
    });
    for (const item of data.items || []) {
      if (!item.record_id) {
        continue;
      }
      items.push({
        record_id: item.record_id,
        fields: item.fields || {},
        last_modified_time: Number.isFinite(Number(item.last_modified_time))
          ? Number(item.last_modified_time)
          : null
      });
    }
    hasMore = data.has_more === true;
    pageToken = String(data.page_token || '');
    if (!pageToken) {
      break;
    }
  }
  return items;
}

async function listBitableFieldsForFeedback(appToken: string, tableId: string): Promise<BitableFieldRecord[]> {
  const items: BitableFieldRecord[] = [];
  let pageToken = '';
  let hasMore = true;
  while (hasMore) {
    const data = await feishuJsonRequest<{
      items?: Array<{ field_id?: string; field_name?: string; type?: number }>;
      has_more?: boolean;
      page_token?: string;
    }>('GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, undefined, {
      page_size: 500,
      page_token: pageToken || undefined
    });
    for (const item of data.items || []) {
      if (!item.field_id || !item.field_name) {
        continue;
      }
      items.push({
        field_id: item.field_id,
        field_name: item.field_name,
        type: Number(item.type || 0)
      });
    }
    hasMore = data.has_more === true;
    pageToken = String(data.page_token || '');
    if (!pageToken) {
      break;
    }
  }
  return items;
}

async function ensureSevenDayLaterFieldForFeedbackTable(appToken: string, tableId: string): Promise<void> {
  const fields = await listBitableFieldsForFeedback(appToken, tableId);
  const existing = fields.find((field) => field.field_name === SEVEN_DAY_LATER_FIELD_LABEL);
  if (existing) {
    return;
  }
  await feishuJsonRequest(
    'POST',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    {
      field_name: SEVEN_DAY_LATER_FIELD_LABEL,
      type: FEISHU_TEXT_FIELD_TYPE
    }
  );
}

async function updateBitableRecordFieldsForFeedback(
  appToken: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>
): Promise<void> {
  await feishuJsonRequest(
    'PUT',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    {
      fields
    }
  );
}

function normalizeBudgetDatasetFilter(filter: BudgetFeedbackQueryFilter = {}): Required<BudgetFeedbackQueryFilter> {
  return {
    appKey: String(filter.appKey || '').trim(),
    platform: String(filter.platform || '').trim().toLowerCase(),
    status: String(filter.status || '').trim(),
    from: String(filter.from || '').trim(),
    to: String(filter.to || '').trim(),
    executionStatus: String(filter.executionStatus || '').trim(),
    isAdopted: filter.isAdopted === true,
    hasManualReview: filter.hasManualReview === true
  };
}

async function queryBudgetFeedbackDatasetRows(filter: BudgetFeedbackQueryFilter = {}): Promise<BudgetFeedbackDatasetRow[]> {
  await ensureRecommendationFeedbackStorage();
  const normalized = normalizeBudgetDatasetFilter(filter);
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (normalized.appKey) {
    values.push(normalized.appKey);
    clauses.push(`br.app_key = $${values.length}`);
  }
  if (normalized.platform) {
    values.push(normalized.platform);
    clauses.push(`br.platform = $${values.length}`);
  }
  if (normalized.status) {
    values.push(normalized.status);
    clauses.push(`br.status = $${values.length}`);
  }
  if (normalized.from) {
    values.push(normalized.from);
    clauses.push(`br.date >= $${values.length}::date`);
  }
  if (normalized.to) {
    values.push(normalized.to);
    clauses.push(`br.date <= $${values.length}::date`);
  }
  if (normalized.executionStatus) {
    values.push(normalized.executionStatus);
    clauses.push(`COALESCE(ref.execution_status, '') = $${values.length}`);
  }
  if (filter.isAdopted === true || filter.isAdopted === false) {
    values.push(filter.isAdopted);
    clauses.push(`COALESCE(ref.is_adopted, FALSE) = $${values.length}`);
  }
  if (filter.hasManualReview === true) {
    clauses.push(`NULLIF(BTRIM(COALESCE(ref.validation_result, '')), '') IS NOT NULL`);
  } else if (filter.hasManualReview === false) {
    clauses.push(`NULLIF(BTRIM(COALESCE(ref.validation_result, '')), '') IS NULL`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pgQuery<BudgetFeedbackDatasetRow>(
    `SELECT br.id, br.app_key,
            COALESCE(
              NULLIF(CASE WHEN br.platform = 'ios' THEN a.ios_display_name WHEN br.platform = 'android' THEN a.android_display_name ELSE '' END, ''),
              NULLIF(a.display_name, ''),
              br.app_key
            ) AS product_name,
            br.platform, br.media_source, br.keyword, br.match_type, br.date::text AS report_date, br.action, br.change_ratio,
            br.suggested_budget, br.current_cost, br.current_ecpi, br.target_ecpi, br.primary_metric, br.metric_mode,
            br.current_roas, br.target_roas, br.volume_tier, br.expected_installs_delta, br.confidence, br.reason_code,
            br.llm_summary, br.status, ks.current_stage AS stage, ks.last_installs, ks.last_clicks, ks.last_cpi,
            ref.execution_status, COALESCE(ref.is_adopted, FALSE) AS is_adopted, ref.validation_result,
            ref.synced_at::text AS feedback_synced_at, ref.record_id AS feedback_record_id, ref.table_id AS feedback_table_id,
            ref.report_date::text AS feedback_report_date, ref.bitable_last_modified_time::text AS bitable_last_modified_time
       FROM budget_recommendations br
       JOIN apps a ON a.app_key = br.app_key
       LEFT JOIN keyword_lifecycle_states ks
         ON ks.app_key = br.app_key
        AND ks.platform = br.platform
        AND ks.keyword = br.keyword
        AND ks.match_type = br.match_type
       LEFT JOIN recommendation_execution_feedbacks ref
         ON ref.source_type = '${SOURCE_TYPE}'
        AND ref.recommendation_type = 'budget'
        AND ref.recommendation_id = br.id
       ${where}
      ORDER BY br.date DESC, br.updated_at DESC, br.id DESC`,
    values
  );
  return result.rows;
}

function buildBudgetFeedbackDatasetEntry(row: BudgetFeedbackDatasetRow): Record<string, unknown> {
  return {
    identity: {
      recommendation_id: row.id,
      app_key: row.app_key,
      product_name: row.product_name,
      platform: row.platform,
      media_source: row.media_source,
      keyword: row.keyword,
      match_type: row.match_type,
      report_date: row.report_date
    },
    recommendation: {
      action: row.action,
      change_ratio: row.change_ratio,
      suggested_budget: row.suggested_budget,
      confidence: row.confidence,
      reason_code: row.reason_code,
      llm_summary: row.llm_summary,
      status: row.status
    },
    context: {
      primary_metric: row.primary_metric,
      metric_mode: row.metric_mode,
      current_cost: row.current_cost,
      current_ecpi: row.current_ecpi,
      target_ecpi: row.target_ecpi,
      current_roas: row.current_roas,
      target_roas: row.target_roas,
      volume_tier: row.volume_tier,
      expected_installs_delta: row.expected_installs_delta,
      stage: row.stage,
      last_installs: row.last_installs,
      last_clicks: row.last_clicks,
      last_cpi: row.last_cpi
    },
    feedback: {
      execution_status: row.execution_status,
      is_adopted: row.is_adopted,
      validation_result: row.validation_result,
      feedback_synced_at: row.feedback_synced_at,
      feedback_record_id: row.feedback_record_id,
      feedback_table_id: row.feedback_table_id,
      feedback_report_date: row.feedback_report_date,
      bitable_last_modified_time: row.bitable_last_modified_time
    },
    meta: {
      source_type: SOURCE_TYPE
    }
  };
}

export async function buildBudgetFeedbackNdjson(
  filter: BudgetFeedbackQueryFilter = {}
): Promise<{ content: string; rowCount: number }> {
  const rows = await queryBudgetFeedbackDatasetRows(filter);
  const content = rows.map((row) => JSON.stringify(buildBudgetFeedbackDatasetEntry(row))).join('\n');
  return {
    content: content ? `${content}\n` : '',
    rowCount: rows.length
  };
}

function statusOutcomeBucket(row: BudgetFeedbackDatasetRow): 'success' | 'risk' | 'in_progress' | 'other' {
  const executionStatus = String(row.execution_status || '').trim();
  if (SUCCESS_STATUSES.has(executionStatus)) {
    return 'success';
  }
  if (RISK_STATUSES.has(executionStatus)) {
    return 'risk';
  }
  if (executionStatus && !SUCCESS_STATUSES.has(executionStatus)) {
    return 'in_progress';
  }
  return 'other';
}

function summarizeBudgetFeedbackStats(rows: BudgetFeedbackDatasetRow[]): Record<string, unknown> {
  const reviewedRows = rows.filter(
    (row) =>
      String(row.execution_status || '').trim() ||
      row.is_adopted === true ||
      String(row.validation_result || '').trim() ||
      row.feedback_synced_at
  );

  const byExecutionStatus = new Map<string, number>();
  const byPattern = new Map<
    string,
    {
      action: string;
      platform: string;
      media_source: string;
      volume_tier: string;
      reason_code: string;
      stage: string;
      total: number;
      adopted: number;
      success: number;
      risk: number;
      manual_review_count: number;
    }
  >();

  for (const row of reviewedRows) {
    const executionStatus = String(row.execution_status || '未填写').trim() || '未填写';
    byExecutionStatus.set(executionStatus, (byExecutionStatus.get(executionStatus) || 0) + 1);
    const key = [
      row.action,
      row.platform,
      row.media_source,
      row.volume_tier,
      row.reason_code,
      row.stage || '未知'
    ].join('|');
    const current = byPattern.get(key) || {
      action: row.action,
      platform: row.platform,
      media_source: row.media_source,
      volume_tier: row.volume_tier,
      reason_code: row.reason_code,
      stage: row.stage || '未知',
      total: 0,
      adopted: 0,
      success: 0,
      risk: 0,
      manual_review_count: 0
    };
    current.total += 1;
    if (row.is_adopted) {
      current.adopted += 1;
    }
    if (statusOutcomeBucket(row) === 'success') {
      current.success += 1;
    }
    if (statusOutcomeBucket(row) === 'risk') {
      current.risk += 1;
    }
    if (String(row.validation_result || '').trim()) {
      current.manual_review_count += 1;
    }
    byPattern.set(key, current);
  }

  const topPatterns = Array.from(byPattern.values())
    .sort((a, b) => b.total - a.total || b.success - a.success || a.risk - b.risk)
    .slice(0, 12);

  const representative = {
    success_samples: reviewedRows
      .filter((row) => statusOutcomeBucket(row) === 'success')
      .slice(0, 5)
      .map((row) => ({
        recommendation_id: row.id,
        keyword: row.keyword,
        action: row.action,
        media_source: row.media_source,
        stage: row.stage,
        execution_status: row.execution_status,
        validation_result: String(row.validation_result || '').slice(0, 120)
      })),
    risk_samples: reviewedRows
      .filter((row) => statusOutcomeBucket(row) === 'risk')
      .slice(0, 5)
      .map((row) => ({
        recommendation_id: row.id,
        keyword: row.keyword,
        action: row.action,
        media_source: row.media_source,
        stage: row.stage,
        execution_status: row.execution_status,
        validation_result: String(row.validation_result || '').slice(0, 120)
      })),
    manual_review_samples: reviewedRows
      .filter((row) => String(row.validation_result || '').trim())
      .slice(0, 8)
      .map((row) => ({
        recommendation_id: row.id,
        keyword: row.keyword,
        action: row.action,
        execution_status: row.execution_status,
        is_adopted: row.is_adopted,
        validation_result: String(row.validation_result || '').slice(0, 160)
      }))
  };

  return {
    total_rows: rows.length,
    reviewed_rows: reviewedRows.length,
    adopted_rows: reviewedRows.filter((row) => row.is_adopted).length,
    success_rows: reviewedRows.filter((row) => statusOutcomeBucket(row) === 'success').length,
    risk_rows: reviewedRows.filter((row) => statusOutcomeBucket(row) === 'risk').length,
    execution_status_counts: Object.fromEntries(byExecutionStatus),
    top_patterns: topPatterns,
    representative
  };
}

function buildFallbackSkillMarkdown(
  stats: Record<string, unknown>,
  rows: BudgetFeedbackDatasetRow[],
  fromDate: string | null,
  toDate: string | null
): string {
  const topPatterns = Array.isArray(stats.top_patterns)
    ? (stats.top_patterns as Array<Record<string, unknown>>).slice(0, 5)
    : [];
  const manualSamples = Array.isArray((stats.representative as Record<string, unknown>)?.manual_review_samples)
    ? ((stats.representative as Record<string, unknown>).manual_review_samples as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const totalRows = Number(stats.total_rows || rows.length || 0);
  const reviewedRows = Number(stats.reviewed_rows || 0);
  const successRows = Number(stats.success_rows || 0);
  const riskRows = Number(stats.risk_rows || 0);

  const successLines = topPatterns
    .filter((item) => Number(item.success || 0) > 0)
    .slice(0, 3)
    .map(
      (item) =>
        `- 动作 ${item.action} / 平台 ${item.platform} / 媒体 ${item.media_source} / 阶段 ${item.stage}：总样本 ${item.total}，成功 ${item.success}，采纳 ${item.adopted}。`
    );
  const riskLines = topPatterns
    .filter((item) => Number(item.risk || 0) > 0)
    .slice(0, 3)
    .map(
      (item) =>
        `- 动作 ${item.action} / 平台 ${item.platform} / 媒体 ${item.media_source} / 原因 ${item.reason_code}：总样本 ${item.total}，风险 ${item.risk}，人工批复 ${item.manual_review_count}。`
    );
  const manualLines = manualSamples.map(
    (item) =>
      `- #${item.recommendation_id} ${item.keyword}：${String(item.validation_result || '无人工批复').replace(/\s+/g, ' ').trim()}`
  );

  return [
    '# 预算反馈经验',
    '',
    '## 适用范围',
    `- 来源：${SOURCE_TYPE}`,
    `- 数据时间：${fromDate || '未知'} 到 ${toDate || '未知'}`,
    `- 数据规模：总样本 ${totalRows}，已回读反馈 ${reviewedRows}，成功 ${successRows}，风险 ${riskRows}`,
    '',
    '## 高成功模式',
    ...(successLines.length ? successLines : ['- 当前样本不足，暂未形成稳定高成功模式。']),
    '',
    '## 高风险/低采纳模式',
    ...(riskLines.length ? riskLines : ['- 当前样本不足，暂未形成稳定高风险模式。']),
    '',
    '## 人工批复中反复出现的偏好/禁忌',
    ...(manualLines.length ? manualLines : ['- 当前还没有足够的人工批复样本。']),
    '',
    '## 后续预算分析附加提示',
    '- 输出预算解释时，优先引用历史上被采纳且效果符合预期的动作组合。',
    '- 对历史上多次出现“不执行 / 暂缓 / 已回滚”的模式，提高风险提示权重。',
    '- 若人工批复反复提到排期、素材、活动周期或库存限制，应把这些限制写入解释摘要，而不是只看 eCPI。'
  ].join('\n');
}

function extractTextContent(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return '';
  }
  return raw
    .map((item) => (item && typeof item === 'object' ? String((item as Record<string, unknown>).text ?? '') : ''))
    .join('\n');
}

async function generateBudgetFeedbackSkillMarkdownWithQwen(input: {
  stats: Record<string, unknown>;
  fromDate: string | null;
  toDate: string | null;
}): Promise<{ markdown: string; model: string; promptHash: string }> {
  const fallbackPrompt = buildFallbackSkillMarkdown(input.stats, [], input.fromDate, input.toDate);
  const promptPayload = {
    task: 'budget_feedback_skills_markdown',
    locale: 'zh-CN',
    required_sections: ['适用范围', '高成功模式', '高风险/低采纳模式', '人工批复中反复出现的偏好/禁忌', '后续预算分析附加提示'],
    stats: input.stats,
    from_date: input.fromDate,
    to_date: input.toDate
  };
  const promptText = JSON.stringify(promptPayload);
  const promptHash = md5Hex(promptText);

  if (!env.qwen.baseUrl || !env.qwen.apiKey) {
    return {
      markdown: fallbackPrompt,
      model: 'fallback',
      promptHash
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.qwen.timeoutMs);
  try {
    const response = await fetch(`${env.qwen.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${env.qwen.apiKey}`
      },
      body: JSON.stringify({
        model: env.qwen.model,
        temperature: 0.2,
        max_tokens: env.qwen.maxTokens,
        messages: [
          {
            role: 'system',
            content:
              '你是增长投放经验沉淀助手。请只输出 Markdown，必须包含：适用范围、高成功模式、高风险/低采纳模式、人工批复中反复出现的偏好/禁忌、后续预算分析附加提示。内容要简洁、可直接作为后续提示词附加说明。'
          },
          {
            role: 'user',
            content: promptText
          }
        ]
      }),
      signal: controller.signal
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return {
        markdown: fallbackPrompt,
        model: env.qwen.model,
        promptHash
      };
    }
    const choices = Array.isArray(json.choices) ? json.choices : [];
    const message = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
    const markdown = extractTextContent(message?.content).trim();
    return {
      markdown: markdown || fallbackPrompt,
      model: env.qwen.model,
      promptHash
    };
  } catch {
    return {
      markdown: fallbackPrompt,
      model: env.qwen.model,
      promptHash
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshBudgetFeedbackSkills(
  logger?: LoggerLike
): Promise<FeedbackSkillVersionRecord | null> {
  const rows = await queryBudgetFeedbackDatasetRows({});
  const reviewedRows = rows.filter(
    (row) =>
      String(row.execution_status || '').trim() ||
      row.is_adopted === true ||
      String(row.validation_result || '').trim() ||
      row.feedback_synced_at
  );
  if (reviewedRows.length === 0) {
    return null;
  }
  const dates = reviewedRows.map((row) => row.report_date).filter(Boolean).sort();
  const fromDate = dates[0] || null;
  const toDate = dates[dates.length - 1] || null;
  const stats = summarizeBudgetFeedbackStats(reviewedRows);
  const generated = await generateBudgetFeedbackSkillMarkdownWithQwen({
    stats,
    fromDate,
    toDate
  });
  const saved = await insertFeedbackSkillVersion({
    scope: BUDGET_SCOPE,
    source_type: SOURCE_TYPE,
    from_date: fromDate,
    to_date: toDate,
    dataset_row_count: reviewedRows.length,
    stats_json: stats,
    skills_markdown: generated.markdown,
    model: generated.model,
    prompt_hash: generated.promptHash
  });
  logger?.info?.('budget_feedback_skill_version_created', {
    id: saved.id,
    dataset_row_count: saved.dataset_row_count,
    created_at: saved.created_at
  });
  latestSkillPromptCache = {
    key: `${BUDGET_SCOPE}:${SOURCE_TYPE}`,
    expiresAt: Date.now() + SKILL_PROMPT_CACHE_TTL_MS,
    value: String(saved.skills_markdown || '').trim()
  };
  return saved;
}

function feedbackChangedComparedWithExisting(
  incoming: {
    recommendation_type: RecommendationType;
    recommendation_id: number;
    execution_status: string | null;
    is_adopted: boolean;
    validation_result: string | null;
    record_id: string;
    bitable_last_modified_time: string | null;
  },
  existing: RecommendationExecutionFeedbackRecord | undefined
): boolean {
  if (!existing) {
    return true;
  }
  return (
    String(existing.execution_status || '') !== String(incoming.execution_status || '') ||
    existing.is_adopted !== incoming.is_adopted ||
    String(existing.validation_result || '') !== String(incoming.validation_result || '') ||
    String(existing.record_id || '') !== String(incoming.record_id || '')
  );
}

export async function runBitableFeedbackSync(
  sourceType: BitableExportSourceType,
  logger?: LoggerLike,
  logSource = 'system.bitable_feedback_sync'
): Promise<BitableFeedbackSyncResult> {
  if (sourceType !== SOURCE_TYPE) {
    throw new Error('unsupported_bitable_source_type');
  }
  await ensureRecommendationFeedbackStorage();
  const syncedAt = new Date().toISOString();

  try {
    const config = await getBitableExportConfig(sourceType);
    const archivedTables = await listBitableExportDailyTables(sourceType);
    const tableTargetMap = new Map<string, { table_id: string; report_date: string }>();
    for (const row of archivedTables) {
      const tableId = String(row.table_id || '').trim();
      if (!tableId || tableTargetMap.has(tableId)) {
        continue;
      }
      tableTargetMap.set(tableId, {
        table_id: tableId,
        report_date: row.report_date
      });
    }
    const allTableTargets = Array.from(tableTargetMap.values()).sort((left, right) => {
      const byDate = String(right.report_date || '').localeCompare(String(left.report_date || ''));
      if (byDate !== 0) {
        return byDate;
      }
      return String(left.table_id || '').localeCompare(String(right.table_id || ''));
    });

    if (allTableTargets.length === 0) {
      const legacyTableId = String(config?.target_table_id || '').trim();
      if (legacyTableId) {
        allTableTargets.push({
          table_id: legacyTableId,
          report_date: String(config?.last_synced_at || '').slice(0, 10) || ''
        });
      }
    }

    if (allTableTargets.length === 0) {
      throw new Error('bitable_target_table_not_ready');
    }
    const appToken = String(env.feishuBitableAppToken || '').trim();
    if (!appToken) {
      throw new Error('feishu_bitable_app_token_missing');
    }

    const tableTargets = allTableTargets;

    const readPhase = await withBitableSourceIOLock(sourceType, async () => {
      const refsByTableId = new Map<string, Awaited<ReturnType<typeof listBitableExportRecordRefsByTable>>>();
      const candidateKeyMap = new Map<string, { recommendation_type: RecommendationType; recommendation_id: number }>();

      for (const tableTarget of tableTargets) {
        const refs = await listBitableExportRecordRefsByTable(sourceType, tableTarget.table_id);
        refsByTableId.set(tableTarget.table_id, refs);
        for (const ref of refs) {
          if (!ref.recommendation_type || !Number.isFinite(Number(ref.recommendation_id))) {
            continue;
          }
          const recommendationType = ref.recommendation_type as RecommendationType;
          const recommendationId = Number(ref.recommendation_id);
          candidateKeyMap.set(`${recommendationType}:${recommendationId}`, {
            recommendation_type: recommendationType,
            recommendation_id: recommendationId
          });
        }
      }

      const candidateKeys = Array.from(candidateKeyMap.values());
      const sevenDayLaterLookupRows = await loadSevenDayLaterLookupRowsForRecommendations(candidateKeys);
      const sevenDayLaterMap = await querySevenDayLaterDataForLookupRows(sevenDayLaterLookupRows);
      const existingFeedbacks = await listRecommendationExecutionFeedbacksByRecommendations(sourceType, candidateKeys);
      const existingMap = new Map(
        existingFeedbacks.map((row) => [`${row.recommendation_type}:${row.recommendation_id}`, row])
      );

      const upsertRows: Array<{
        source_type: BitableExportSourceType;
        recommendation_type: RecommendationType;
        recommendation_id: number;
        report_date: string;
        table_id: string;
        record_id: string;
        sync_key: string;
        execution_status: string | null;
        is_adopted: boolean;
        validation_result: string | null;
        raw_fields_json: unknown;
        bitable_last_modified_time: string | null;
        synced_at: string;
      }> = [];
      const pendingSevenDayUpdates = new Map<string, Array<{ record_id: string; value: string }>>();
      let skippedCount = 0;
      let scannedRecordCount = 0;
      let feedbackChanged = false;

      for (const tableTarget of tableTargets) {
        const refs = refsByTableId.get(tableTarget.table_id) || [];
        const refsByRecordId = new Map(refs.map((ref) => [ref.record_id, ref]));
        const records = await listBitableRecordsForFeedback(appToken, tableTarget.table_id);

        for (const record of records) {
          scannedRecordCount += 1;
          const ref = refsByRecordId.get(record.record_id);
          if (!ref?.recommendation_type || !Number.isFinite(Number(ref.recommendation_id))) {
            skippedCount += 1;
            continue;
          }
          const executionStatus = parseSingleSelectValue(record.fields[EXECUTION_STATUS_FIELD_LABEL]) || null;
          const validationResult = String(record.fields[MANUAL_REVIEW_FIELD_LABEL] ?? '').trim() || null;
          const isAdopted = parseCheckboxValue(record.fields[ADOPTED_FIELD_LABEL]);
          const sevenDayLaterData =
            sevenDayLaterMap.get(`${ref.recommendation_type}:${Number(ref.recommendation_id)}`) || '';
          const currentSevenDayLaterData = String(record.fields[SEVEN_DAY_LATER_FIELD_LABEL] ?? '').trim();
          if (sevenDayLaterData && sevenDayLaterData !== currentSevenDayLaterData) {
            const updates = pendingSevenDayUpdates.get(tableTarget.table_id) || [];
            updates.push({
              record_id: record.record_id,
              value: sevenDayLaterData
            });
            pendingSevenDayUpdates.set(tableTarget.table_id, updates);
          }
          const bitableLastModifiedTime =
            record.last_modified_time && Number.isFinite(record.last_modified_time)
              ? new Date(record.last_modified_time).toISOString()
              : null;
          const row = {
            source_type: sourceType,
            recommendation_type: ref.recommendation_type,
            recommendation_id: Number(ref.recommendation_id),
            report_date: ref.report_date,
            table_id: ref.table_id,
            record_id: record.record_id,
            sync_key: ref.sync_key,
            execution_status: executionStatus,
            is_adopted: isAdopted,
            validation_result: validationResult,
            raw_fields_json: {
              [EXECUTION_STATUS_FIELD_LABEL]: record.fields[EXECUTION_STATUS_FIELD_LABEL] ?? null,
              [ADOPTED_FIELD_LABEL]: record.fields[ADOPTED_FIELD_LABEL] ?? null,
              [MANUAL_REVIEW_FIELD_LABEL]: record.fields[MANUAL_REVIEW_FIELD_LABEL] ?? null
            },
            bitable_last_modified_time: bitableLastModifiedTime,
            synced_at: syncedAt
          };
          const existing = existingMap.get(`${row.recommendation_type}:${row.recommendation_id}`);
          if (!shouldUpsertFeedbackRow(row, existing)) {
            continue;
          }
          feedbackChanged = true;
          upsertRows.push(row);
        }
      }

      return {
        table_count: allTableTargets.length,
        scanned_table_count: tableTargets.length,
        synced_table_ids: tableTargets.map((row) => row.table_id),
        scanned_record_count: scannedRecordCount,
        skipped_count: skippedCount,
        feedback_changed: feedbackChanged,
        upsert_rows: upsertRows,
        pending_seven_day_updates: pendingSevenDayUpdates
      };
    });

    if (readPhase.upsert_rows.length > 0) {
      await upsertRecommendationExecutionFeedbacks(readPhase.upsert_rows);
    }
    const sevenDayDataUpdatedCount = await applySevenDayLaterBackfill(
      sourceType,
      appToken,
      readPhase.pending_seven_day_updates,
      logger
    );

    let latestSkill: FeedbackSkillVersionRecord | null = null;
    if (readPhase.feedback_changed && readPhase.upsert_rows.some((row) => row.recommendation_type === 'budget')) {
      latestSkill = await refreshBudgetFeedbackSkills(logger);
    } else {
      latestSkill = await getLatestFeedbackSkillVersion(BUDGET_SCOPE, SOURCE_TYPE);
    }

    const result = {
      source_type: sourceType,
      table_id: allTableTargets[0]?.table_id || '',
      table_count: readPhase.table_count,
      scanned_table_count: readPhase.scanned_table_count,
      synced_table_ids: readPhase.synced_table_ids,
      scanned_record_count: readPhase.scanned_record_count,
      synced_count: readPhase.upsert_rows.length,
      skipped_count: readPhase.skipped_count,
      seven_day_data_updated_count: sevenDayDataUpdatedCount,
      feedback_changed: readPhase.feedback_changed,
      synced_at: syncedAt,
      latest_skill_updated_at: latestSkill?.created_at ?? null,
      latest_skill_dataset_row_count: latestSkill?.dataset_row_count ?? 0
    } satisfies BitableFeedbackSyncResult;

    await writeOperationLog(
      {
        source: logSource,
        action: 'bitable_feedback_sync',
        target_type: 'bitable_feedback',
        target_key: sourceType,
        status: 'success',
        summary: `执行反馈回读完成：${sourceType}`,
        detail_json: result
      },
      logger
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeOperationLog(
      {
        source: logSource,
        action: 'bitable_feedback_sync',
        target_type: 'bitable_feedback',
        target_key: sourceType,
        status: 'failed',
        summary: `执行反馈回读失败：${sourceType}`,
        detail_json: {
          source_type: sourceType,
          synced_at: syncedAt,
          error: message
        }
      },
      logger
    );
    throw error;
  }
}

export async function getBitableFeedbackSyncSnapshot(
  sourceType: BitableExportSourceType
): Promise<BitableFeedbackSyncSnapshot> {
  const [log, latestSkill] = await Promise.all([
    getLatestOperationLog({ action: 'bitable_feedback_sync', targetKey: sourceType }),
    getLatestFeedbackSkillVersion(BUDGET_SCOPE, sourceType)
  ]);
  const detail = (log?.detail_json || {}) as Record<string, unknown>;
  return {
    last_status: String(log?.status || 'idle'),
    last_synced_at: String(detail.synced_at || '') || log?.created_at || null,
    last_record_count: Number(detail.synced_count || 0),
    last_error: String(detail.error || '') || null,
    latest_skill_updated_at: latestSkill?.created_at ?? null
  };
}

export async function getLatestBudgetFeedbackSkill(): Promise<FeedbackSkillVersionRecord | null> {
  return getLatestFeedbackSkillVersion(BUDGET_SCOPE, SOURCE_TYPE);
}

export async function loadLatestFeedbackSkillPrompt(scope: string): Promise<string> {
  if (scope !== BUDGET_SCOPE) {
    return '';
  }
  const cacheKey = `${scope}:${SOURCE_TYPE}`;
  const now = Date.now();
  if (latestSkillPromptCache && latestSkillPromptCache.key === cacheKey && latestSkillPromptCache.expiresAt > now) {
    return latestSkillPromptCache.value;
  }
  const latest = await getLatestFeedbackSkillVersion(scope, SOURCE_TYPE);
  const value = String(latest?.skills_markdown || '').trim();
  latestSkillPromptCache = {
    key: cacheKey,
    expiresAt: now + SKILL_PROMPT_CACHE_TTL_MS,
    value
  };
  return value;
}
