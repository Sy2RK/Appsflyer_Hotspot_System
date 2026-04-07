import { env } from '../config/env.js';
import type {
  BitableExportConfigRecord,
  BitableExportDailyTableRecord,
  BitableExportSourceType,
  RecommendationType
} from '../types/models.js';
import { pgQuery } from './postgres.js';
import {
  ensureBudgetRecommendationsSchema,
  deleteBitableExportRecordRefsByRecordIds,
  getBitableExportConfig,
  getBitableExportDailyTable,
  listBitableExportConfigs,
  listBitableExportDailyTables,
  listBitableExportRecordRefs,
  listRecommendationExecutionFeedbacksByRecommendations,
  upsertBitableExportConfig,
  upsertBitableExportDailyTable,
  upsertBitableExportRecordRefs,
  updateBitableExportSyncResult
} from './repositories.js';
import { getFeishuTenantAccessToken, sendFeishuInteractiveCardNotification, type AlertChannelConfig } from './notifier.js';
import { getPreviousDateString } from './businessDate.js';
import {
  getBitableFeedbackSyncSnapshot,
  runBitableFeedbackSync,
  withBitableSourceIOLock
} from './recommendationFeedback.js';
import {
  querySevenDayLaterDataForLookupRows,
  SEVEN_DAY_LATER_FIELD_LABEL
} from './sevenDayLaterData.js';

interface LoggerLike {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

type BitableFieldValueType = 'text' | 'number' | 'datetime' | 'checkbox' | 'single_select';

export interface BitableFieldDefinition {
  key: string;
  label: string;
  value_type: BitableFieldValueType;
  default_selected: boolean;
  system?: boolean;
  date_only?: boolean;
  options?: string[];
}

interface BitableFieldRecord {
  field_id: string;
  field_name: string;
  type: number;
}

interface BitableTableRecord {
  table_id: string;
  name: string;
}

interface BitableRecordItem {
  record_id: string;
  fields: Record<string, unknown>;
}

class BitableBatchCreateError extends Error {
  createdRecordIds: string[];

