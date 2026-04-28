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
  ensureAsaKeywordRoasSchema,
  deleteBitableExportRecordRefsByRecordIds,
  getBitableExportConfig,
	  getBitableExportDailyTable,
	  listApps,
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
import { buildAfOfficialBatchSnapshot, type AfOfficialBatchSnapshot } from './appsflyerOfficialSnapshots.js';
import {
  buildAsaMasterExpectedComponents,
  buildDailyReportExpectedComponents
} from './appsflyerExpectedComponents.js';
import {
  afDashboardCampaignKey,
  queryAfDashboardDailyCampaignMetrics,
  type AfDashboardCampaignMetric
} from './afDashboardMetrics.js';

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

interface ResolvedActionTable extends BitableTableRecord {
  is_new: boolean;
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
  display_product_name: string;
  platform: string;
  media_source: string;
  item_type: string;
  item_name: string;
  display_item_name: string;
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
	  official_snapshot: AfOfficialBatchSnapshot;
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

interface BitableFieldSyncOptions {
  cleanupExtraFields: boolean;
  allowDestructiveFieldRebuild: boolean;
}

interface BitableFieldSyncResult {
  cleanup_labels: string[];
}

interface BitableSourceDefinition {
  source_type: BitableExportSourceType;
  label: string;
  target_table_hint: string;
  default_table_name_prefix: string;
  fields: BitableFieldDefinition[];
  primary_field_key: keyof DeliveryActionRow;
  primary_field_label: string;
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

const LEGACY_SOURCE_TYPE: BitableExportSourceType = 'delivery_actions';
const NON_ASA_SOURCE_TYPE: BitableExportSourceType = 'delivery_actions_non_asa';
const ASA_SOURCE_TYPE: BitableExportSourceType = 'delivery_actions_asa';
const ACTIVE_SOURCE_TYPES = [NON_ASA_SOURCE_TYPE, ASA_SOURCE_TYPE] as const;
const ASA_MEDIA_SOURCE = 'apple search ads';
const ACTION_TABLE_NAME_BASE = String(env.feishuBitableActionTableName || '投放执行表').trim() || '投放执行表';
const RECENT_DAILY_TABLE_LIMIT = 7;
const ITEM_NAME_FIELD_LABEL = '投放项名称';
const KEYWORD_FIELD_LABEL = '关键词';
const MANUAL_REVIEW_FIELD_LABEL = '人工批复';
const LEGACY_MANUAL_REVIEW_FIELD_LABEL = '验证结果';
const ADOPTED_FIELD_LABEL = '是否采纳';
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
const LEGACY_CONFIG_CONFLICT_ERROR =
  'legacy_config_conflict: 原 Pull 明细表 与 ASA Raw 表配置不一致，已停止自动迁移，请在页面重新确认 Chat ID 与启用状态。';

const NON_ASA_ACTION_FIELDS: BitableFieldDefinition[] = [
  { key: 'display_item_name', label: ITEM_NAME_FIELD_LABEL, value_type: 'text', default_selected: true },
  { key: 'display_product_name', label: '产品名', value_type: 'text', default_selected: true },
  { key: 'primary_metric', label: '主指标', value_type: 'text', default_selected: true },
  { key: 'current_value', label: '当前表现', value_type: 'text', default_selected: true },
  { key: 'target_value', label: '目标表现', value_type: 'text', default_selected: true },
  { key: 'volume_reference', label: '量级参考', value_type: 'text', default_selected: true },
  { key: 'action', label: '建议动作', value_type: 'text', default_selected: true },
  { key: 'reason', label: '建议理由', value_type: 'text', default_selected: true },
  {
    key: 'execution_status',
    label: EXECUTION_STATUS_FIELD_LABEL,
    value_type: 'single_select',
    default_selected: true,
    options: EXECUTION_STATUS_OPTIONS
  },
  { key: 'is_adopted', label: ADOPTED_FIELD_LABEL, value_type: 'checkbox', default_selected: true },
  { key: 'validation_result', label: MANUAL_REVIEW_FIELD_LABEL, value_type: 'text', default_selected: true },
  { key: 'seven_day_later_data', label: SEVEN_DAY_LATER_FIELD_LABEL, value_type: 'text', default_selected: true }
];

const ASA_ACTION_FIELDS: BitableFieldDefinition[] = [
  { key: 'item_name', label: KEYWORD_FIELD_LABEL, value_type: 'text', default_selected: true },
  { key: 'campaign', label: '广告系列', value_type: 'text', default_selected: true },
  { key: 'adset', label: '广告组', value_type: 'text', default_selected: true },
  { key: 'display_product_name', label: '产品名', value_type: 'text', default_selected: true },
  { key: 'primary_metric', label: '主指标', value_type: 'text', default_selected: true },
  { key: 'current_value', label: '当前表现', value_type: 'text', default_selected: true },
  { key: 'target_value', label: '目标表现', value_type: 'text', default_selected: true },
  { key: 'volume_reference', label: '量级参考', value_type: 'text', default_selected: true },
  { key: 'action', label: '建议动作', value_type: 'text', default_selected: true },
  { key: 'reason', label: '建议理由', value_type: 'text', default_selected: true },
  {
    key: 'execution_status',
    label: EXECUTION_STATUS_FIELD_LABEL,
    value_type: 'single_select',
    default_selected: true,
    options: EXECUTION_STATUS_OPTIONS
  },
  { key: 'is_adopted', label: ADOPTED_FIELD_LABEL, value_type: 'checkbox', default_selected: true },
  { key: 'validation_result', label: MANUAL_REVIEW_FIELD_LABEL, value_type: 'text', default_selected: true },
  { key: 'seven_day_later_data', label: SEVEN_DAY_LATER_FIELD_LABEL, value_type: 'text', default_selected: true }
];

const BITABLE_SOURCE_DEFINITIONS: Record<string, BitableSourceDefinition> = {
  [NON_ASA_SOURCE_TYPE]: {
    source_type: NON_ASA_SOURCE_TYPE,
    label: '非 ASA 执行表',
    target_table_hint: '在同一个飞书 Base 内按数据日期新增非 ASA 执行表，同日重跑只刷新当天表，历史日期自动留档。',
    default_table_name_prefix: `${ACTION_TABLE_NAME_BASE}-非ASA`,
    fields: NON_ASA_ACTION_FIELDS,
    primary_field_key: 'display_item_name',
    primary_field_label: ITEM_NAME_FIELD_LABEL
  },
  [ASA_SOURCE_TYPE]: {
    source_type: ASA_SOURCE_TYPE,
    label: 'ASA 关键词执行表',
    target_table_hint: '在同一个飞书 Base 内按数据日期新增 ASA 关键词执行表，按关键词 / 广告系列 / 广告组显式分列承接执行与反馈。',
    default_table_name_prefix: `${ACTION_TABLE_NAME_BASE}-ASA`,
    fields: ASA_ACTION_FIELDS,
    primary_field_key: 'item_name',
    primary_field_label: KEYWORD_FIELD_LABEL
  }
};

export function activeBitableExportSourceTypes(): BitableExportSourceType[] {
  return [...ACTIVE_SOURCE_TYPES];
}

function isActiveBitableExportSourceType(sourceType: BitableExportSourceType): boolean {
  return activeBitableExportSourceTypes().includes(sourceType);
}

function legacyFeedbackFallbackSourceType(sourceType: BitableExportSourceType): BitableExportSourceType | null {
  return sourceType === NON_ASA_SOURCE_TYPE || sourceType === ASA_SOURCE_TYPE ? LEGACY_SOURCE_TYPE : null;
}

function sourceDefinition(sourceType: BitableExportSourceType): BitableSourceDefinition {
  const definition = BITABLE_SOURCE_DEFINITIONS[sourceType];
  if (!definition) {
    throw new Error('unsupported_bitable_source_type');
  }
  return definition;
}

function defaultSelectedFields(sourceType: BitableExportSourceType): string[] {
  return sourceDefinition(sourceType).fields.filter((field) => field.default_selected).map((field) => field.key);
}

function fieldCatalog(sourceType: BitableExportSourceType): BitableFieldDefinition[] {
  return sourceDefinition(sourceType).fields;
}

function defaultConfig(sourceType: BitableExportSourceType): BitableExportConfigRecord {
  const definition = sourceDefinition(sourceType);
  return {
    id: 0,
    source_type: sourceType,
    enabled: true,
    target_table_id: null,
    target_table_name: null,
    table_name_prefix: definition.default_table_name_prefix,
    chat_id: null,
    selected_fields: defaultSelectedFields(sourceType),
    last_status: 'idle',
    last_error: null,
    last_synced_at: null,
    last_record_count: 0,
    created_at: '',
    updated_at: ''
  };
}

function mergeConfig(sourceType: BitableExportSourceType, dbConfig?: BitableExportConfigRecord | null): BitableExportConfigRecord {
  const base = defaultConfig(sourceType);
  if (!dbConfig) {
    return base;
  }
  return {
    ...base,
    ...dbConfig,
    selected_fields: base.selected_fields,
    target_table_id: dbConfig.target_table_id || base.target_table_id,
    target_table_name: dbConfig.target_table_name || base.target_table_name,
    table_name_prefix: normalizeTableNamePrefix(dbConfig.table_name_prefix || base.table_name_prefix, sourceType)
  };
}

function normalizeTableNamePrefix(value: string | null | undefined, sourceType: BitableExportSourceType): string {
  const fallback = sourceDefinition(sourceType).default_table_name_prefix;
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ') || fallback;
}

function buildDailyTableName(prefix: string, reportDate: string): string {
  return `${String(prefix || '').trim()}_${String(reportDate || '').trim()}`;
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
  if (field.key === 'display_item_name') {
    return String(value ?? '').trim() || '未命名投放项';
  }
  if (field.key === 'display_product_name') {
    return String(value ?? '').trim() || '未命名产品';
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

function fieldDefinitionForLabel(sourceType: BitableExportSourceType, label: string): BitableFieldDefinition | null {
  return fieldCatalog(sourceType).find((field) => field.label === label) ?? null;
}

function fieldDefinitionForKey(sourceType: BitableExportSourceType, key: string): BitableFieldDefinition | null {
  return fieldCatalog(sourceType).find((field) => field.key === key) ?? null;
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
  const legacyPull = bySource.get('pull_daily' as BitableExportSourceType);
  const legacyAsa = bySource.get('asa_raw' as BitableExportSourceType);
  const legacyDelivery = bySource.get(LEGACY_SOURCE_TYPE);
  const legacyConflict = hasLegacyConfigConflict(legacyPull, legacyAsa);
  const legacySeed = legacyDelivery ?? legacyPull ?? legacyAsa;
  const legacyChatId = normalizeChatId(legacySeed?.chat_id);
  const legacyEnabled = Boolean(legacySeed?.enabled);

  for (const sourceType of activeBitableExportSourceTypes()) {
    const existing = bySource.get(sourceType);
    if (existing) {
      if (!String(existing.table_name_prefix || '').trim()) {
        await upsertBitableExportConfig({
          source_type: sourceType,
          table_name_prefix: normalizeTableNamePrefix(null, sourceType),
          selected_fields: defaultSelectedFields(sourceType)
        });
      }
      continue;
    }

    if (legacyConflict && !legacyDelivery) {
      await upsertBitableExportConfig({
        source_type: sourceType,
        enabled: true,
        chat_id: null,
        table_name_prefix: normalizeTableNamePrefix(null, sourceType),
        selected_fields: defaultSelectedFields(sourceType)
      });
      await updateBitableExportSyncResult({
        source_type: sourceType,
        table_name_prefix: normalizeTableNamePrefix(null, sourceType),
        last_status: 'failed',
        last_error: LEGACY_CONFIG_CONFLICT_ERROR,
        last_synced_at: null,
        last_record_count: 0
      });
      continue;
    }

    await upsertBitableExportConfig({
      source_type: sourceType,
      enabled: legacyEnabled,
      chat_id: legacyChatId || null,
      table_name_prefix: normalizeTableNamePrefix(null, sourceType),
      selected_fields: defaultSelectedFields(sourceType)
    });
  }
}

function normalizeSelectedFields(sourceType: BitableExportSourceType, _selectedFields: string[]): string[] {
  return defaultSelectedFields(sourceType);
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

function normalizeDisplaySegment(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || text === '-' || text.toLowerCase() === 'unknown') {
    return '';
  }
  return text;
}

function joinDisplaySegments(parts: unknown[]): string {
  return parts.map((part) => normalizeDisplaySegment(part)).filter(Boolean).join('｜');
}

function formatProductDisplayName(productName: string, platformRaw: string): string {
  const base = String(productName || '').trim() || '未命名产品';
  const platformText = platformLabel(String(platformRaw || '').trim().toLowerCase());
  if (!platformText || platformText === '未知') {
    return base;
  }
  return `${base}（${platformText}）`;
}

function formatBudgetItemDisplayName(row: Record<string, unknown>): string {
  return (
    joinDisplaySegments([row.media_source, row.item_name, row.match_type]) ||
    String(row.item_name || row.media_source || '').trim() ||
    '未命名投放项'
  );
}

function formatAsaItemDisplayName(row: Record<string, unknown>): string {
  return (
    joinDisplaySegments([row.item_name, row.campaign, row.adset]) ||
    String(row.item_name || row.campaign || row.adset || '').trim() ||
    '未命名投放项'
  );
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

function formatActionDisplay(action: string, changeRatio: unknown, executionSummary = ''): string {
  const baseAction = formatActionSummary(action, changeRatio);
  const normalizedExecutionSummary = String(executionSummary || '').trim();
  if (!normalizedExecutionSummary) {
    return baseAction;
  }
  return `${baseAction} / ${normalizedExecutionSummary}`;
}

function parseLlmSummary(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function formatReasonSummary(summary: unknown, reasonCode: unknown, llmSummary: unknown = null): string {
  const parsed = parseLlmSummary(llmSummary);
  const summaryText =
    String(summary || parsed.summary_cn || reasonCode || '').trim() || '暂无补充说明';
  const explanationPoints = Array.isArray(parsed.explanation_points)
    ? parsed.explanation_points
        .map((item) => String(item || '').trim())
        .filter((item) => item && item !== summaryText)
        .slice(0, 2)
    : [];
  return [summaryText, ...explanationPoints].join('；');
}

function formatRoasPercent(value: unknown): string {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function formatRoasSourceLabel(row: Record<string, unknown>): string {
  return String(row.roas_primary_source || '') === 'af_cohort' ? 'AF Cohort 主口径' : '本地回退口径';
}

function formatRoasWarningLabel(row: Record<string, unknown>): string {
  const warningCode = String(row.roas_warning_code || '');
  if (warningCode === 'af_missing') {
    return 'AF 缺失，当前为本地派生，仅供参考';
  }
  if (warningCode === 'af_vs_local_mismatch') {
    return 'AF 与本地派生偏差较大，已禁止自动动作';
  }
  if (warningCode === 'af_grain_unavailable') {
    return '当前粒度无 AF 官方 ROAS，已回退本地派生';
  }
  return '';
}

function canDisplayStrictAsaRoas(row: Record<string, unknown>): boolean {
  return String(row.roas_primary_source || '') === 'af_cohort' && String(row.roas_warning_code || '') !== 'af_vs_local_mismatch';
}

function hiddenAsaRoasLabel(row: Record<string, unknown>): string {
  if (String(row.roas_warning_code || '') === 'af_vs_local_mismatch') {
    return 'AF 官方成熟窗口 ROAS 与本地派生偏差较大，当前不展示数值';
  }
  if (String(row.roas_primary_source || '') !== 'af_cohort') {
    return 'AF 官方成熟窗口 ROAS 缺失，当前不展示回退值';
  }
  return 'ROAS 当前不可展示';
}

function formatBudgetCurrentValue(row: Record<string, unknown>): string {
  if (String(row.primary_metric || '') === 'roas') {
    const currentRoas = Number(row.current_roas || 0);
    const currentEcpi = Number(row.current_ecpi || 0);
    const roasStatus = String(row.roas_data_status || '');
    const sourceSuffix = ` / ${formatRoasSourceLabel(row)}${formatRoasWarningLabel(row) ? `（${formatRoasWarningLabel(row)}）` : ''}`;
    if (roasStatus === 'pending' || String(row.metric_mode || '') === 'roas_pending_revenue') {
      return `成熟窗口 ROAS 回流中 / 近7日 eCPI $${currentEcpi.toFixed(2)}${sourceSuffix}`;
    }
    if (roasStatus === 'partial') {
      return `成熟窗口 ROAS ${formatRoasPercent(currentRoas)}（按已覆盖成本计算） / 近7日 eCPI $${currentEcpi.toFixed(2)}${sourceSuffix}`;
    }
    if (roasStatus === 'partial_low') {
      return `成熟窗口 ROAS ${formatRoasPercent(currentRoas)}（覆盖率偏低，仅供参考） / 近7日 eCPI $${currentEcpi.toFixed(2)}${sourceSuffix}`;
    }
    if (roasStatus === 'unavailable') {
      return `成熟窗口 ROAS 暂无数据 / 近7日 eCPI $${currentEcpi.toFixed(2)}${sourceSuffix}`;
    }
    return `成熟窗口 ROAS ${formatRoasPercent(currentRoas)} / 近7日 eCPI $${currentEcpi.toFixed(2)}${sourceSuffix}`;
  }
  return `eCPI $${Number(row.current_ecpi || 0).toFixed(2)}`;
}

function formatAfDashboardCurrentValue(params: {
  reportDate: string;
  metric: AfDashboardCampaignMetric | null;
  decisionReference: string;
  primaryMetric: string;
}): string {
  const windowLabel = `${params.reportDate} 至 ${params.reportDate}`;
  if (!params.metric) {
    return `AF面板 ${windowLabel}：暂无官方快照 / 决策参考：${params.decisionReference}`;
  }

  const base = [
    `AF面板 ${windowLabel}`,
    `Cost $${params.metric.cost.toFixed(2)}`,
    `Attributions ${params.metric.attributions.toFixed(0)}`,
    `eCPI $${params.metric.ecpi.toFixed(2)}`
  ].join(' / ');

  // AppsFlyer daily_report_v5 is aligned with the dashboard cost/eCPI rows, but it does
  // not expose the dashboard-only D0/D7 ROAS-Tool columns shown in AppsFlyer UI.
  // Until a same-surface ROAS-Tool snapshot is ingested, never substitute mature Cohort ROAS
  // as the official dashboard ROAS value.
  if (params.primaryMetric === 'roas') {
    return `${base} / D0/D7 ROAS-Tool 待接入官方面板快照 / 决策参考：${params.decisionReference}`;
  }
  return `${base} / 决策参考：${params.decisionReference}`;
}

async function alignBudgetRowsToAfDashboard(
  reportDate: string,
  rows: DeliveryActionRow[]
): Promise<DeliveryActionRow[]> {
  const budgetRows = rows.filter((row) => row.recommendation_type === 'budget');
  if (budgetRows.length === 0) {
    return rows;
  }

  const metrics = await queryAfDashboardDailyCampaignMetrics({
    reportDate,
    campaigns: budgetRows.map((row) => row.item_name)
  });

  return rows.map((row) => {
    if (row.recommendation_type !== 'budget') {
      return row;
    }
    const metric =
      metrics.get(
        afDashboardCampaignKey({
          appKey: row.app_key,
          platform: row.platform_raw,
          campaign: row.item_name
        })
      ) || null;

    return {
      ...row,
      current_value: formatAfDashboardCurrentValue({
        reportDate,
        metric,
        decisionReference: row.current_value,
        primaryMetric: row.primary_metric.startsWith('ROAS') ? 'roas' : 'ecpi'
      }),
      cost_reference: metric ? metric.cost : row.cost_reference,
      volume_reference: metric
        ? `AF面板安装 ${metric.attributions.toFixed(0)} / 点击 ${metric.clicks.toFixed(0)}`
        : row.volume_reference
    };
  });
}

function formatBudgetTargetValue(row: Record<string, unknown>): string {
  if (String(row.primary_metric || '') === 'roas') {
    const targetRoas = Number(row.target_roas || 0);
    const targetEcpi = Number(row.target_ecpi || 0);
    return `目标 ROAS ${formatRoasPercent(targetRoas)} / 目标 eCPI $${targetEcpi.toFixed(2)}`;
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
    const sourceSuffix = ` / ${formatRoasSourceLabel(row)}${formatRoasWarningLabel(row) ? `（${formatRoasWarningLabel(row)}）` : ''}`;
    const strictRoasDisplay = canDisplayStrictAsaRoas(row);
    if (roasStatus === 'pending') {
      return `ROAS 待补齐 / CPP 待补齐${sourceSuffix}`;
    }
    if (roasStatus === 'partial') {
      if (!strictRoasDisplay) {
        return `${hiddenAsaRoasLabel(row)} / CPP $${Number(row.current_cpp || 0).toFixed(2)}（按已覆盖成本计算）${sourceSuffix}`;
      }
      return `ROAS ${formatRoasPercent(row.current_d7_roas)}（按已覆盖成本计算） / CPP $${Number(row.current_cpp || 0).toFixed(2)}（按已覆盖成本计算）${sourceSuffix}`;
    }
    if (roasStatus === 'partial_low') {
      if (!strictRoasDisplay) {
        return `${hiddenAsaRoasLabel(row)} / CPP $${Number(row.current_cpp || 0).toFixed(2)}（覆盖率偏低，仅供参考）${sourceSuffix}`;
      }
      return `ROAS ${formatRoasPercent(row.current_d7_roas)}（覆盖率偏低，仅供参考） / CPP $${Number(row.current_cpp || 0).toFixed(2)}（覆盖率偏低，仅供参考）${sourceSuffix}`;
    }
    if (roasStatus === 'unavailable') {
      return `ROAS 暂无成熟数据 / CPP 暂无成熟数据${sourceSuffix}`;
    }
    if (!strictRoasDisplay) {
      return `${hiddenAsaRoasLabel(row)} / CPP $${Number(row.current_cpp || 0).toFixed(2)}${sourceSuffix}`;
    }
    return `ROAS ${formatRoasPercent(row.current_d7_roas)} / CPP $${Number(row.current_cpp || 0).toFixed(2)}${sourceSuffix}`;
  }
  const ecpi = Number(row.current_ecpi || 0);
  return ecpi > 0 ? `eCPI $${ecpi.toFixed(2)}` : 'eCPI —（有花费无安装）';
}

function formatAsaTargetValue(row: Record<string, unknown>): string {
  if (String(row.primary_metric || '') === 'd7_roas_cpp') {
    return `目标 ROAS ${formatRoasPercent(row.target_d7_roas)} / 目标 CPP $${Number(row.target_cpp || 0).toFixed(2)}`;
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
        br.af_cohort_roas,
        br.local_derived_roas,
        br.roas_primary_source,
        br.roas_warning_code,
        br.roas_deviation_ratio,
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
        COALESCE(br.llm_summary, '{}'::jsonb) AS llm_summary,
        br.updated_at::text AS updated_at
       FROM budget_recommendations br
       JOIN apps a ON a.app_key = br.app_key
       LEFT JOIN keyword_lifecycle_states ks
         ON ks.app_key = br.app_key
        AND ks.platform = br.platform
        AND ks.keyword = br.keyword
        AND ks.match_type = br.match_type
      WHERE br.date = $1::date
        AND LOWER(TRIM(br.media_source)) <> $2
        ${statusClause}
      ORDER BY br.updated_at DESC,
      br.id DESC`,
    [reportDate, ASA_MEDIA_SOURCE]
  );

  return result.rows.map((row) => {
    const rawProductName = String(row.product_name || row.app_key || '');
    const platformRaw = String(row.platform || 'unknown').trim().toLowerCase();
    const rawItemName = String(row.item_name || '').trim();
    const executionSummary = formatExecutionActionSummary(row.execution_actions);

    return {
      recommendation_type: 'budget',
      recommendation_id: Number(row.recommendation_id || 0),
      app_key: String(row.app_key || ''),
      serial_no: 0,
      report_date: String(row.report_date || reportDate),
      platform_raw: platformRaw,
      product_name: rawProductName,
      display_product_name: formatProductDisplayName(rawProductName, platformRaw),
      platform: platformLabel(platformRaw),
      media_source: String(row.media_source || '未知媒体'),
      item_type: '通用投放',
      item_name: rawItemName,
      display_item_name: formatBudgetItemDisplayName(row),
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
      action: formatActionDisplay(String(row.action || 'hold'), row.change_ratio, executionSummary),
      execution_status: EXECUTION_STATUS_DEFAULT,
      validation_result: '',
      is_adopted: false,
      reason: formatReasonSummary(row.reason_summary, row.reason_code, row.llm_summary)
    };
  });
}

async function queryAsaActionRows(reportDate: string, options: BitableExportRunOptions = {}): Promise<DeliveryActionRow[]> {
  const statusClause = options.includeAllStatuses ? '' : `AND ar.status = 'pending'`;
  await ensureAsaKeywordRoasSchema();
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
        ar.af_cohort_roas,
        ar.local_derived_roas,
        ar.roas_primary_source,
        ar.roas_warning_code,
        ar.roas_deviation_ratio,
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
        COALESCE(ar.llm_summary, '{}'::jsonb) AS llm_summary,
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

  return result.rows.map((row) => {
    const rawProductName = String(row.product_name || row.app_key || '');
    const platformRaw = String(row.platform || 'unknown').trim().toLowerCase();
    const rawItemName = String(row.item_name || '').trim();

    return {
      recommendation_type: 'asa_keyword',
      recommendation_id: Number(row.recommendation_id || 0),
      app_key: String(row.app_key || ''),
      serial_no: 0,
      report_date: String(row.report_date || reportDate),
      platform_raw: platformRaw,
      product_name: rawProductName,
      display_product_name: formatProductDisplayName(rawProductName, platformRaw),
      platform: platformLabel(platformRaw),
      media_source: 'Apple Search Ads',
      item_type: 'ASA 关键词',
      item_name: rawItemName,
      display_item_name: formatAsaItemDisplayName(row),
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
      action: formatActionDisplay(String(row.action || 'hold'), row.change_ratio),
      execution_status: EXECUTION_STATUS_DEFAULT,
      validation_result: '',
      is_adopted: false,
      reason: formatReasonSummary(row.reason_summary, row.reason_code, row.llm_summary)
    };
  });
}

async function queryRowsForSource(
  sourceType: BitableExportSourceType,
  reportDate: string,
  options: BitableExportRunOptions = {}
): Promise<{ rows: DeliveryActionRow[]; breakdown: { campaign_actions: number; asa_actions: number } }> {
  if (sourceType === NON_ASA_SOURCE_TYPE) {
    const campaignRows = await queryBudgetActionRows(reportDate, options);
    const alignedRows = await alignBudgetRowsToAfDashboard(reportDate, campaignRows);
    return {
      rows: alignedRows,
      breakdown: {
        campaign_actions: alignedRows.length,
        asa_actions: 0
      }
    };
  }

  if (sourceType === ASA_SOURCE_TYPE) {
    const asaRows = await queryAsaActionRows(reportDate, options);
    return {
      rows: asaRows,
      breakdown: {
        campaign_actions: 0,
        asa_actions: asaRows.length
      }
    };
  }

  throw new Error('unsupported_bitable_source_type');
}

async function listHistoricalReportDatesForSource(sourceType: BitableExportSourceType): Promise<string[]> {
  if (sourceType === NON_ASA_SOURCE_TYPE) {
    const result = await pgQuery<{ report_date: string }>(
      `SELECT DISTINCT date::text AS report_date
         FROM budget_recommendations
        WHERE date IS NOT NULL
        ORDER BY report_date ASC`
    );
    return result.rows.map((row) => String(row.report_date || '').trim()).filter(Boolean);
  }
  if (sourceType === ASA_SOURCE_TYPE) {
    const result = await pgQuery<{ report_date: string }>(
      `SELECT DISTINCT date::text AS report_date
         FROM asa_keyword_recommendations
        WHERE date IS NOT NULL
        ORDER BY report_date ASC`
    );
    return result.rows.map((row) => String(row.report_date || '').trim()).filter(Boolean);
  }
  throw new Error('unsupported_bitable_source_type');
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
  sourceType: BitableExportSourceType,
  config: BitableExportConfigRecord,
  reportDate: string
): Promise<ResolvedActionTable> {
  const normalizedPrefix = normalizeTableNamePrefix(config.table_name_prefix, sourceType);
  const targetName = buildDailyTableName(normalizedPrefix, reportDate);
  const archived = reportDate ? await getBitableExportDailyTable(sourceType, reportDate) : null;
  const tables = await listBitableTables(appToken);

  const byArchivedId =
    archived?.table_id && tables.find((table) => table.table_id === archived.table_id);
  if (byArchivedId) {
    return {
      ...byArchivedId,
      is_new: false
    };
  }

  const archivedName = String(archived?.table_name || '').trim();
  const byArchivedName =
    archivedName && tables.find((table) => table.name === archivedName);
  if (byArchivedName) {
    return {
      ...byArchivedName,
      is_new: false
    };
  }

  const byTargetName = tables.find((table) => table.name === targetName);
  if (byTargetName) {
    return {
      ...byTargetName,
      is_new: false
    };
  }

  return {
    ...(await createBitableTable(appToken, targetName)),
    is_new: true
  };
}

function selectedFieldDefinitions(sourceType: BitableExportSourceType, selectedFields: string[]): BitableFieldDefinition[] {
  const normalized = new Set(normalizeSelectedFields(sourceType, selectedFields));
  return fieldCatalog(sourceType).filter((field) => normalized.has(field.key));
}

function desiredFieldLabels(sourceType: BitableExportSourceType, selectedFields: string[]): string[] {
  return selectedFieldDefinitions(sourceType, selectedFields).map((field) => field.label);
}

async function ensureTableFields(
  appToken: string,
  sourceType: BitableExportSourceType,
  tableId: string,
  selectedFields: string[],
  options: BitableFieldSyncOptions,
  logger?: LoggerLike
): Promise<BitableFieldSyncResult> {
  const existingFields = await listBitableFields(appToken, tableId);
  if (existingFields.length === 0) {
    throw new Error('bitable_primary_field_missing');
  }
  const fieldsByName = new Map(existingFields.map((field) => [field.field_name, field]));
  const cleanupLabels: string[] = [];
  const definition = sourceDefinition(sourceType);
  const required = selectedFieldDefinitions(sourceType, selectedFields);
  const requiredLabels = new Set(required.map((field) => field.label));
  const primaryField = existingFields[0];
  const primaryFieldDefinition = fieldDefinitionForKey(sourceType, definition.primary_field_key);
  if (!primaryFieldDefinition) {
    throw new Error('bitable_primary_field_definition_missing');
  }

  const duplicatePrimaryField = fieldsByName.get(definition.primary_field_label);
  if (duplicatePrimaryField?.field_id && duplicatePrimaryField.field_id !== primaryField.field_id) {
    await deleteBitableField(appToken, tableId, duplicatePrimaryField.field_id);
    fieldsByName.delete(definition.primary_field_label);
  }

  const primaryFieldSpec = fieldTypeToFeishu(primaryFieldDefinition);
  if (primaryField.field_name !== definition.primary_field_label || primaryField.type !== primaryFieldSpec.type) {
    await updateBitableField(appToken, tableId, primaryField.field_id, primaryFieldDefinition);
    fieldsByName.delete(primaryField.field_name);
    fieldsByName.set(definition.primary_field_label, {
      ...primaryField,
      field_name: definition.primary_field_label,
      type: primaryFieldSpec.type
    });
  }

  const manualReviewField = fieldDefinitionForLabel(sourceType, MANUAL_REVIEW_FIELD_LABEL);
  const legacyManualReviewField = fieldsByName.get(LEGACY_MANUAL_REVIEW_FIELD_LABEL);
  if (manualReviewField && legacyManualReviewField && !fieldsByName.has(MANUAL_REVIEW_FIELD_LABEL)) {
    await updateBitableField(appToken, tableId, legacyManualReviewField.field_id, manualReviewField);
    fieldsByName.delete(LEGACY_MANUAL_REVIEW_FIELD_LABEL);
    fieldsByName.set(MANUAL_REVIEW_FIELD_LABEL, {
      ...legacyManualReviewField,
      field_name: MANUAL_REVIEW_FIELD_LABEL
    });
  }

  const executionStatusField = fieldDefinitionForLabel(sourceType, EXECUTION_STATUS_FIELD_LABEL);
  const existingExecutionStatusField = fieldsByName.get(EXECUTION_STATUS_FIELD_LABEL);
  if (
    executionStatusField &&
    existingExecutionStatusField?.field_id &&
    existingExecutionStatusField.type !== FEISHU_SINGLE_SELECT_FIELD_TYPE
  ) {
    if (options.allowDestructiveFieldRebuild) {
      await deleteBitableField(appToken, tableId, existingExecutionStatusField.field_id);
      await createBitableField(appToken, tableId, executionStatusField);
      fieldsByName.delete(EXECUTION_STATUS_FIELD_LABEL);
      logger?.info?.('bitable_execution_status_field_recreated', {
        table_id: tableId,
        previous_type: existingExecutionStatusField.type,
        next_type: FEISHU_SINGLE_SELECT_FIELD_TYPE
      });
    } else {
      logger?.warn?.('bitable_execution_status_field_rebuild_skipped', {
        table_id: tableId,
        previous_type: existingExecutionStatusField.type,
        next_type: FEISHU_SINGLE_SELECT_FIELD_TYPE
      });
    }
  }

  for (const field of required) {
    if (field.label === definition.primary_field_label) {
      continue;
    }
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
            : field.value_type === 'number'
              ? 2
              : 1
    });
  }

  if (options.cleanupExtraFields) {
    for (const field of fieldsByName.values()) {
      if (!field?.field_id || requiredLabels.has(field.field_name)) {
        continue;
      }
      try {
        await deleteBitableField(appToken, tableId, field.field_id);
        fieldsByName.delete(field.field_name);
      } catch (error) {
        cleanupLabels.push(field.field_name);
        logger?.warn?.('bitable_delete_field_failed', {
          table_id: tableId,
          field_name: field.field_name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return {
    cleanup_labels: cleanupLabels
  };
}

function shouldCompactActionTableSchema(reportDate: string, tableIsNew: boolean): boolean {
  return tableIsNew || reportDate >= getPreviousDateString(1);
}

function actionFieldsNeedReorder(
  sourceType: BitableExportSourceType,
  existingFields: BitableFieldRecord[],
  selectedFields: string[]
): boolean {
  const expectedLabels = desiredFieldLabels(sourceType, selectedFields);
  const currentRelevantLabels = existingFields
    .map((field) => field.field_name)
    .filter((label) => expectedLabels.includes(label));

  if (currentRelevantLabels.length !== expectedLabels.length) {
    return true;
  }

  return expectedLabels.some((label, index) => currentRelevantLabels[index] !== label);
}

async function reorderActionFields(
  appToken: string,
  sourceType: BitableExportSourceType,
  tableId: string,
  selectedFields: string[],
  logger?: LoggerLike
): Promise<void> {
  const existingFields = await listBitableFields(appToken, tableId);
  const definition = sourceDefinition(sourceType);
  if (!actionFieldsNeedReorder(sourceType, existingFields, selectedFields)) {
    return;
  }

  if (!existingFields[0] || existingFields[0].field_name !== definition.primary_field_label) {
    throw new Error('bitable_primary_field_not_ready');
  }

  const fieldsByName = new Map(existingFields.map((field) => [field.field_name, field]));
  const labelsToRebuild = desiredFieldLabels(sourceType, selectedFields).filter((label) => label !== definition.primary_field_label);
  if (labelsToRebuild.length === 0) {
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
    const fieldDefinition = fieldDefinitionForLabel(sourceType, label);
    if (!fieldDefinition) {
      continue;
    }
    await createBitableField(appToken, tableId, fieldDefinition);
  }

  for (const record of preservedValues) {
    const fields: Record<string, unknown> = {};
    for (const label of labelsToRebuild) {
      const fieldDefinition = fieldDefinitionForLabel(sourceType, label);
      if (!fieldDefinition) {
        continue;
      }
      const value = serializeFieldValue(fieldDefinition, record.fields[label]);
      if (value !== undefined) {
        fields[label] = value;
      }
    }
    if (Object.keys(fields).length === 0) {
      continue;
    }
    await updateBitableRecord(appToken, tableId, record.record_id, fields);
  }

  logger?.info?.('bitable_action_fields_reordered', {
    table_id: tableId,
    labels: labelsToRebuild
  });
}

async function loadExistingRecordRefs(
  sourceType: BitableExportSourceType,
  reportDate: string,
  tableId: string
): Promise<BitableRecordRef[]> {
  const refs = await listBitableExportRecordRefs(sourceType, reportDate, tableId);
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
  logger?: LoggerLike,
  liveRecordsInput?: BitableRecordItem[]
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
    liveRecords = liveRecordsInput ?? (await listBitableRecords(appToken, tableId));
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

async function buildPersistedFeedbackMap(sourceType: BitableExportSourceType, rows: DeliveryActionRow[]): Promise<{
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
  const feedbacks = await listRecommendationExecutionFeedbacksByRecommendations(sourceType, keys);
  const fallbackSourceType = legacyFeedbackFallbackSourceType(sourceType);
  const fallbackFeedbacks =
    fallbackSourceType && fallbackSourceType !== sourceType
      ? await listRecommendationExecutionFeedbacksByRecommendations(fallbackSourceType, keys)
      : [];
  const feedbackByRecommendation = new Map(
    fallbackFeedbacks.map((row) => [`${row.recommendation_type}:${row.recommendation_id}`, row])
  );
  for (const row of feedbacks) {
    feedbackByRecommendation.set(`${row.recommendation_type}:${row.recommendation_id}`, row);
  }
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
  sourceType: BitableExportSourceType,
  row: DeliveryActionRow,
  selectedFields: string[],
  _syncedAtMillis: number
): Record<string, unknown> {
  const catalog = fieldCatalog(sourceType);
  const selected = new Set(selectedFields);
  const result: Record<string, unknown> = {};
  for (const field of catalog) {
    if (!selected.has(field.key)) {
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
	  const breakdownLines = [
	    `**总条数**：${result.record_count}`,
	    `**官方快照**：${result.official_snapshot.snapshot_id}（${result.official_snapshot.status}，组件 ${result.official_snapshot.snapshot_count} 个）`,
	    result.breakdown.campaign_actions > 0 || result.source_type === NON_ASA_SOURCE_TYPE
      ? `**非 ASA 执行项**：${result.breakdown.campaign_actions}`
      : '',
    result.breakdown.asa_actions > 0 || result.source_type === ASA_SOURCE_TYPE
      ? `**ASA 关键词**：${result.breakdown.asa_actions}`
      : '',
    `**清理旧记录**：${result.deleted_count}`
  ]
    .filter(Boolean)
    .join('\n');
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: `${result.label}｜${result.report_date}`
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
            `${breakdownLines}\n` +
            `**说明**：${detailText}`
        }
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `打开${result.label}` },
            type: 'primary',
            url: result.table_url
          }
        ]
      }
    ]
  };
}

function buildSourceSnapshot(
  sourceType: BitableExportSourceType,
  config: BitableExportConfigRecord,
  feedbackSync: Awaited<ReturnType<typeof getBitableFeedbackSyncSnapshot>>,
  recentTables: BitableExportDailyTableRecord[]
): BitableSourceSnapshot {
  const definition = sourceDefinition(sourceType);
  const recentTableSnapshots = recentTables.map((table) => mapDailyTableSnapshot(table));
  const latestTableUrl = baseTableUrl(config.target_table_id || '') || recentTableSnapshots[0]?.table_url || '';
  return {
    source_type: sourceType,
    label: definition.label,
    fields: definition.fields,
    config,
    table_url: latestTableUrl,
    latest_table_url: latestTableUrl,
    target_table_hint: definition.target_table_hint,
    recent_tables: recentTableSnapshots,
    feedback_sync: feedbackSync
  };
}

export async function getBitableExportConfigsSnapshot(): Promise<{ sources: BitableSourceSnapshot[] }> {
  await ensureDefaultConfigs();
  const sources = await Promise.all(
    activeBitableExportSourceTypes().map(async (sourceType) => {
      const [config, feedbackSync, recentTables] = await Promise.all([
        getBitableExportConfig(sourceType).then((row) => mergeConfig(sourceType, row)),
        getBitableFeedbackSyncSnapshot(sourceType),
        listBitableExportDailyTables(sourceType, RECENT_DAILY_TABLE_LIMIT)
      ]);
      return buildSourceSnapshot(sourceType, config, feedbackSync, recentTables);
    })
  );
  return {
    sources
  };
}

export async function saveBitableExportConfig(input: {
  sourceType: BitableExportSourceType;
  enabled: boolean;
  chatId: string;
  tableNamePrefix: string;
}): Promise<BitableSourceSnapshot> {
  if (!isActiveBitableExportSourceType(input.sourceType)) {
    throw new Error('unsupported_bitable_source_type');
  }
  await ensureDefaultConfigs();
  const saved = await upsertBitableExportConfig({
    source_type: input.sourceType,
    enabled: input.enabled,
    chat_id: input.chatId,
    table_name_prefix: normalizeTableNamePrefix(input.tableNamePrefix, input.sourceType),
    selected_fields: defaultSelectedFields(input.sourceType)
  });
  let merged = mergeConfig(input.sourceType, saved);
  if (String(merged.last_error || '') === LEGACY_CONFIG_CONFLICT_ERROR) {
    const cleared = await updateBitableExportSyncResult({
      source_type: input.sourceType,
      target_table_id: merged.target_table_id,
      target_table_name: merged.target_table_name,
      table_name_prefix: merged.table_name_prefix,
      last_status: 'idle',
      last_error: null,
      last_synced_at: merged.last_synced_at,
      last_record_count: merged.last_record_count
    });
    merged = mergeConfig(input.sourceType, cleared);
  }
  const [feedbackSync, recentTables] = await Promise.all([
    getBitableFeedbackSyncSnapshot(input.sourceType),
    listBitableExportDailyTables(input.sourceType, RECENT_DAILY_TABLE_LIMIT)
  ]);
  return buildSourceSnapshot(input.sourceType, merged, feedbackSync, recentTables);
}

export async function runBitableExport(
  sourceType: BitableExportSourceType,
  reportDate: string,
  logger?: LoggerLike,
  options: BitableExportRunOptions = {}
): Promise<BitableExportRunResult> {
  if (!isActiveBitableExportSourceType(sourceType)) {
    throw new Error('unsupported_bitable_source_type');
  }
  const definition = sourceDefinition(sourceType);
  const exportResult = await withBitableSourceIOLock(sourceType, async () => {
    await ensureDefaultConfigs();
    const appToken = String(env.feishuBitableAppToken || '').trim();
    if (!appToken) {
      throw new Error('Missing FEISHU_BITABLE_APP_TOKEN');
    }
    const config = mergeConfig(sourceType, await getBitableExportConfig(sourceType));
    const tableNamePrefix = normalizeTableNamePrefix(config.table_name_prefix, sourceType);
    const selectedFields = defaultSelectedFields(sourceType);
    const notifyEnabled = options.notify !== false;
    const chatId = String(config.chat_id || '').trim();
    if (notifyEnabled && !chatId) {
      throw new Error(`${definition.label} 未配置 Chat ID`);
    }

    const table = await resolveActionTable(appToken, sourceType, config, reportDate);
    const existingTableRecords = await listBitableRecords(appToken, table.table_id);
    const existingTableRecordIds = existingTableRecords.map((record) => record.record_id);
    const compactSchema = shouldCompactActionTableSchema(reportDate, table.is_new);
    const oldRecords = await loadExistingRecordRefs(sourceType, reportDate, table.table_id);
    const liveFeedback = await buildManualFeedbackMap(
      appToken,
      table.table_id,
      oldRecords,
      logger,
      existingTableRecords
    );
    if (!compactSchema) {
      logger?.info?.('bitable_schema_compaction_skipped_for_historical_table', {
        source_type: sourceType,
        report_date: reportDate,
        table_id: table.table_id
      });
    }
    const fieldSync = await ensureTableFields(
      appToken,
      sourceType,
      table.table_id,
      selectedFields,
      {
        cleanupExtraFields: compactSchema,
        allowDestructiveFieldRebuild: existingTableRecordIds.length === 0
      },
      logger
    );
    if (compactSchema && existingTableRecordIds.length === 0) {
      await reorderActionFields(appToken, sourceType, table.table_id, selectedFields, logger);
    }

	    const { rows, breakdown } = await queryRowsForSource(sourceType, reportDate, options);
	    const sourceSurface = sourceType === ASA_SOURCE_TYPE ? 'master_pivot' : 'daily_report';
	    const apps = await listApps();
	    const officialSnapshot = await buildAfOfficialBatchSnapshot({
	      metricScope: 'daily_push_d1',
	      sourceSurface,
	      windowFrom: reportDate,
	      windowTo: reportDate,
	      timezone: sourceSurface === 'master_pivot' ? 'preferred' : env.timezone,
	      currency: 'preferred',
	      platform: sourceType === ASA_SOURCE_TYPE ? 'ios' : undefined,
	      expectedComponents:
	        sourceType === ASA_SOURCE_TYPE
	          ? buildAsaMasterExpectedComponents(apps, {
	              from: reportDate,
	              to: reportDate,
	              platform: 'ios'
	            })
	          : buildDailyReportExpectedComponents(apps, {
	              from: reportDate,
	              to: reportDate
	            })
	    });
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
	    const persistedFeedback = await buildPersistedFeedbackMap(sourceType, rows);
	    const snapshotId = officialSnapshot.snapshot_id;
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
    const recordPayloads = rowsWithFeedback.map((row) => buildRecordFields(sourceType, row, selectedFields, Date.now()));

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
        source_type: sourceType,
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
      await deleteBitableExportRecordRefsByRecordIds(sourceType, liveFeedback.staleRecordIds);
    }

    const deleteResult = await deleteRecordsByIds(appToken, table.table_id, existingTableRecordIds, logger);
    if (deleteResult.deletedIds.length > 0) {
      await deleteBitableExportRecordRefsByRecordIds(sourceType, deleteResult.deletedIds);
    }
    const deletedCount = deleteResult.deletedIds.length;
    const recordCleanupError =
      existingTableRecordIds.length > 0 && deletedCount !== existingTableRecordIds.length
        ? `snapshot_cleanup_incomplete deleted=${deletedCount}/${existingTableRecordIds.length}`
        : null;
    const fieldCleanupError =
      fieldSync.cleanup_labels.length > 0 ? `field_cleanup_incomplete labels=${fieldSync.cleanup_labels.join(',')}` : null;
    const cleanupError = [fieldCleanupError, recordCleanupError].filter(Boolean).join('; ') || null;

    const resultBase = {
      source_type: sourceType,
      label: definition.label,
      report_date: reportDate,
      table_id: table.table_id,
      table_name: table.name,
	      table_name_prefix: tableNamePrefix,
	      table_url: baseTableUrl(table.table_id),
	      selected_fields: selectedFields,
	      official_snapshot: officialSnapshot,
	      deleted_count: deletedCount,
      record_count: recordPayloads.length,
      export_status: cleanupError ? ('partial_success' as const) : ('success' as const),
      export_error: cleanupError,
      breakdown
    };

    const notify = notifyEnabled
      ? await sendFeishuInteractiveCardNotification(
          {
            title: `${definition.label}｜${reportDate}`,
            text: `${definition.label} 已刷新 ${recordPayloads.length} 行`,
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
      source_type: sourceType,
      target_table_id: table.table_id,
      target_table_name: table.name,
      table_name_prefix: tableNamePrefix,
      last_status: cleanupError ? 'partial_success' : notify.ok ? 'success' : 'failed',
      last_error: cleanupError || (notify.ok ? null : notify.error || 'notify_failed'),
      last_synced_at: new Date().toISOString(),
      last_record_count: recordPayloads.length
    });
    await upsertBitableExportDailyTable({
      source_type: sourceType,
      report_date: reportDate,
      table_id: table.table_id,
      table_name: table.name,
      table_name_prefix: tableNamePrefix,
      last_record_count: recordPayloads.length,
      last_synced_at: new Date().toISOString()
    });

    if (recordCleanupError) {
      logger?.warn?.('bitable_snapshot_cleanup_incomplete', {
        source_type: sourceType,
        report_date: reportDate,
        table_id: table.table_id,
        deleted_count: deletedCount,
        expected_delete_count: existingTableRecordIds.length
      });
    }

    if (fieldCleanupError) {
      logger?.warn?.('bitable_field_cleanup_incomplete', {
        source_type: sourceType,
        report_date: reportDate,
        table_id: table.table_id,
        labels: fieldSync.cleanup_labels
      });
    }

    return result;
  });

  if (options.seedFeedbackSync !== false) {
    try {
      await runBitableFeedbackSync(sourceType, logger, 'system.bitable_export_seed');
    } catch (error) {
      logger?.warn?.('bitable_feedback_seed_failed', {
        source_type: sourceType,
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
  if (!isActiveBitableExportSourceType(sourceType)) {
    throw new Error('unsupported_bitable_source_type');
  }
  const historicalDates = await listHistoricalReportDatesForSource(sourceType);
  throw new Error(
    `bitable_historical_backfill_disabled_for_action_tables:${sourceType}:${historicalDates[0] || 'none'}:${historicalDates[historicalDates.length - 1] || 'none'}`
  );
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
  const configs = await Promise.all(
    activeBitableExportSourceTypes().map(async (sourceType) => ({
      sourceType,
      config: mergeConfig(sourceType, await getBitableExportConfig(sourceType))
    }))
  );
  const runnableSources = configs.filter(({ config }) => config.enabled && String(config.chat_id || '').trim());
  if (runnableSources.length === 0) {
    return {
      completed: true,
      skipped: true,
      success_count: 0,
      partial_success_count: 0,
      failed_count: 0,
      results: []
    };
  }
  const results: BitableExportRunResult[] = [];
  const errors: string[] = [];
  let successCount = 0;
  let partialSuccessCount = 0;
  let failedCount = 0;

  for (const { sourceType, config } of runnableSources) {
    try {
      const result = await runBitableExport(sourceType, reportDate, logger);
      results.push(result);
      const httpResult = resolveManualBitableExportHttpResult(result);
      if (result.export_status === 'partial_success') {
        partialSuccessCount += 1;
      } else if (httpResult.ok) {
        successCount += 1;
      } else {
        failedCount += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${sourceType}:${message}`);
      failedCount += 1;
      await updateBitableExportSyncResult({
        source_type: sourceType,
        target_table_id: config.target_table_id,
        target_table_name: config.target_table_name,
        table_name_prefix: config.table_name_prefix,
        last_status: 'failed',
        last_error: message,
        last_synced_at: new Date().toISOString(),
        last_record_count: 0
      });
      logger?.error?.('scheduled_bitable_export_failed', {
        source_type: sourceType,
        error: message
      });
    }
  }

  return {
    completed: failedCount === 0 && partialSuccessCount === 0,
    skipped: false,
    success_count: successCount,
    partial_success_count: partialSuccessCount,
    failed_count: failedCount,
    results,
    error: errors.length > 0 ? errors.join('; ') : undefined
  };
}
