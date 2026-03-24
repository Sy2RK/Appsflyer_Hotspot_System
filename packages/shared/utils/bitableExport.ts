import { env } from '../config/env.js';
import type { BitableExportConfigRecord, BitableExportSourceType } from '../types/models.js';
import { pgQuery } from './postgres.js';
import {
  deleteBitableExportRecordRefsByRecordIds,
  getBitableExportConfig,
  listBitableExportConfigs,
  listBitableExportRecordRefs,
  upsertBitableExportConfig,
  upsertBitableExportRecordRefs,
  updateBitableExportSyncResult
} from './repositories.js';
import { getFeishuTenantAccessToken, sendFeishuInteractiveCardNotification, type AlertChannelConfig } from './notifier.js';
import { getPreviousDateString } from './businessDate.js';

interface LoggerLike {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

type BitableFieldValueType = 'text' | 'number' | 'datetime';

export interface BitableFieldDefinition {
  key: string;
  label: string;
  value_type: BitableFieldValueType;
  default_selected: boolean;
  system?: boolean;
  date_only?: boolean;
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

interface BitableRecordRef {
  record_id: string;
  snapshot_id: string;
  sync_key: string;
  validation_result: string;
}

interface BitableSourceSnapshot {
  source_type: BitableExportSourceType;
  label: string;
  fields: BitableFieldDefinition[];
  config: BitableExportConfigRecord;
  table_url: string;
  target_table_hint: string;
}

interface DeliveryActionRow {
  report_date: string;
  product_name: string;
  platform: string;
  media_source: string;
  item_type: string;
  item_name: string;
  campaign: string;
  adset: string;
  stage: string;
  primary_metric: string;
  current_value: string;
  target_value: string;
  cost_reference: number;
  volume_reference: string;
  action: string;
  adjustment_ratio: number;
  validation_result: string;
  reason: string;
  updated_at: string;
}

export interface BitableExportRunResult {
  source_type: BitableExportSourceType;
  label: string;
  report_date: string;
  table_id: string;
  table_name: string;
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

const SOURCE_TYPE: BitableExportSourceType = 'delivery_actions';
const SOURCE_LABEL = '投放执行表';
const TARGET_TABLE_HINT = '固定为单张执行清单，只保留对投放同学有用的建议信息。';
const ACTION_TABLE_NAME = String(env.feishuBitableActionTableName || '投放执行表').trim() || '投放执行表';
const LEGACY_CONFIG_CONFLICT_ERROR =
  'legacy_config_conflict: 原 Pull 明细表 与 ASA Raw 表配置不一致，已停止自动迁移，请在页面重新确认 Chat ID 与启用状态。';

const SYSTEM_FIELDS: BitableFieldDefinition[] = [
  { key: '_report_date', label: '同步报告日期', value_type: 'text', default_selected: true, system: true },
  { key: '_sync_key', label: '同步键', value_type: 'text', default_selected: true, system: true },
  { key: '_snapshot_id', label: '同步快照ID', value_type: 'text', default_selected: true, system: true },
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
  { key: 'action', label: '建议动作', value_type: 'text', default_selected: true },
  { key: 'adjustment_ratio', label: '调整幅度(%)', value_type: 'number', default_selected: true },
  { key: 'validation_result', label: '验证结果', value_type: 'text', default_selected: true },
  { key: 'reason', label: '建议理由', value_type: 'text', default_selected: true },
  { key: 'updated_at', label: '最近更新时间', value_type: 'datetime', default_selected: true }
];

const DEFAULT_SELECTED_FIELDS: string[] = ACTION_FIELDS.filter((field) => field.default_selected).map((field) => field.key);

function fieldCatalog(): BitableFieldDefinition[] {
  return [...SYSTEM_FIELDS, ...ACTION_FIELDS];
}

function defaultConfig(): BitableExportConfigRecord {
  return {
    id: 0,
    source_type: SOURCE_TYPE,
    enabled: false,
    target_table_id: null,
    target_table_name: ACTION_TABLE_NAME,
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
    target_table_name: dbConfig.target_table_name || base.target_table_name
  };
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

function formatLocalDateTime(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((item) => item.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
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

function fieldTypeToFeishu(field: BitableFieldDefinition): { type: number; property?: Record<string, unknown> } {
  if (field.value_type === 'number') {
    return { type: 2 };
  }
  if (field.value_type === 'datetime') {
    return { type: 5 };
  }
  return { type: 1 };
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
  return String(value);
}

async function feishuJsonRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
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
  await feishuJsonRequest('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
    field_name: field.label,
    type: fieldSpec.type,
    property: fieldSpec.property ?? {}
  });
}

function isFeishuFieldNameDuplicatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('FieldNameDuplicated') || message.includes('code=1254014');
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

async function getBitableRecord(appToken: string, tableId: string, recordId: string): Promise<BitableRecordItem> {
  const data = await feishuJsonRequest<{ record?: { record_id?: string; fields?: Record<string, unknown> } }>(
    'GET',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`
  );
  if (!data.record?.record_id) {
    throw new Error(`Feishu bitable record missing record_id: ${recordId}`);
  }
  return {
    record_id: data.record.record_id,
    fields: data.record.fields || {}
  };
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
      throw new Error(`Feishu bitable batch create returned ${ids.length}/${chunk.length} record ids`);
    }
    createdRecordIds.push(...ids);
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
    if (!existing.target_table_name) {
      await upsertBitableExportConfig({
        source_type: SOURCE_TYPE,
        target_table_name: ACTION_TABLE_NAME,
        selected_fields: DEFAULT_SELECTED_FIELDS
      });
    }
    return;
  }

  if (legacyConflict) {
    await upsertBitableExportConfig({
      source_type: SOURCE_TYPE,
      enabled: false,
      chat_id: null,
      target_table_name: ACTION_TABLE_NAME,
      selected_fields: DEFAULT_SELECTED_FIELDS
    });
    await updateBitableExportSyncResult({
      source_type: SOURCE_TYPE,
      target_table_name: ACTION_TABLE_NAME,
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
    target_table_name: ACTION_TABLE_NAME,
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

function formatBudgetCurrentValue(row: Record<string, unknown>): string {
  if (String(row.primary_metric || '') === 'roas') {
    const currentRoas = Number(row.current_roas || 0);
    const currentEcpi = Number(row.current_ecpi || 0);
    if (String(row.metric_mode || '') === 'roas_pending_revenue') {
      return `ROAS 回流中 / 当前 eCPI $${currentEcpi.toFixed(2)}`;
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

async function queryBudgetActionRows(reportDate: string): Promise<DeliveryActionRow[]> {
  const result = await pgQuery<Record<string, unknown>>(
    `SELECT
        br.date::text AS report_date,
        COALESCE(
          NULLIF(CASE WHEN br.platform = 'ios' THEN a.ios_display_name WHEN br.platform = 'android' THEN a.android_display_name ELSE '' END, ''),
          NULLIF(a.display_name, ''),
          br.app_key
        ) AS product_name,
        br.platform,
        br.media_source,
        br.keyword AS item_name,
        '' AS campaign,
        '' AS adset,
        COALESCE(ks.current_stage, '待观察') AS stage,
        br.primary_metric,
        br.metric_mode,
        br.current_ecpi,
        br.target_ecpi,
        br.current_roas,
        br.target_roas,
        br.current_cost,
        br.volume_tier,
        COALESCE(ks.last_installs, 0) AS last_installs,
        br.action,
        br.change_ratio,
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
        AND br.status = 'pending'
      ORDER BY br.updated_at DESC,
      br.id DESC`,
    [reportDate]
  );

  return result.rows.map((row) => ({
    report_date: String(row.report_date || reportDate),
    product_name: String(row.product_name || row.app_key || ''),
    platform: platformLabel(String(row.platform || 'unknown')),
    media_source: String(row.media_source || '未知媒体'),
    item_type: '通用投放',
    item_name: String(row.item_name || ''),
    campaign: String(row.campaign || ''),
    adset: '',
    stage: String(row.stage || '待观察'),
    primary_metric: budgetMetricLabel(String(row.primary_metric || ''), String(row.metric_mode || '')),
    current_value: formatBudgetCurrentValue(row),
    target_value: formatBudgetTargetValue(row),
    cost_reference: Number(row.current_cost || 0),
    volume_reference: formatBudgetVolumeReference(row),
    action: String(row.action || 'hold'),
    adjustment_ratio: Math.abs(Number(row.change_ratio || 0) * 100),
    validation_result: '待验证',
    reason: String(row.reason_summary || row.reason_code || '暂无补充说明'),
    updated_at: String(row.updated_at || '')
  }));
}

async function queryAsaActionRows(reportDate: string): Promise<DeliveryActionRow[]> {
  const result = await pgQuery<Record<string, unknown>>(
    `SELECT
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
        AND ar.status = 'pending'
      ORDER BY ar.updated_at DESC,
      ar.id DESC`,
    [reportDate]
  );

  return result.rows.map((row) => ({
    report_date: String(row.report_date || reportDate),
    product_name: String(row.product_name || row.app_key || ''),
    platform: platformLabel(String(row.platform || 'unknown')),
    media_source: 'Apple Search Ads',
    item_type: 'ASA 关键词',
    item_name: String(row.item_name || ''),
    campaign: String(row.campaign || ''),
    adset: String(row.adset || ''),
    stage: String(row.stage || '待观察'),
    primary_metric: formatAsaMetricLabel(String(row.primary_metric || 'ecpi')),
    current_value: formatAsaCurrentValue(row),
    target_value: formatAsaTargetValue(row),
    cost_reference: Number(row.total_cost_7d || 0),
    volume_reference: formatAsaVolumeReference(row),
    action: String(row.action || 'hold'),
    adjustment_ratio: Math.abs(Number(row.change_ratio || 0) * 100),
    validation_result: '待验证',
    reason: String(row.reason_summary || row.reason_code || '暂无补充说明'),
    updated_at: String(row.updated_at || '')
  }));
}

async function queryDeliveryActionRows(reportDate: string): Promise<{ rows: DeliveryActionRow[]; breakdown: { campaign_actions: number; asa_actions: number } }> {
  const [campaignRows, asaRows] = await Promise.all([
    queryBudgetActionRows(reportDate),
    queryAsaActionRows(reportDate)
  ]);
  return {
    rows: [...campaignRows, ...asaRows],
    breakdown: {
      campaign_actions: campaignRows.length,
      asa_actions: asaRows.length
    }
  };
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

async function resolveActionTable(appToken: string, config: BitableExportConfigRecord): Promise<BitableTableRecord> {
  const tables = await listBitableTables(appToken);
  const byId = config.target_table_id ? tables.find((table) => table.table_id === config.target_table_id) : null;
  if (byId) {
    return byId;
  }
  const targetName = String(config.target_table_name || ACTION_TABLE_NAME).trim() || ACTION_TABLE_NAME;
  const byName = tables.find((table) => table.name === targetName);
  if (byName) {
    return byName;
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
  const existingNames = new Set(existingFields.map((field) => field.field_name));
  const catalog = fieldCatalog();
  const required = catalog.filter((field) => field.system || selectedFields.includes(field.key));
  for (const field of required) {
    if (existingNames.has(field.label)) {
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
    existingNames.add(field.label);
  }
}

async function loadExistingRecordRefs(reportDate: string, tableId: string): Promise<BitableRecordRef[]> {
  const refs = await listBitableExportRecordRefs(SOURCE_TYPE, reportDate, tableId);
  return refs.map((row) => ({
    record_id: row.record_id,
    snapshot_id: row.snapshot_id,
    sync_key: row.sync_key,
    validation_result: String(row.validation_result || '').trim()
  }));
}

async function buildValidationResultMap(
  appToken: string,
  tableId: string,
  refs: BitableRecordRef[],
  logger?: LoggerLike
): Promise<{ validationMap: Map<string, string>; staleRecordIds: string[] }> {
  const validationMap = new Map<string, string>();
  const staleRecordIds: string[] = [];

  for (const ref of refs) {
    try {
      const record = await getBitableRecord(appToken, tableId, ref.record_id);
      const syncKey = String(record.fields['同步键'] || ref.sync_key || '').trim();
      const validationResult = String(record.fields['验证结果'] || ref.validation_result || '').trim();
      if (syncKey && validationResult && !validationMap.has(syncKey)) {
        validationMap.set(syncKey, validationResult);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('code=1254040') || message.includes('code=91403') || message.includes('status=404')) {
        staleRecordIds.push(ref.record_id);
        continue;
      }
      logger?.warn?.('bitable_validation_result_lookup_failed', {
        record_id: ref.record_id,
        table_id: tableId,
        error: message
      });
    }
  }

  return { validationMap, staleRecordIds };
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
  reportDate: string,
  snapshotId: string,
  syncedAtMillis: number
): Record<string, unknown> {
  const catalog = fieldCatalog();
  const selected = new Set(selectedFields);
  const result: Record<string, unknown> = {
    同步报告日期: reportDate,
    同步键: syncKeyForRow(row),
    同步快照ID: snapshotId,
    同步时间: syncedAtMillis
  };
  for (const field of catalog) {
    if (field.system || !selected.has(field.key)) {
      continue;
    }
    const value = serializeFieldValue(field, row[field.key as keyof DeliveryActionRow]);
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
  const row = mergeConfig(await getBitableExportConfig(SOURCE_TYPE));
  return {
    sources: [
      {
        source_type: SOURCE_TYPE,
        label: SOURCE_LABEL,
        fields: ACTION_FIELDS,
        config: row,
        table_url: baseTableUrl(row.target_table_id || ''),
        target_table_hint: TARGET_TABLE_HINT
      }
    ]
  };
}

export async function saveBitableExportConfig(input: {
  sourceType: BitableExportSourceType;
  enabled: boolean;
  chatId: string;
}): Promise<BitableSourceSnapshot> {
  if (input.sourceType !== SOURCE_TYPE) {
    throw new Error('unsupported_bitable_source_type');
  }
  await ensureDefaultConfigs();
  const saved = await upsertBitableExportConfig({
    source_type: SOURCE_TYPE,
    enabled: input.enabled,
    chat_id: input.chatId,
    selected_fields: DEFAULT_SELECTED_FIELDS,
    target_table_name: ACTION_TABLE_NAME
  });
  let merged = mergeConfig(saved);
  if (String(merged.last_error || '') === LEGACY_CONFIG_CONFLICT_ERROR) {
    const cleared = await updateBitableExportSyncResult({
      source_type: SOURCE_TYPE,
      target_table_id: merged.target_table_id,
      target_table_name: merged.target_table_name,
      last_status: 'idle',
      last_error: null,
      last_synced_at: merged.last_synced_at,
      last_record_count: merged.last_record_count
    });
    merged = mergeConfig(cleared);
  }
  return {
    source_type: SOURCE_TYPE,
    label: SOURCE_LABEL,
    fields: ACTION_FIELDS,
    config: merged,
    table_url: baseTableUrl(merged.target_table_id || ''),
    target_table_hint: TARGET_TABLE_HINT
  };
}

export async function runBitableExport(
  sourceType: BitableExportSourceType,
  reportDate: string,
  logger?: LoggerLike
): Promise<BitableExportRunResult> {
  if (sourceType !== SOURCE_TYPE) {
    throw new Error('unsupported_bitable_source_type');
  }
  await ensureDefaultConfigs();
  const appToken = String(env.feishuBitableAppToken || '').trim();
  if (!appToken) {
    throw new Error('Missing FEISHU_BITABLE_APP_TOKEN');
  }
  const config = mergeConfig(await getBitableExportConfig(SOURCE_TYPE));
  const selectedFields = DEFAULT_SELECTED_FIELDS;
  const chatId = String(config.chat_id || '').trim();
  if (!chatId) {
    throw new Error(`${SOURCE_LABEL} 未配置 Chat ID`);
  }

  const table = await resolveActionTable(appToken, config);
  await ensureTableFields(appToken, table.table_id, selectedFields, logger);

  const { rows, breakdown } = await queryDeliveryActionRows(reportDate);
  const oldRecords = await loadExistingRecordRefs(reportDate, table.table_id);
  const { validationMap, staleRecordIds } = await buildValidationResultMap(appToken, table.table_id, oldRecords, logger);
  const snapshotId = `${reportDate}:${Date.now()}:${SOURCE_TYPE}`;
  const syncedAtMillis = parseToEpochMillis(formatLocalDateTime()) ?? Date.now();
  const rowsWithValidation = rows.map((row) => {
    const existingValidationResult = validationMap.get(syncKeyForRow(row));
    return {
      ...row,
      validation_result: existingValidationResult || row.validation_result || '待验证'
    };
  });
  const recordPayloads = rowsWithValidation.map((row) => buildRecordFields(row, selectedFields, reportDate, snapshotId, syncedAtMillis));
  const oldRecordIds = oldRecords.map((record) => record.record_id).filter((recordId) => !staleRecordIds.includes(recordId));

  let createdRecordIds: string[] = [];
  try {
    createdRecordIds = await batchCreateBitableRecords(appToken, table.table_id, recordPayloads);
  } catch (error) {
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
      sync_key: syncKeyForRow(rowsWithValidation[index]),
      record_id: recordId,
      validation_result: rowsWithValidation[index]?.validation_result || '待验证'
    }))
  );

  if (staleRecordIds.length > 0) {
    await deleteBitableExportRecordRefsByRecordIds(SOURCE_TYPE, staleRecordIds);
  }

  const deleteResult = await deleteRecordsByIds(appToken, table.table_id, oldRecordIds, logger);
  if (deleteResult.deletedIds.length > 0) {
    await deleteBitableExportRecordRefsByRecordIds(SOURCE_TYPE, deleteResult.deletedIds);
  }
  const deletedCount = deleteResult.deletedIds.length;
  const cleanupError =
    oldRecordIds.length > 0 && deletedCount !== oldRecordIds.length
      ? `snapshot_cleanup_incomplete deleted=${deletedCount}/${oldRecordIds.length}`
      : null;

  const resultBase = {
    source_type: SOURCE_TYPE,
    label: SOURCE_LABEL,
    report_date: reportDate,
    table_id: table.table_id,
    table_name: table.name,
    table_url: baseTableUrl(table.table_id),
    selected_fields: selectedFields,
    deleted_count: deletedCount,
    record_count: recordPayloads.length,
    export_status: cleanupError ? ('partial_success' as const) : ('success' as const),
    export_error: cleanupError,
    breakdown
  };

  const notifyOverride: AlertChannelConfig = {
    notify_feishu_chat_id: chatId
  };
  const notify = await sendFeishuInteractiveCardNotification(
    {
      title: `${SOURCE_LABEL}｜${reportDate}`,
      text: `${SOURCE_LABEL} 已刷新 ${recordPayloads.length} 行`,
      feishuCardPayload: buildNotifyCard({
        ...resultBase,
        notify: { ok: true }
      } as BitableExportRunResult)
    },
    notifyOverride
  );

  const result: BitableExportRunResult = {
    ...resultBase,
    notify
  };

  await updateBitableExportSyncResult({
    source_type: SOURCE_TYPE,
    target_table_id: table.table_id,
    target_table_name: table.name,
    last_status: cleanupError ? 'partial_success' : notify.ok ? 'success' : 'failed',
    last_error: cleanupError || (notify.ok ? null : notify.error || 'notify_failed'),
    last_synced_at: new Date().toISOString(),
    last_record_count: recordPayloads.length
  });

  if (cleanupError) {
    logger?.warn?.('bitable_snapshot_cleanup_incomplete', {
      source_type: SOURCE_TYPE,
      report_date: reportDate,
      table_id: table.table_id,
      deleted_count: deletedCount,
      expected_delete_count: oldRecordIds.length
    });
  }

  return result;
}

export async function runScheduledBitableExports(logger?: LoggerLike): Promise<BitableExportRunResult[]> {
  if (!env.feishuBitableEnabled) {
    logger?.info?.('bitable_exports_disabled');
    return [];
  }
  await ensureDefaultConfigs();
  const reportDate = getPreviousDateString(1);
  const config = mergeConfig(await getBitableExportConfig(SOURCE_TYPE));
  if (!config.enabled || !String(config.chat_id || '').trim()) {
    return [];
  }
  try {
    return [await runBitableExport(SOURCE_TYPE, reportDate, logger)];
  } catch (error) {
    await updateBitableExportSyncResult({
      source_type: SOURCE_TYPE,
      target_table_id: config.target_table_id,
      target_table_name: config.target_table_name,
      last_status: 'failed',
      last_error: error instanceof Error ? error.message : String(error),
      last_synced_at: new Date().toISOString(),
      last_record_count: 0
    });
    logger?.error?.('scheduled_bitable_export_failed', {
      source_type: SOURCE_TYPE,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}