  constructor(message: string, createdRecordIds: string[]) {
    super(message);
    this.name = 'BitableBatchCreateError';
    this.createdRecordIds = createdRecordIds;
  }
}

interface BitableRecordRef {
  record_id: string;
  snapshot_id: string;
  sync_key: string;
  recommendation_type: RecommendationType | null;
  recommendation_id: number | null;
  validation_result: string;
  is_adopted: boolean;
}

interface BitableSourceSnapshot {
  source_type: BitableExportSourceType;
  label: string;
  fields: BitableFieldDefinition[];
  config: BitableExportConfigRecord;
  table_url: string;
  latest_table_url: string;
  target_table_hint: string;
  recent_tables: Array<{
    report_date: string;
    table_id: string;
    table_name: string;
    table_url: string;
    last_record_count: number;
    last_synced_at: string | null;
  }>;
  feedback_sync: {
    last_status: string;
    last_synced_at: string | null;
    last_record_count: number;
    last_error: string | null;
    latest_skill_updated_at: string | null;
  };
}

interface DeliveryActionRow {
  recommendation_type: RecommendationType;
  recommendation_id: number;
  app_key: string;
  serial_no: number;
  report_date: string;
  platform_raw: string;
  product_name: string;
  platform: string;
  media_source: string;
  item_type: string;
  item_name: string;
  campaign: string;
  adset: string;
  match_type: string;
  stage: string;
  primary_metric: string;
  current_value: string;
  target_value: string;
  cost_reference: number;
  volume_reference: string;
  seven_day_later_data: string;
  action: string;
  execution_status: string;
  validation_result: string;
  is_adopted: boolean;
  reason: string;
}

export interface BitableExportRunResult {
  source_type: BitableExportSourceType;
  label: string;
  report_date: string;
  table_id: string;
  table_name: string;
  table_name_prefix: string;
  table_url: string;
  selected_fields: string[];
  deleted_count: number;
  record_count: number;
  export_status: 'success' | 'partial_success' | 'failed';
  export_error?: string | null;
  breakdown: {
    campaign_actions: number;
    asa_actions: number;
  };
  notify: {
    ok: boolean;
    status?: number;
    error?: string;
    render_mode?: string;
  };
}

export interface BitableExportRunOptions {
  includeAllStatuses?: boolean;
  notify?: boolean;
  seedFeedbackSync?: boolean;
}

export interface ScheduledBitableExportRunSummary {
  completed: boolean;
  skipped: boolean;
  success_count: number;
  partial_success_count: number;
  failed_count: number;
  results: BitableExportRunResult[];
  error?: string;
}

export interface BitableHistoricalBackfillResult {
  source_type: BitableExportSourceType;
  processed_dates: string[];
  success_dates: string[];
  failed_dates: Array<{
    report_date: string;
    error: string;
  }>;
  results: BitableExportRunResult[];
}

const SOURCE_TYPE: BitableExportSourceType = 'delivery_actions';
const SOURCE_LABEL = '投放执行表';
const TARGET_TABLE_HINT = '在同一个飞书 Base 内按数据日期新增执行表，同日重跑只刷新当天表，历史日期自动留档。';
const ACTION_TABLE_NAME = String(env.feishuBitableActionTableName || '投放执行表').trim() || '投放执行表';
const RECENT_DAILY_TABLE_LIMIT = 7;
const MANUAL_REVIEW_FIELD_LABEL = '人工批复';
const LEGACY_MANUAL_REVIEW_FIELD_LABEL = '验证结果';
const ADOPTED_FIELD_LABEL = '是否采纳';
const PRIMARY_SERIAL_FIELD_LABEL = '多行文本';
const EXECUTION_STATUS_FIELD_LABEL = '执行状态';
const FEISHU_CHECKBOX_FIELD_TYPE = 7;
const FEISHU_SINGLE_SELECT_FIELD_TYPE = 3;
const EXECUTION_STATUS_OPTIONS = [
  '待处理',
  '已接收待排期',
  '执行中',
  '已完成待验证',
  '已完成-效果符合预期',
  '已完成-效果一般',
  '已完成-效果不及预期',
  '观察中',
  '暂缓执行',
  '不执行',
  '无法执行',
  '重复项已合并',
  '已回滚',
  '其他待确认'
];
const EXECUTION_STATUS_DEFAULT = EXECUTION_STATUS_OPTIONS[0];
const EXECUTION_STATUS_FALLBACK = EXECUTION_STATUS_OPTIONS[EXECUTION_STATUS_OPTIONS.length - 1];
const EXECUTION_STATUS_OPTION_SET = new Set(EXECUTION_STATUS_OPTIONS);
const OBSOLETE_FIELD_LABELS = [
  '序号',
  '同步报告日期',
  '同步键',
  '同步快照ID',
  '调整幅度(%)',
  '最近更新时间'
];
const LEGACY_CONFIG_CONFLICT_ERROR =
  'legacy_config_conflict: 原 Pull 明细表 与 ASA Raw 表配置不一致，已停止自动迁移，请在页面重新确认 Chat ID 与启用状态。';

const SYSTEM_FIELDS: BitableFieldDefinition[] = [
  { key: '_synced_at', label: '同步时间', value_type: 'datetime', default_selected: true, system: true }
];

const ACTION_FIELDS: BitableFieldDefinition[] = [
  { key: 'report_date', label: '报告日期', value_type: 'datetime', date_only: true, default_selected: true },
  { key: 'product_name', label: '产品名', value_type: 'text', default_selected: true },
  { key: 'platform', label: '平台', value_type: 'text', default_selected: true },
  { key: 'media_source', label: '媒体源', value_type: 'text', default_selected: true },
  { key: 'item_type', label: '投放项类型', value_type: 'text', default_selected: true },
  { key: 'item_name', label: '投放项名称', value_type: 'text', default_selected: true },
  { key: 'campaign', label: '广告系列', value_type: 'text', default_selected: true },
  { key: 'adset', label: '广告组', value_type: 'text', default_selected: true },
  { key: 'stage', label: '阶段', value_type: 'text', default_selected: true },
  { key: 'primary_metric', label: '主指标', value_type: 'text', default_selected: true },
  { key: 'current_value', label: '当前表现', value_type: 'text', default_selected: true },
  { key: 'target_value', label: '目标表现', value_type: 'text', default_selected: true },
  { key: 'cost_reference', label: '成本参考', value_type: 'number', default_selected: true },
  { key: 'volume_reference', label: '量级参考', value_type: 'text', default_selected: true },
  { key: 'seven_day_later_data', label: SEVEN_DAY_LATER_FIELD_LABEL, value_type: 'text', default_selected: true },
  { key: 'action', label: '建议动作', value_type: 'text', default_selected: true },
  {
    key: 'execution_status',
    label: EXECUTION_STATUS_FIELD_LABEL,
    value_type: 'single_select',
    default_selected: true,
    options: EXECUTION_STATUS_OPTIONS
  },
  { key: 'is_adopted', label: ADOPTED_FIELD_LABEL, value_type: 'checkbox', default_selected: true },
  { key: 'validation_result', label: MANUAL_REVIEW_FIELD_LABEL, value_type: 'text', default_selected: true },
  { key: 'reason', label: '建议理由', value_type: 'text', default_selected: true }
];

const TRAILING_ACTION_FIELD_SEQUENCE = [
  SEVEN_DAY_LATER_FIELD_LABEL,
  '建议动作',
  '建议理由',
  EXECUTION_STATUS_FIELD_LABEL,
  ADOPTED_FIELD_LABEL,
  MANUAL_REVIEW_FIELD_LABEL
];

const DEFAULT_SELECTED_FIELDS: string[] = ACTION_FIELDS.filter((field) => field.default_selected).map((field) => field.key);

function fieldCatalog(): BitableFieldDefinition[] {
  return [...SYSTEM_FIELDS, ...ACTION_FIELDS];
}

function defaultConfig(): BitableExportConfigRecord {
  return {
    id: 0,
    source_type: SOURCE_TYPE,
    enabled: true,
    target_table_id: null,
    target_table_name: null,
    table_name_prefix: ACTION_TABLE_NAME,
    chat_id: null,
    selected_fields: DEFAULT_SELECTED_FIELDS,
    last_status: 'idle',
    last_error: null,
    last_synced_at: null,
    last_record_count: 0,
    created_at: '',
    updated_at: ''
  };
}

function mergeConfig(dbConfig?: BitableExportConfigRecord | null): BitableExportConfigRecord {
  const base = defaultConfig();
  if (!dbConfig) {
    return base;
  }
  return {
    ...base,
    ...dbConfig,
    selected_fields: base.selected_fields,
    target_table_id: dbConfig.target_table_id || base.target_table_id,
    target_table_name: dbConfig.target_table_name || base.target_table_name,
    table_name_prefix: normalizeTableNamePrefix(dbConfig.table_name_prefix || base.table_name_prefix)
  };
}

function normalizeTableNamePrefix(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ') || ACTION_TABLE_NAME;
}

function buildDailyTableName(prefix: string, reportDate: string): string {
  return `${normalizeTableNamePrefix(prefix)}_${String(reportDate || '').trim()}`;
}

function normalizeChatId(value: string | null | undefined): string {
  return String(value || '').trim();
}

function hasLegacyConfigConflict(
  legacyPull: BitableExportConfigRecord | undefined,
  legacyAsa: BitableExportConfigRecord | undefined
): boolean {
  if (!legacyPull || !legacyAsa) {
    return false;
  }
  return normalizeChatId(legacyPull.chat_id) !== normalizeChatId(legacyAsa.chat_id) || Boolean(legacyPull.enabled) !== Boolean(legacyAsa.enabled);
}

function baseTableUrl(tableId: string): string {
  const baseUrl = String(env.feishuBitableBaseUrl || '').trim().replace(/\/+$/, '');
  const appToken = String(env.feishuBitableAppToken || '').trim();
  if (!baseUrl || !appToken || !tableId) {
    return '';
  }
  const params = new URLSearchParams({ table: tableId });
  return `${baseUrl}/${appToken}?${params.toString()}`;
}

function mapDailyTableSnapshot(row: BitableExportDailyTableRecord): BitableSourceSnapshot['recent_tables'][number] {
  return {
    report_date: row.report_date,
    table_id: row.table_id,
    table_name: row.table_name,
    table_url: baseTableUrl(row.table_id),
    last_record_count: Number(row.last_record_count || 0),
    last_synced_at: row.last_synced_at
  };
}

function formatLocalDateTime(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: env.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((item) => item.type === type)?.value ?? '00';
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}:${pick('second')}`;
}

function parseToEpochMillis(value: string, dateOnly = false): number | null {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  if (dateOnly) {
    const parsed = new Date(`${text}T00:00:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(`${normalized}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function compactFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function displayValueForField(field: BitableFieldDefinition, value: unknown): unknown {
  if ((field.key === 'campaign' || field.key === 'adset') && String(value ?? '').trim() === '') {
    return '不适用';
  }
  return value;
}

function fieldTypeToFeishu(field: BitableFieldDefinition): { type: number; property?: Record<string, unknown> } {
  if (field.value_type === 'number') {
    return { type: 2 };
  }
  if (field.value_type === 'datetime') {
    return { type: 5 };
  }
  if (field.value_type === 'single_select') {
    return {
      type: FEISHU_SINGLE_SELECT_FIELD_TYPE,
      property: {
        options: (field.options || []).map((name, index) => ({
          name,
          color: index
        }))
      }
    };
  }
  if (field.value_type === 'checkbox') {
    return { type: FEISHU_CHECKBOX_FIELD_TYPE };
  }
  return { type: 1 };
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

function normalizeExecutionStatus(value: unknown): string {
  const normalized = parseSingleSelectValue(value);
  if (!normalized) {
    return '';
  }
  return EXECUTION_STATUS_OPTION_SET.has(normalized) ? normalized : EXECUTION_STATUS_FALLBACK;
}

function serializeFieldValue(field: BitableFieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  if (field.value_type === 'number') {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  if (field.value_type === 'datetime') {
    const millis = parseToEpochMillis(String(value), field.date_only === true);
    return millis === null ? undefined : millis;
  }
  if (field.value_type === 'checkbox') {
    return value === true;
  }
  if (field.value_type === 'single_select') {
    const normalized = field.key === 'execution_status' ? normalizeExecutionStatus(value) : parseSingleSelectValue(value);
    return normalized || undefined;
  }
  return String(value);
}

function parseCheckboxValue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

async function feishuJsonRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string | number | undefined>
): Promise<T> {
  const tokenResult = await getFeishuTenantAccessToken();
  if (!tokenResult.ok) {
    throw new Error(tokenResult.error);
  }

  const queryString = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') {
      queryString.set(key, String(value));
    }
  });
  const url = `https://open.feishu.cn/open-apis${path}${queryString.size > 0 ? `?${queryString.toString()}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tokenResult.accessToken}`,
      'content-type': 'application/json'
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {})
  });
  const json = (await res.json()) as {
    code?: number;
    msg?: string;
    data?: T;
  };
  if (!res.ok || Number(json.code ?? 0) !== 0 || !json.data) {
    throw new Error(`Feishu bitable request failed: status=${res.status} code=${String(json.code ?? '')} msg=${String(json.msg ?? '')}`);
  }
  return json.data;
}

async function listBitableTables(appToken: string): Promise<BitableTableRecord[]> {
  const items: BitableTableRecord[] = [];
  let pageToken = '';
  let hasMore = true;
  while (hasMore) {
    const data = await feishuJsonRequest<{ items?: Array<{ table_id?: string; name?: string }>; has_more?: boolean; page_token?: string }>(
      'GET',
      `/bitable/v1/apps/${appToken}/tables`,
      undefined,
      { page_size: 100, page_token: pageToken || undefined }
    );
    (data.items || []).forEach((item) => {
      if (item.table_id && item.name) {
        items.push({ table_id: item.table_id, name: item.name });
      }
    });
    hasMore = data.has_more === true;
    pageToken = String(data.page_token || '');
    if (!pageToken) {
      break;
    }
  }
  return items;
}

async function createBitableTable(appToken: string, tableName: string): Promise<BitableTableRecord> {
  const data = await feishuJsonRequest<{ table_id?: string; name?: string }>(
    'POST',
    `/bitable/v1/apps/${appToken}/tables`,
    {
      table: {
        name: tableName
      }
    }
  );
  if (!data.table_id) {
    throw new Error('Feishu execution table create succeeded without table_id');
  }
  return {
    table_id: data.table_id,
    name: data.name || tableName
  };
}

async function listBitableFields(appToken: string, tableId: string): Promise<BitableFieldRecord[]> {
  const items: BitableFieldRecord[] = [];
  let pageToken = '';
  let hasMore = true;
  while (hasMore) {
    const data = await feishuJsonRequest<{ items?: Array<{ field_id?: string; field_name?: string; type?: number }>; has_more?: boolean; page_token?: string }>(
      'GET',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
      undefined,
      { page_size: 500, page_token: pageToken || undefined }
    );
    (data.items || []).forEach((item) => {
      if (item.field_id && item.field_name) {
        items.push({ field_id: item.field_id, field_name: item.field_name, type: Number(item.type || 0) });
      }
    });
    hasMore = data.has_more === true;
    pageToken = String(data.page_token || '');
    if (!pageToken) {
      break;
    }
  }
  return items;
}

async function createBitableField(appToken: string, tableId: string, field: BitableFieldDefinition): Promise<void> {
  const fieldSpec = fieldTypeToFeishu(field);
  await feishuJsonRequest(
    'POST',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    compactFields({
      field_name: field.label,
      type: fieldSpec.type,
      property: fieldSpec.property
    })
  );
}

async function updateBitableField(
  appToken: string,
  tableId: string,
  fieldId: string,
  field: BitableFieldDefinition
): Promise<void> {
  const fieldSpec = fieldTypeToFeishu(field);
  await feishuJsonRequest(
    'PUT',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`,
    compactFields({
      field_name: field.label,
      type: fieldSpec.type,
      property: fieldSpec.property
    })
  );
}

async function deleteBitableField(appToken: string, tableId: string, fieldId: string): Promise<void> {
  await feishuJsonRequest('DELETE', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`);
}

async function updateBitableRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
  await feishuJsonRequest(
    'PUT',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    {
      fields
    }
  );
}

function isFeishuFieldNameDuplicatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('FieldNameDuplicated') || message.includes('code=1254014');
}

function fieldDefinitionForLabel(label: string): BitableFieldDefinition | null {
  return fieldCatalog().find((field) => field.label === label) ?? null;
}

async function listBitableRecords(appToken: string, tableId: string): Promise<BitableRecordItem[]> {
  const items: BitableRecordItem[] = [];
  let pageToken = '';
  let hasMore = true;
  while (hasMore) {
    const data = await feishuJsonRequest<{ items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>; has_more?: boolean; page_token?: string }>(
      'GET',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      undefined,
      { page_size: 500, page_token: pageToken || undefined }
    );
    (data.items || []).forEach((item) => {
      if (item.record_id) {
        items.push({ record_id: item.record_id, fields: item.fields || {} });
      }
    });
    hasMore = data.has_more === true;
    pageToken = String(data.page_token || '');
    if (!pageToken) {
      break;
    }
  }
  return items;
}

async function deleteBitableRecord(appToken: string, tableId: string, recordId: string): Promise<void> {
  await feishuJsonRequest('DELETE', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`);
}

async function batchCreateBitableRecords(
  appToken: string,
  tableId: string,
  rows: Array<Record<string, unknown>>
): Promise<string[]> {
  const createdRecordIds: string[] = [];
  try {
    for (let index = 0; index < rows.length; index += 200) {
      const chunk = rows.slice(index, index + 200).map((fields) => ({ fields }));
      const data = await feishuJsonRequest<{ records?: Array<{ record_id?: string }> }>(
        'POST',
        `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
        {
          records: chunk
        }
      );
      const ids = (data.records || []).map((record) => String(record.record_id || '')).filter(Boolean);
      if (ids.length !== chunk.length) {
        throw new BitableBatchCreateError(
          `Feishu bitable batch create returned ${ids.length}/${chunk.length} record ids`,
          createdRecordIds
        );
      }
      createdRecordIds.push(...ids);
    }
  } catch (error) {
    if (error instanceof BitableBatchCreateError) {
      throw error;
    }
    throw new BitableBatchCreateError(
      error instanceof Error ? error.message : String(error),
      createdRecordIds
    );
  }
  return createdRecordIds;
}

async function ensureDefaultConfigs(): Promise<void> {
  const configs = await listBitableExportConfigs();
  const bySource = new Map(configs.map((row) => [row.source_type, row]));
  const existing = bySource.get(SOURCE_TYPE);
  const legacyPull = bySource.get('pull_daily' as BitableExportSourceType);
  const legacyAsa = bySource.get('asa_raw' as BitableExportSourceType);
  const legacyConflict = hasLegacyConfigConflict(legacyPull, legacyAsa);
  if (existing) {
    if (!String(existing.table_name_prefix || '').trim()) {
      await upsertBitableExportConfig({
        source_type: SOURCE_TYPE,
        table_name_prefix: ACTION_TABLE_NAME,
        selected_fields: DEFAULT_SELECTED_FIELDS
      });
    }
    return;
  }

  if (legacyConflict) {
    await upsertBitableExportConfig({
      source_type: SOURCE_TYPE,
      enabled: true,
      chat_id: null,
      table_name_prefix: ACTION_TABLE_NAME,
      selected_fields: DEFAULT_SELECTED_FIELDS
    });
    await updateBitableExportSyncResult({
      source_type: SOURCE_TYPE,
      table_name_prefix: ACTION_TABLE_NAME,
      last_status: 'failed',
      last_error: LEGACY_CONFIG_CONFLICT_ERROR,
      last_synced_at: null,
      last_record_count: 0
    });
    return;
  }

  const legacySeed = legacyPull ?? legacyAsa;
  const legacyChatId = normalizeChatId(legacySeed?.chat_id);
  const legacyEnabled = Boolean(legacySeed?.enabled);

  await upsertBitableExportConfig({
    source_type: SOURCE_TYPE,
    enabled: legacyEnabled,
    chat_id: legacyChatId || null,
    table_name_prefix: ACTION_TABLE_NAME,
    selected_fields: DEFAULT_SELECTED_FIELDS
  });
}

function normalizeSelectedFields(selectedFields: string[]): string[] {
  return DEFAULT_SELECTED_FIELDS;
}

function platformLabel(platform: string): string {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  if (!platform || platform === 'unknown') return '未知';
  return platform;
}

function budgetMetricLabel(primaryMetric: string, metricMode: string): string {
  if (primaryMetric === 'roas') {
    return metricMode === 'roas_pending_revenue' ? 'ROAS（收入回流中）' : 'ROAS';
  }
  return 'eCPI';
}

function formatLifecycleStage(stage: string): string {
  const normalized = String(stage || '')
    .trim()
    .toLowerCase();

  if (!normalized) {
    return '待观察';
  }

  if (normalized === 'new') return '新建期';
  if (normalized === 'learning') return '学习期';
  if (normalized === 'scaling') return '放量期';
  if (normalized === 'stable') return '稳定期';
  if (normalized === 'declining') return '衰退期';
  if (normalized === 'pause_candidate') return '暂停候选';
  if (normalized === 'rising') return '上升期';

  return stage;
}

function formatActionSummary(action: string, changeRatio: unknown): string {
  const normalized = String(action || '')
    .trim()
    .toLowerCase();
  const ratio = Math.abs(Number(changeRatio || 0) * 100);
  const percentText = Number.isFinite(ratio) && ratio > 0 ? ` ${ratio.toFixed(ratio % 1 === 0 ? 0 : 1)}%` : '';

  if (!normalized) {
    return '保持';
  }
  if (normalized === 'increase') {
    return `提升${percentText}`;
  }
  if (normalized === 'decrease') {
    return `下降${percentText}`;
  }
  if (normalized === 'pause') {
    return '暂停';
  }
  if (normalized === 'hold') {
    return '保持';
  }
  if (/[\u4e00-\u9fa5]/.test(action)) {
    return action;
  }
  return '保持';
}

function formatExecutionActionSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => (item && typeof item === 'object' ? String((item as Record<string, unknown>).label || '').trim() : ''))
      .filter(Boolean)
      .join(' / ');
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return formatExecutionActionSummary(parsed);
    } catch {
      return '';
    }
  }
  return '';
}

function formatBudgetCurrentValue(row: Record<string, unknown>): string {
  if (String(row.primary_metric || '') === 'roas') {
    const currentRoas = Number(row.current_roas || 0);
    const currentEcpi = Number(row.current_ecpi || 0);
    const roasStatus = String(row.roas_data_status || '');
    if (roasStatus === 'pending' || String(row.metric_mode || '') === 'roas_pending_revenue') {
      return `ROAS 回流中 / 当前 eCPI $${currentEcpi.toFixed(2)}`;
    }
    if (roasStatus === 'partial') {
      return `ROAS ${currentRoas.toFixed(2)}（按已覆盖成本计算） / eCPI $${currentEcpi.toFixed(2)}`;
    }
    if (roasStatus === 'unavailable') {
      return `ROAS 暂无成熟数据 / 当前 eCPI $${currentEcpi.toFixed(2)}`;
    }
    return `ROAS ${currentRoas.toFixed(2)} / eCPI $${currentEcpi.toFixed(2)}`;
  }
  return `eCPI $${Number(row.current_ecpi || 0).toFixed(2)}`;
}

function formatBudgetTargetValue(row: Record<string, unknown>): string {
  if (String(row.primary_metric || '') === 'roas') {
    const targetRoas = Number(row.target_roas || 0);
    const targetEcpi = Number(row.target_ecpi || 0);
    return `目标 ROAS ${targetRoas.toFixed(2)} / 目标 eCPI $${targetEcpi.toFixed(2)}`;
  }
  return `目标 eCPI $${Number(row.target_ecpi || 0).toFixed(2)}`;
}

function formatBudgetVolumeReference(row: Record<string, unknown>): string {
  const lastInstalls = Number(row.last_installs || 0);
  const tier = String(row.volume_tier || '').trim();
  if (lastInstalls > 0 && tier) {
    return `最新日安装 ${lastInstalls.toFixed(0)} / 量级 ${tier}`;
  }
  if (lastInstalls > 0) {
    return `最新日安装 ${lastInstalls.toFixed(0)}`;
  }
  if (tier) {
    return `量级 ${tier}`;
  }
  return '待补充';
}

function formatAsaMetricLabel(primaryMetric: string): string {
  return primaryMetric === 'd7_roas_cpp' ? 'D7 ROAS + CPP' : 'eCPI';
}

function formatAsaCurrentValue(row: Record<string, unknown>): string {
  if (String(row.primary_metric || '') === 'd7_roas_cpp') {
    const roasStatus = String(row.roas_data_status || '');
    if (roasStatus === 'pending') {
      return 'ROAS 待补齐 / CPP 待补齐';
    }
    if (roasStatus === 'partial') {
      return `ROAS ${Number(row.current_d7_roas || 0).toFixed(2)}（按已覆盖成本计算） / CPP $${Number(row.current_cpp || 0).toFixed(2)}（按已覆盖成本计算）`;
    }
    if (roasStatus === 'unavailable') {
      return 'ROAS 暂无成熟数据 / CPP 暂无成熟数据';
    }
    return `ROAS ${Number(row.current_d7_roas || 0).toFixed(2)} / CPP $${Number(row.current_cpp || 0).toFixed(2)}`;
  }
  const ecpi = Number(row.current_ecpi || 0);
  return ecpi > 0 ? `eCPI $${ecpi.toFixed(2)}` : 'eCPI —（有花费无安装）';
}

function formatAsaTargetValue(row: Record<string, unknown>): string {
  if (String(row.primary_metric || '') === 'd7_roas_cpp') {
    return `目标 ROAS ${Number(row.target_d7_roas || 0).toFixed(2)} / 目标 CPP $${Number(row.target_cpp || 0).toFixed(2)}`;
  }
  return `目标 eCPI $${Number(row.target_ecpi || 0).toFixed(2)}`;
}

function formatAsaVolumeReference(row: Record<string, unknown>): string {
  const installs7d = Number(row.installs_7d || 0);
  const purchases7d = Number(row.purchase_count_7d || 0);
  return `近7日安装 ${installs7d.toFixed(0)} / 购买 ${purchases7d.toFixed(0)}`;
}

async function queryBudgetActionRows(reportDate: string, options: BitableExportRunOptions = {}): Promise<DeliveryActionRow[]> {
  await ensureBudgetRecommendationsSchema();
  const statusClause = options.includeAllStatuses ? '' : `AND br.status = 'pending'`;
  const result = await pgQuery<Record<string, unknown>>(
    `SELECT
        br.id AS recommendation_id,
        br.app_key,
        br.date::text AS report_date,
        COALESCE(
          NULLIF(CASE WHEN br.platform = 'ios' THEN a.ios_display_name WHEN br.platform = 'android' THEN a.android_display_name ELSE '' END, ''),
          NULLIF(a.display_name, ''),
          br.app_key
        ) AS product_name,
        br.platform,
        br.media_source,
        br.keyword AS item_name,
        br.match_type,
        '' AS campaign,
        '' AS adset,
        COALESCE(ks.current_stage, '待观察') AS stage,
        br.primary_metric,
        br.metric_mode,
        br.current_ecpi,
        br.target_ecpi,
        br.current_roas,
        br.target_roas,
        br.roas_window_from,
        br.roas_window_to,
        br.roas_data_status,
        br.current_cost,
        br.volume_tier,
        COALESCE(ks.last_installs, 0) AS last_installs,
        br.action,
        br.change_ratio,
        br.execution_actions,
        br.status,
        br.reason_code,
        COALESCE(br.llm_summary->>'summary_cn', '') AS reason_summary,
        br.updated_at::text AS updated_at
       FROM budget_recommendations br
       JOIN apps a ON a.app_key = br.app_key
       LEFT JOIN keyword_lifecycle_states ks
         ON ks.app_key = br.app_key
        AND ks.platform = br.platform
        AND ks.keyword = br.keyword
        AND ks.match_type = br.match_type
      WHERE br.date = $1::date
        ${statusClause}
      ORDER BY br.updated_at DESC,
      br.id DESC`,
    [reportDate]
  );

  return result.rows.map((row) => ({
    recommendation_type: 'budget',
    recommendation_id: Number(row.recommendation_id || 0),
    app_key: String(row.app_key || ''),
    serial_no: 0,
    report_date: String(row.report_date || reportDate),
    platform_raw: String(row.platform || 'unknown').trim().toLowerCase(),
    product_name: String(row.product_name || row.app_key || ''),
    platform: platformLabel(String(row.platform || 'unknown')),
    media_source: String(row.media_source || '未知媒体'),
    item_type: '通用投放',
    item_name: String(row.item_name || ''),
    campaign: String(row.campaign || ''),
    adset: '',
    match_type: String(row.match_type || '').trim(),
    stage: formatLifecycleStage(String(row.stage || '待观察')),
    primary_metric: budgetMetricLabel(String(row.primary_metric || ''), String(row.metric_mode || '')),
    current_value: formatBudgetCurrentValue(row),
    target_value: formatBudgetTargetValue(row),
    cost_reference: Number(row.current_cost || 0),
    volume_reference: formatBudgetVolumeReference(row),
    seven_day_later_data: '',
    action: formatActionSummary(String(row.action || 'hold'), row.change_ratio),
    execution_status: EXECUTION_STATUS_DEFAULT,
    validation_result: '',
    is_adopted: false,
    reason: (() => {
      const executionSummary = formatExecutionActionSummary(row.execution_actions);
      const baseReason = String(row.reason_summary || row.reason_code || '暂无补充说明');
      return executionSummary ? `执行动作：${executionSummary}；理由：${baseReason}` : baseReason;
    })()
  }));
}

async function queryAsaActionRows(reportDate: string, options: BitableExportRunOptions = {}): Promise<DeliveryActionRow[]> {
  const statusClause = options.includeAllStatuses ? '' : `AND ar.status = 'pending'`;
  const result = await pgQuery<Record<string, unknown>>(
    `SELECT
        ar.id AS recommendation_id,
        ar.app_key,
        ar.date::text AS report_date,
        COALESCE(
          NULLIF(CASE WHEN ar.platform = 'ios' THEN a.ios_display_name WHEN ar.platform = 'android' THEN a.android_display_name ELSE '' END, ''),
          NULLIF(a.display_name, ''),
          ar.app_key
        ) AS product_name,
        ar.platform,
        'Apple Search Ads' AS media_source,
        ar.keyword AS item_name,
        ar.campaign,
        ar.adset,
        COALESCE(s.current_stage, '待观察') AS stage,
        ar.primary_metric,
        ar.current_ecpi,
        ar.current_cpp,
        ar.current_d7_roas,
        ar.roas_window_from,
        ar.roas_window_to,
        ar.roas_data_status,
        ar.target_ecpi,
        ar.target_cpp,
        ar.target_d7_roas,
        COALESCE(s.total_cost_7d, 0) AS total_cost_7d,
        COALESCE(s.installs_7d, 0) AS installs_7d,
        COALESCE(s.purchase_count_7d, 0) AS purchase_count_7d,
        ar.action,
        ar.change_ratio,
        ar.status,
        ar.reason_code,
        COALESCE(ar.llm_summary->>'summary_cn', '') AS reason_summary,
        ar.updated_at::text AS updated_at
       FROM asa_keyword_recommendations ar
       JOIN apps a ON a.app_key = ar.app_key
       LEFT JOIN asa_keyword_states s
         ON s.app_key = ar.app_key
        AND s.platform = ar.platform
        AND s.keyword = ar.keyword
        AND s.campaign = ar.campaign
        AND s.adset = ar.adset
      WHERE ar.date = $1::date
        ${statusClause}
      ORDER BY ar.updated_at DESC,
      ar.id DESC`,
    [reportDate]
  );

  return result.rows.map((row) => ({
    recommendation_type: 'asa_keyword',
    recommendation_id: Number(row.recommendation_id || 0),
    app_key: String(row.app_key || ''),
    serial_no: 0,
    report_date: String(row.report_date || reportDate),
    platform_raw: String(row.platform || 'unknown').trim().toLowerCase(),
    product_name: String(row.product_name || row.app_key || ''),
    platform: platformLabel(String(row.platform || 'unknown')),
    media_source: 'Apple Search Ads',
    item_type: 'ASA 关键词',
    item_name: String(row.item_name || ''),
    campaign: String(row.campaign || ''),
    adset: String(row.adset || ''),
    match_type: '',
    stage: formatLifecycleStage(String(row.stage || '待观察')),
    primary_metric: formatAsaMetricLabel(String(row.primary_metric || 'ecpi')),
    current_value: formatAsaCurrentValue(row),
    target_value: formatAsaTargetValue(row),
    cost_reference: Number(row.total_cost_7d || 0),
    volume_reference: formatAsaVolumeReference(row),
    seven_day_later_data: '',
    action: formatActionSummary(String(row.action || 'hold'), row.change_ratio),
    execution_status: EXECUTION_STATUS_DEFAULT,
    validation_result: '',
    is_adopted: false,
    reason: String(row.reason_summary || row.reason_code || '暂无补充说明')
  }));
}

async function queryDeliveryActionRows(
  reportDate: string,
  options: BitableExportRunOptions = {}
): Promise<{ rows: DeliveryActionRow[]; breakdown: { campaign_actions: number; asa_actions: number } }> {
  const [campaignRows, asaRows] = await Promise.all([
    queryBudgetActionRows(reportDate, options),
    queryAsaActionRows(reportDate, options)
  ]);
  return {
    rows: [...campaignRows, ...asaRows],
    breakdown: {
      campaign_actions: campaignRows.length,
      asa_actions: asaRows.length
    }
  };
}

async function listHistoricalDeliveryActionReportDates(): Promise<string[]> {
  const result = await pgQuery<{ report_date: string }>(
    `SELECT DISTINCT report_date
       FROM (
         SELECT date::text AS report_date FROM budget_recommendations
         UNION
         SELECT date::text AS report_date FROM asa_keyword_recommendations
       ) dates
      WHERE NULLIF(BTRIM(report_date), '') IS NOT NULL
      ORDER BY report_date ASC`
  );
  return result.rows.map((row) => String(row.report_date || '').trim()).filter(Boolean);
}

function syncKeyForRow(row: DeliveryActionRow): string {
  return [
    row.report_date,
    row.item_type,
    row.product_name,
    row.platform,
    row.media_source,
    row.item_name,
    row.campaign,
    row.adset
  ]
    .map((item) => String(item || '').trim())
    .join('|');
}

async function resolveActionTable(
  appToken: string,
  config: BitableExportConfigRecord,
  reportDate: string
): Promise<BitableTableRecord> {
  const normalizedPrefix = normalizeTableNamePrefix(config.table_name_prefix);
  const targetName = buildDailyTableName(normalizedPrefix, reportDate);
  const archived = reportDate ? await getBitableExportDailyTable(SOURCE_TYPE, reportDate) : null;
  const tables = await listBitableTables(appToken);

  const byArchivedId =
    archived?.table_id && tables.find((table) => table.table_id === archived.table_id);
  if (byArchivedId) {
    return byArchivedId;
  }

  const archivedName = String(archived?.table_name || '').trim();
  const byArchivedName =
    archivedName && tables.find((table) => table.name === archivedName);
  if (byArchivedName) {
    return byArchivedName;
  }

  const byTargetName = tables.find((table) => table.name === targetName);
  if (byTargetName) {
    return byTargetName;
  }

  return createBitableTable(appToken, targetName);
}

async function ensureTableFields(
  appToken: string,
  tableId: string,
  selectedFields: string[],
  logger?: LoggerLike
): Promise<void> {
  const existingFields = await listBitableFields(appToken, tableId);
  const fieldsByName = new Map(existingFields.map((field) => [field.field_name, field]));
  const catalog = fieldCatalog();
  const required = catalog.filter((field) => field.system || selectedFields.includes(field.key));

  const manualReviewField = catalog.find((field) => field.label === MANUAL_REVIEW_FIELD_LABEL);
  const legacyManualReviewField = fieldsByName.get(LEGACY_MANUAL_REVIEW_FIELD_LABEL);
  if (manualReviewField && legacyManualReviewField && !fieldsByName.has(MANUAL_REVIEW_FIELD_LABEL)) {
    await updateBitableField(appToken, tableId, legacyManualReviewField.field_id, manualReviewField);
    fieldsByName.delete(LEGACY_MANUAL_REVIEW_FIELD_LABEL);
    fieldsByName.set(MANUAL_REVIEW_FIELD_LABEL, {
      ...legacyManualReviewField,
      field_name: MANUAL_REVIEW_FIELD_LABEL
    });
  }

  const executionStatusField = catalog.find((field) => field.label === EXECUTION_STATUS_FIELD_LABEL);
  const existingExecutionStatusField = fieldsByName.get(EXECUTION_STATUS_FIELD_LABEL);
  if (
    executionStatusField &&
    existingExecutionStatusField?.field_id &&
    existingExecutionStatusField.type !== FEISHU_SINGLE_SELECT_FIELD_TYPE
  ) {
    await deleteBitableField(appToken, tableId, existingExecutionStatusField.field_id);
    await createBitableField(appToken, tableId, executionStatusField);
    fieldsByName.delete(EXECUTION_STATUS_FIELD_LABEL);
    logger?.info?.('bitable_execution_status_field_recreated', {
      table_id: tableId,
      previous_type: existingExecutionStatusField.type,
      next_type: FEISHU_SINGLE_SELECT_FIELD_TYPE
    });
  }

  for (const field of required) {
    const existingField = fieldsByName.get(field.label);
    if (existingField) {
      const fieldSpec = fieldTypeToFeishu(field);
      if (existingField.type !== fieldSpec.type) {
        await updateBitableField(appToken, tableId, existingField.field_id, field);
        fieldsByName.set(field.label, {
          ...existingField,
          type: fieldSpec.type
        });
      }
      continue;
    }
    try {
      await createBitableField(appToken, tableId, field);
    } catch (error) {
      if (!isFeishuFieldNameDuplicatedError(error)) {
        throw error;
      }
      logger?.warn?.('bitable_field_already_exists', {
        table_id: tableId,
        field_name: field.label
      });
    }
    fieldsByName.set(field.label, {
      field_id: '',
      field_name: field.label,
      type:
        field.value_type === 'checkbox'
          ? FEISHU_CHECKBOX_FIELD_TYPE
          : field.value_type === 'single_select'
            ? FEISHU_SINGLE_SELECT_FIELD_TYPE
            : 0
    });
  }

  const removableLabels = new Set(OBSOLETE_FIELD_LABELS);
  if (fieldsByName.has(LEGACY_MANUAL_REVIEW_FIELD_LABEL) && fieldsByName.has(MANUAL_REVIEW_FIELD_LABEL)) {
    removableLabels.add(LEGACY_MANUAL_REVIEW_FIELD_LABEL);
  }

  for (const label of removableLabels) {
    const field = fieldsByName.get(label);
    if (!field?.field_id) {
      continue;
    }
    try {
      await deleteBitableField(appToken, tableId, field.field_id);
      fieldsByName.delete(label);
    } catch (error) {
      logger?.warn?.('bitable_delete_field_failed', {
        table_id: tableId,
        field_name: label,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function trailingFieldsNeedReorder(existingFields: BitableFieldRecord[]): boolean {
  const presentIndexes = TRAILING_ACTION_FIELD_SEQUENCE
    .map((label) => ({
      label,
      index: existingFields.findIndex((field) => field.field_name === label)
    }))
    .filter((item) => item.index >= 0);

  if (presentIndexes.length <= 1) {
    return false;
  }

  for (let index = 1; index < presentIndexes.length; index += 1) {
    const previous = presentIndexes[index - 1];
    const current = presentIndexes[index];
    if (current.index !== previous.index + 1) {
      return true;
    }
  }

  return false;
}

async function reorderTrailingActionFields(
  appToken: string,
  tableId: string,
  logger?: LoggerLike
): Promise<void> {
  const existingFields = await listBitableFields(appToken, tableId);
  if (!trailingFieldsNeedReorder(existingFields)) {
    return;
  }

  const fieldsByName = new Map(existingFields.map((field) => [field.field_name, field]));
  const labelsToRebuild = TRAILING_ACTION_FIELD_SEQUENCE.filter((label) => fieldsByName.has(label));
  if (labelsToRebuild.length <= 1) {
    return;
  }

  const records = await listBitableRecords(appToken, tableId);
  const preservedValues = records.map((record) => {
    const fields: Record<string, unknown> = {};
    for (const label of labelsToRebuild) {
      fields[label] = record.fields[label];
    }
    return {
      record_id: record.record_id,
      fields
    };
  });

  for (const label of labelsToRebuild) {
    const field = fieldsByName.get(label);
    if (!field?.field_id) {
      continue;
    }
    await deleteBitableField(appToken, tableId, field.field_id);
  }

  for (const label of labelsToRebuild) {
    const definition = fieldDefinitionForLabel(label);
    if (!definition) {
      continue;
    }
    await createBitableField(appToken, tableId, definition);
  }

  for (const record of preservedValues) {
    const fields: Record<string, unknown> = {};
    for (const label of labelsToRebuild) {
      const definition = fieldDefinitionForLabel(label);
      if (!definition) {
        continue;
      }
      const value = serializeFieldValue(definition, record.fields[label]);
      if (value !== undefined) {
        fields[label] = value;
      }
    }
    if (Object.keys(fields).length === 0) {
      continue;
    }
    await updateBitableRecord(appToken, tableId, record.record_id, fields);
  }

  logger?.info?.('bitable_trailing_fields_reordered', {
    table_id: tableId,
    labels: labelsToRebuild
  });
}

async function loadExistingRecordRefs(reportDate: string, tableId: string): Promise<BitableRecordRef[]> {
  const refs = await listBitableExportRecordRefs(SOURCE_TYPE, reportDate, tableId);
  return refs.map((row) => ({
      record_id: row.record_id,
      snapshot_id: row.snapshot_id,
      sync_key: row.sync_key,
      recommendation_type: row.recommendation_type,
      recommendation_id: row.recommendation_id == null ? null : Number(row.recommendation_id),
      validation_result: String(row.validation_result || '').trim(),
      is_adopted: row.is_adopted === true
    }));
}

async function buildManualFeedbackMap(
  appToken: string,
  tableId: string,
  refs: BitableRecordRef[],
  logger?: LoggerLike
): Promise<{
  manualReviewMap: Map<string, string>;
  adoptedMap: Map<string, boolean>;
  executionStatusMap: Map<string, string>;
  staleRecordIds: string[];
}> {
  const manualReviewMap = new Map<string, string>();
  const adoptedMap = new Map<string, boolean>();
  const executionStatusMap = new Map<string, string>();
  const staleRecordIds: string[] = [];
  if (refs.length === 0) {
    return { manualReviewMap, adoptedMap, executionStatusMap, staleRecordIds };
  }

  let liveRecords: BitableRecordItem[] = [];
  try {
    liveRecords = await listBitableRecords(appToken, tableId);
  } catch (error) {
    logger?.warn?.('bitable_validation_result_lookup_failed', {
      table_id: tableId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { manualReviewMap, adoptedMap, executionStatusMap, staleRecordIds };
  }

  const liveRecordById = new Map(liveRecords.map((record) => [record.record_id, record]));

  for (const ref of refs) {
    const record = liveRecordById.get(ref.record_id);
    if (!record) {
      staleRecordIds.push(ref.record_id);
      continue;
    }
    const syncKey = String(ref.sync_key || '').trim();
    const manualReview = String(
      record.fields[MANUAL_REVIEW_FIELD_LABEL] ??
        record.fields[LEGACY_MANUAL_REVIEW_FIELD_LABEL] ??
        ref.validation_result ??
        ''
    ).trim();
    const isAdopted = parseCheckboxValue(record.fields[ADOPTED_FIELD_LABEL] ?? ref.is_adopted);
    const executionStatus = normalizeExecutionStatus(record.fields[EXECUTION_STATUS_FIELD_LABEL]);
    if (syncKey && manualReview && !manualReviewMap.has(syncKey)) {
      manualReviewMap.set(syncKey, manualReview);
    }
    if (syncKey && !adoptedMap.has(syncKey)) {
      adoptedMap.set(syncKey, isAdopted);
    }
    if (syncKey && executionStatus && !executionStatusMap.has(syncKey)) {
      executionStatusMap.set(syncKey, executionStatus);
    }
  }

  return { manualReviewMap, adoptedMap, executionStatusMap, staleRecordIds };
}

async function buildPersistedFeedbackMap(rows: DeliveryActionRow[]): Promise<{
  manualReviewMap: Map<string, string>;
  adoptedMap: Map<string, boolean>;
  executionStatusMap: Map<string, string>;
}> {
  const keys = rows
    .filter((row) => Number.isFinite(Number(row.recommendation_id)) && Number(row.recommendation_id) > 0)
    .map((row) => ({
      recommendation_type: row.recommendation_type,
      recommendation_id: Number(row.recommendation_id)
    }));
  const feedbacks = await listRecommendationExecutionFeedbacksByRecommendations(SOURCE_TYPE, keys);
  const feedbackByRecommendation = new Map(
    feedbacks.map((row) => [`${row.recommendation_type}:${row.recommendation_id}`, row])
  );
  const manualReviewMap = new Map<string, string>();
  const adoptedMap = new Map<string, boolean>();
  const executionStatusMap = new Map<string, string>();

  for (const row of rows) {
    const recommendationKey = `${row.recommendation_type}:${row.recommendation_id}`;
    const feedback = feedbackByRecommendation.get(recommendationKey);
    if (!feedback) {
      continue;
    }
    const syncKey = syncKeyForRow(row);
    const manualReview = String(feedback.validation_result || '').trim();
    if (manualReview) {
      manualReviewMap.set(syncKey, manualReview);
    }
    if (feedback.is_adopted === true) {
      adoptedMap.set(syncKey, true);
    }
    const executionStatus = String(feedback.execution_status || '').trim();
    if (executionStatus) {
      executionStatusMap.set(syncKey, executionStatus);
    }
  }

  return { manualReviewMap, adoptedMap, executionStatusMap };
}

async function deleteRecordsByIds(
  appToken: string,
  tableId: string,
  recordIds: string[],
  logger?: LoggerLike
): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  for (const recordId of recordIds) {
    try {
      await deleteBitableRecord(appToken, tableId, recordId);
      deletedIds.push(recordId);
    } catch (error) {
      failedIds.push(recordId);
      logger?.warn?.('bitable_delete_record_failed', {
        table_id: tableId,
        record_id: recordId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { deletedIds, failedIds };
}

function buildRecordFields(
  row: DeliveryActionRow,
  selectedFields: string[],
  syncedAtMillis: number
): Record<string, unknown> {
  const catalog = fieldCatalog();
  const selected = new Set(selectedFields);
  const result: Record<string, unknown> = {
    [PRIMARY_SERIAL_FIELD_LABEL]: String(row.serial_no),
    同步时间: syncedAtMillis
  };
  for (const field of catalog) {
    if (field.system || !selected.has(field.key)) {
      continue;
    }
    const rawValue = displayValueForField(field, row[field.key as keyof DeliveryActionRow]);
    const value = serializeFieldValue(field, rawValue);
    if (value !== undefined) {
      result[field.label] = value;
    }
  }
  return compactFields(result);
}

function buildNotifyCard(result: BitableExportRunResult): Record<string, unknown> {
  const template =
    result.export_status === 'failed' ? 'red' : result.export_status === 'partial_success' ? 'orange' : 'blue';
  const summaryText =
    result.export_status === 'partial_success'
      ? '写入成功，但旧快照清理不完整'
      : result.notify.ok
        ? '执行清单已刷新并通知成功'
        : '执行清单已刷新，但群通知失败';
  const detailText =
    result.export_status === 'partial_success'
      ? result.export_error || '已写入新快照，但旧快照清理不完整，可能存在重复历史记录。'
      : result.export_status === 'failed'
        ? result.export_error || '导出失败'
        : result.notify.ok
          ? '表格已更新为最新执行清单，适合投放同学直接查看和处理。'
          : result.notify.error || '群通知失败';
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: `投放执行表推送｜${result.report_date}`
      }
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `**结果**：${summaryText}\n` +
            `**目标表**：${result.table_name}\n` +
            `**总条数**：${result.record_count}\n` +
            `**通用投放**：${result.breakdown.campaign_actions}\n` +
            `**ASA 关键词**：${result.breakdown.asa_actions}\n` +
            `**清理旧记录**：${result.deleted_count}\n` +
            `**说明**：${detailText}`
        }
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开投放执行表' },
            type: 'primary',
            url: result.table_url
          }
        ]
      }
    ]
  };
}

export async function getBitableExportConfigsSnapshot(): Promise<{ sources: BitableSourceSnapshot[] }> {
  await ensureDefaultConfigs();
  const [row, feedbackSync, recentTables] = await Promise.all([
    getBitableExportConfig(SOURCE_TYPE).then((config) => mergeConfig(config)),
    getBitableFeedbackSyncSnapshot(SOURCE_TYPE),
    listBitableExportDailyTables(SOURCE_TYPE, RECENT_DAILY_TABLE_LIMIT)
  ]);
  const recentTableSnapshots = recentTables.map((table) => mapDailyTableSnapshot(table));
  const latestTableUrl = baseTableUrl(row.target_table_id || '') || recentTableSnapshots[0]?.table_url || '';
  return {
    sources: [
      {
        source_type: SOURCE_TYPE,
        label: SOURCE_LABEL,
        fields: ACTION_FIELDS,
        config: row,
        table_url: latestTableUrl,
        latest_table_url: latestTableUrl,
        target_table_hint: TARGET_TABLE_HINT,
        recent_tables: recentTableSnapshots,
        feedback_sync: feedbackSync
      }
    ]
  };
}

export async function saveBitableExportConfig(input: {
  sourceType: BitableExportSourceType;
  enabled: boolean;
  chatId: string;
  tableNamePrefix: string;
}): Promise<BitableSourceSnapshot> {
  if (input.sourceType !== SOURCE_TYPE) {
    throw new Error('unsupported_bitable_source_type');
  }
  await ensureDefaultConfigs();
  const saved = await upsertBitableExportConfig({
    source_type: SOURCE_TYPE,
    enabled: input.enabled,
    chat_id: input.chatId,
    table_name_prefix: normalizeTableNamePrefix(input.tableNamePrefix),
    selected_fields: DEFAULT_SELECTED_FIELDS,
  });
  let merged = mergeConfig(saved);
  if (String(merged.last_error || '') === LEGACY_CONFIG_CONFLICT_ERROR) {
    const cleared = await updateBitableExportSyncResult({
      source_type: SOURCE_TYPE,
      target_table_id: merged.target_table_id,
      target_table_name: merged.target_table_name,
      table_name_prefix: merged.table_name_prefix,
      last_status: 'idle',
      last_error: null,
      last_synced_at: merged.last_synced_at,
      last_record_count: merged.last_record_count
    });
    merged = mergeConfig(cleared);
  }
  const [feedbackSync, recentTables] = await Promise.all([
    getBitableFeedbackSyncSnapshot(SOURCE_TYPE),
    listBitableExportDailyTables(SOURCE_TYPE, RECENT_DAILY_TABLE_LIMIT)
  ]);
  const recentTableSnapshots = recentTables.map((table) => mapDailyTableSnapshot(table));
  const latestTableUrl = baseTableUrl(merged.target_table_id || '') || recentTableSnapshots[0]?.table_url || '';
  return {
    source_type: SOURCE_TYPE,
    label: SOURCE_LABEL,
    fields: ACTION_FIELDS,
    config: merged,
    table_url: latestTableUrl,
    latest_table_url: latestTableUrl,
    target_table_hint: TARGET_TABLE_HINT,
    recent_tables: recentTableSnapshots,
    feedback_sync: feedbackSync
  };
}

export async function runBitableExport(
  sourceType: BitableExportSourceType,
  reportDate: string,
  logger?: LoggerLike,
  options: BitableExportRunOptions = {}
): Promise<BitableExportRunResult> {
  if (sourceType !== SOURCE_TYPE) {
    throw new Error('unsupported_bitable_source_type');
  }
  const exportResult = await withBitableSourceIOLock(SOURCE_TYPE, async () => {
    await ensureDefaultConfigs();
    const appToken = String(env.feishuBitableAppToken || '').trim();
    if (!appToken) {
      throw new Error('Missing FEISHU_BITABLE_APP_TOKEN');
    }
    const config = mergeConfig(await getBitableExportConfig(SOURCE_TYPE));
    const tableNamePrefix = normalizeTableNamePrefix(config.table_name_prefix);
    const selectedFields = DEFAULT_SELECTED_FIELDS;
    const notifyEnabled = options.notify !== false;
    const chatId = String(config.chat_id || '').trim();
    if (notifyEnabled && !chatId) {
      throw new Error(`${SOURCE_LABEL} 未配置 Chat ID`);
    }

    const table = await resolveActionTable(appToken, config, reportDate);
    await ensureTableFields(appToken, table.table_id, selectedFields, logger);
    await reorderTrailingActionFields(appToken, table.table_id, logger);
    const existingTableRecords = await listBitableRecords(appToken, table.table_id);
    const existingTableRecordIds = existingTableRecords.map((record) => record.record_id);

    const { rows, breakdown } = await queryDeliveryActionRows(reportDate, options);
    const sevenDayLaterMap = await querySevenDayLaterDataForLookupRows(
      rows.map((row) => ({
        recommendation_type: row.recommendation_type,
        recommendation_id: row.recommendation_id,
        report_date: row.report_date,
        app_key: row.app_key,
        platform_raw: row.platform_raw,
        media_source: row.media_source,
        item_name: row.item_name,
        match_type: row.match_type,
        campaign: row.campaign,
        adset: row.adset
      }))
    );
    const persistedFeedback = await buildPersistedFeedbackMap(rows);
    const oldRecords = await loadExistingRecordRefs(reportDate, table.table_id);
    const liveFeedback = await buildManualFeedbackMap(appToken, table.table_id, oldRecords, logger);
    const snapshotId = `${reportDate}:${Date.now()}:${SOURCE_TYPE}`;
    const syncedAtMillis = parseToEpochMillis(formatLocalDateTime()) ?? Date.now();
    const rowsWithFeedback = rows
      .map((row) => {
        const syncKey = syncKeyForRow(row);
        return {
          ...row,
          serial_no: 0,
          execution_status:
            liveFeedback.executionStatusMap.get(syncKey) ||
            persistedFeedback.executionStatusMap.get(syncKey) ||
            row.execution_status ||
            EXECUTION_STATUS_DEFAULT,
          validation_result:
            liveFeedback.manualReviewMap.get(syncKey) ||
            persistedFeedback.manualReviewMap.get(syncKey) ||
            row.validation_result ||
            '',
          is_adopted: liveFeedback.adoptedMap.has(syncKey)
            ? liveFeedback.adoptedMap.get(syncKey) === true
            : persistedFeedback.adoptedMap.has(syncKey)
              ? persistedFeedback.adoptedMap.get(syncKey) === true
              : row.is_adopted === true,
          seven_day_later_data:
            sevenDayLaterMap.get(`${row.recommendation_type}:${row.recommendation_id}`) ||
            row.seven_day_later_data ||
            ''
        };
      })
      .map((row, index) => ({
        ...row,
        serial_no: index + 1
      }));
    const recordPayloads = rowsWithFeedback.map((row) => buildRecordFields(row, selectedFields, syncedAtMillis));

    let createdRecordIds: string[] = [];
    try {
      createdRecordIds = await batchCreateBitableRecords(appToken, table.table_id, recordPayloads);
    } catch (error) {
      if (error instanceof BitableBatchCreateError) {
        createdRecordIds = error.createdRecordIds;
      }
      if (createdRecordIds.length > 0) {
        await deleteRecordsByIds(appToken, table.table_id, createdRecordIds, logger);
      }
      throw error;
    }

    await upsertBitableExportRecordRefs(
      createdRecordIds.map((recordId, index) => ({
        source_type: SOURCE_TYPE,
        report_date: reportDate,
        table_id: table.table_id,
        snapshot_id: snapshotId,
        sync_key: syncKeyForRow(rowsWithFeedback[index]),
        record_id: recordId,
        recommendation_type: rowsWithFeedback[index]?.recommendation_type ?? null,
        recommendation_id: rowsWithFeedback[index]?.recommendation_id ?? null,
        validation_result: rowsWithFeedback[index]?.validation_result || '',
        is_adopted: rowsWithFeedback[index]?.is_adopted === true
      }))
    );

    if (liveFeedback.staleRecordIds.length > 0) {
      await deleteBitableExportRecordRefsByRecordIds(SOURCE_TYPE, liveFeedback.staleRecordIds);
    }

    const deleteResult = await deleteRecordsByIds(appToken, table.table_id, existingTableRecordIds, logger);
    if (deleteResult.deletedIds.length > 0) {
      await deleteBitableExportRecordRefsByRecordIds(SOURCE_TYPE, deleteResult.deletedIds);
    }
    const deletedCount = deleteResult.deletedIds.length;
    const cleanupError =
      existingTableRecordIds.length > 0 && deletedCount !== existingTableRecordIds.length
        ? `snapshot_cleanup_incomplete deleted=${deletedCount}/${existingTableRecordIds.length}`
        : null;

    const resultBase = {
      source_type: SOURCE_TYPE,
      label: SOURCE_LABEL,
      report_date: reportDate,
      table_id: table.table_id,
      table_name: table.name,
      table_name_prefix: tableNamePrefix,
      table_url: baseTableUrl(table.table_id),
      selected_fields: selectedFields,
      deleted_count: deletedCount,
      record_count: recordPayloads.length,
      export_status: cleanupError ? ('partial_success' as const) : ('success' as const),
      export_error: cleanupError,
      breakdown
    };

    const notify = notifyEnabled
      ? await sendFeishuInteractiveCardNotification(
          {
            title: `${SOURCE_LABEL}｜${reportDate}`,
            text: `${SOURCE_LABEL} 已刷新 ${recordPayloads.length} 行`,
            feishuCardPayload: buildNotifyCard({
              ...resultBase,
              notify: { ok: true }
            } as BitableExportRunResult)
          },
          {
            notify_feishu_chat_id: chatId
          } satisfies AlertChannelConfig
        )
      : ({
          ok: true,
          render_mode: 'text_fallback'
        } as BitableExportRunResult['notify']);

    const result: BitableExportRunResult = {
      ...resultBase,
      notify
    };

    await updateBitableExportSyncResult({
      source_type: SOURCE_TYPE,
      target_table_id: table.table_id,
      target_table_name: table.name,
      table_name_prefix: tableNamePrefix,
      last_status: cleanupError ? 'partial_success' : notify.ok ? 'success' : 'failed',
      last_error: cleanupError || (notify.ok ? null : notify.error || 'notify_failed'),
      last_synced_at: new Date().toISOString(),
      last_record_count: recordPayloads.length
    });
    await upsertBitableExportDailyTable({
      source_type: SOURCE_TYPE,
      report_date: reportDate,
      table_id: table.table_id,
      table_name: table.name,
      table_name_prefix: tableNamePrefix,
      last_record_count: recordPayloads.length,
      last_synced_at: new Date().toISOString()
    });

    if (cleanupError) {
      logger?.warn?.('bitable_snapshot_cleanup_incomplete', {
        source_type: SOURCE_TYPE,
        report_date: reportDate,
        table_id: table.table_id,
        deleted_count: deletedCount,
        expected_delete_count: existingTableRecordIds.length
      });
    }

    return result;
  });

  if (options.seedFeedbackSync !== false) {
    try {
      await runBitableFeedbackSync(SOURCE_TYPE, logger, 'system.bitable_export_seed');
    } catch (error) {
      logger?.warn?.('bitable_feedback_seed_failed', {
        source_type: SOURCE_TYPE,
        report_date: reportDate,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return exportResult;
}

export async function runHistoricalBitableExportBackfill(
  sourceType: BitableExportSourceType,
  logger?: LoggerLike
): Promise<BitableHistoricalBackfillResult> {
  if (sourceType !== SOURCE_TYPE) {
    throw new Error('unsupported_bitable_source_type');
  }

  await ensureDefaultConfigs();
  const reportDates = await listHistoricalDeliveryActionReportDates();
  const results: BitableExportRunResult[] = [];
  const failedDates: Array<{ report_date: string; error: string }> = [];

  for (const reportDate of reportDates) {
    try {
      const result = await runBitableExport(sourceType, reportDate, logger, {
        includeAllStatuses: true,
        notify: false,
        seedFeedbackSync: false
      });
      results.push(result);
    } catch (error) {
      failedDates.push({
        report_date: reportDate,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  try {
    await runBitableFeedbackSync(sourceType, logger, 'system.bitable_export_backfill_seed');
  } catch (error) {
    failedDates.push({
      report_date: 'feedback_sync',
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return {
    source_type: sourceType,
    processed_dates: reportDates,
    success_dates: results.map((result) => result.report_date),
    failed_dates: failedDates,
    results
  };
}

export function resolveManualBitableExportHttpResult(result: BitableExportRunResult): {
  http_status: number;
  ok: boolean;
  error: string | null;
} {
  if (!result.notify.ok) {
    return {
      http_status: 502,
      ok: false,
      error: 'bitable_export_notify_failed'
    };
  }
  if (result.export_status === 'partial_success') {
    return {
      http_status: 207,
      ok: false,
      error: 'bitable_export_partial_success'
    };
  }
  if (result.export_status === 'failed') {
    return {
      http_status: 500,
      ok: false,
      error: 'bitable_export_failed'
    };
  }
  return {
    http_status: 200,
    ok: true,
    error: null
  };
}

export async function runScheduledBitableExports(logger?: LoggerLike): Promise<ScheduledBitableExportRunSummary> {
  if (!env.feishuBitableEnabled) {
    logger?.info?.('bitable_exports_disabled');
    return {
      completed: true,
      skipped: true,
      success_count: 0,
      partial_success_count: 0,
      failed_count: 0,
      results: []
    };
  }
  await ensureDefaultConfigs();
  const reportDate = getPreviousDateString(1);
  const config = mergeConfig(await getBitableExportConfig(SOURCE_TYPE));
  if (!config.enabled || !String(config.chat_id || '').trim()) {
    return {
      completed: true,
      skipped: true,
      success_count: 0,
      partial_success_count: 0,
      failed_count: 0,
      results: []
    };
  }
  try {
    const result = await runBitableExport(SOURCE_TYPE, reportDate, logger);
    const httpResult = resolveManualBitableExportHttpResult(result);
    return {
      completed: httpResult.ok,
      skipped: false,
      success_count: result.export_status === 'success' && result.notify.ok ? 1 : 0,
      partial_success_count: result.export_status === 'partial_success' ? 1 : 0,
      failed_count: httpResult.ok ? 0 : 1,
      results: [result]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateBitableExportSyncResult({
      source_type: SOURCE_TYPE,
      target_table_id: config.target_table_id,
      target_table_name: config.target_table_name,
      table_name_prefix: config.table_name_prefix,
      last_status: 'failed',
      last_error: message,
      last_synced_at: new Date().toISOString(),
      last_record_count: 0
    });
    logger?.error?.('scheduled_bitable_export_failed', {
      source_type: SOURCE_TYPE,
      error: message
    });
    return {
      completed: false,
      skipped: false,
      success_count: 0,
      partial_success_count: 0,
      failed_count: 1,
      results: [],
      error: message
    };
  }
}
