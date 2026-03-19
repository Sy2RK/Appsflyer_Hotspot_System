import { env } from '../config/env.js';
import type { BitableExportConfigRecord, BitableExportSourceType } from '../types/models.js';
import { chQuery } from './clickhouse.js';
import {
  getBitableExportConfig,
  listBitableExportConfigs,
  upsertBitableExportConfig,
  updateBitableExportSyncResult
} from './repositories.js';
import { getFeishuTenantAccessToken, sendFeishuInteractiveCardNotification, type AlertChannelConfig } from './notifier.js';

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

interface BitableSourceSnapshot {
  source_type: BitableExportSourceType;
  label: string;
  fields: BitableFieldDefinition[];
  config: BitableExportConfigRecord;
  table_url: string;
  target_table_hint: string;
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
  notify: {
    ok: boolean;
    status?: number;
    error?: string;
    render_mode?: string;
  };
}

const SYSTEM_FIELDS: BitableFieldDefinition[] = [
  { key: '_report_date', label: '同步报告日期', value_type: 'text', default_selected: true, system: true },
  { key: '_sync_key', label: '同步键', value_type: 'text', default_selected: true, system: true },
  { key: '_synced_at', label: '同步时间', value_type: 'datetime', default_selected: true, system: true }
];

const PULL_FIELDS: BitableFieldDefinition[] = [
  { key: 'date', label: '日期', value_type: 'datetime', date_only: true, default_selected: true },
  { key: 'app_key', label: '应用 Key', value_type: 'text', default_selected: true },
  { key: 'platform', label: '平台', value_type: 'text', default_selected: true },
  { key: 'media_source', label: '媒体源', value_type: 'text', default_selected: true },
  { key: 'country', label: '国家', value_type: 'text', default_selected: true },
  { key: 'campaign', label: '广告系列', value_type: 'text', default_selected: true },
  { key: 'agency_pmd', label: 'Agency PMD', value_type: 'text', default_selected: false },
  { key: 'impressions', label: '展示量', value_type: 'number', default_selected: false },
  { key: 'clicks', label: '点击量', value_type: 'number', default_selected: true },
  { key: 'ctr', label: 'CTR', value_type: 'number', default_selected: false },
  { key: 'installs', label: '安装量', value_type: 'number', default_selected: true },
  { key: 'conversion_rate', label: '转化率', value_type: 'number', default_selected: false },
  { key: 'sessions', label: 'Sessions', value_type: 'number', default_selected: false },
  { key: 'loyal_users', label: 'Loyal Users', value_type: 'number', default_selected: false },
  { key: 'loyal_users_installs_ratio', label: 'Loyal Users / Installs', value_type: 'number', default_selected: false },
  { key: 'total_cost', label: '成本', value_type: 'number', default_selected: true },
  { key: 'average_ecpi', label: '平均 eCPI', value_type: 'number', default_selected: true },
  { key: 'source_report', label: '报表来源', value_type: 'text', default_selected: true },
  { key: 'revenue', label: '收入', value_type: 'number', default_selected: false },
  { key: 'events', label: '事件数', value_type: 'number', default_selected: false },
  { key: 'ingest_time', label: '入库时间', value_type: 'datetime', default_selected: true },
  { key: 'raw_json', label: '原始 JSON', value_type: 'text', default_selected: false }
];

const ASA_FIELDS: BitableFieldDefinition[] = [
  { key: 'dataset_type', label: '数据类型', value_type: 'text', default_selected: true },
  { key: 'install_date', label: '安装日期', value_type: 'datetime', date_only: true, default_selected: true },
  { key: 'install_time', label: '安装时间', value_type: 'datetime', default_selected: true },
  { key: 'event_time', label: '事件时间', value_type: 'datetime', default_selected: false },
  { key: 'app_key', label: '应用 Key', value_type: 'text', default_selected: true },
  { key: 'platform', label: '平台', value_type: 'text', default_selected: true },
  { key: 'keyword', label: '关键词', value_type: 'text', default_selected: true },
  { key: 'campaign', label: '广告系列', value_type: 'text', default_selected: true },
  { key: 'adset', label: '广告组', value_type: 'text', default_selected: true },
  { key: 'country', label: '国家', value_type: 'text', default_selected: false },
  { key: 'event_name', label: '事件名', value_type: 'text', default_selected: false },
  { key: 'event_revenue_usd', label: '收入 USD', value_type: 'number', default_selected: true },
  { key: 'currency', label: '币种', value_type: 'text', default_selected: false },
  { key: 'event_uid', label: '事件 UID', value_type: 'text', default_selected: false },
  { key: 'raw_json', label: '原始 JSON', value_type: 'text', default_selected: false }
];

const SOURCE_LABELS: Record<BitableExportSourceType, string> = {
  pull_daily: 'Pull 明细表',
  asa_raw: 'ASA Raw 表'
};

const DEFAULT_SELECTED_FIELDS: Record<BitableExportSourceType, string[]> = {
  pull_daily: PULL_FIELDS.filter((field) => field.default_selected).map((field) => field.key),
  asa_raw: ASA_FIELDS.filter((field) => field.default_selected).map((field) => field.key)
};

const SOURCE_FIELDS: Record<BitableExportSourceType, BitableFieldDefinition[]> = {
  pull_daily: PULL_FIELDS,
  asa_raw: ASA_FIELDS
};

function fieldCatalog(sourceType: BitableExportSourceType): BitableFieldDefinition[] {
  return [...SYSTEM_FIELDS, ...SOURCE_FIELDS[sourceType]];
}

function defaultConfig(sourceType: BitableExportSourceType): BitableExportConfigRecord {
  return {
    id: 0,
    source_type: sourceType,
    enabled: false,
    target_table_id: sourceType === 'pull_daily' ? env.feishuBitablePullTableId || null : null,
    target_table_name: sourceType === 'pull_daily' ? 'Pull 明细表' : env.feishuBitableAsaTableName || 'ASA Raw 明细',
    chat_id: null,
    selected_fields: DEFAULT_SELECTED_FIELDS[sourceType],
    last_status: 'idle',
    last_error: null,
    last_synced_at: null,
    last_record_count: 0,
    created_at: '',
    updated_at: ''
  };
}

function mergeConfig(
  sourceType: BitableExportSourceType,
  dbConfig?: BitableExportConfigRecord | null
): BitableExportConfigRecord {
  const base = defaultConfig(sourceType);
  if (!dbConfig) {
    return base;
  }
  return {
    ...base,
    ...dbConfig,
    selected_fields: Array.isArray(dbConfig.selected_fields) && dbConfig.selected_fields.length > 0
      ? dbConfig.selected_fields
      : base.selected_fields,
    target_table_id: dbConfig.target_table_id || base.target_table_id,
    target_table_name: dbConfig.target_table_name || base.target_table_name
  };
}

function baseTableUrl(tableId: string, viewId?: string | null): string {
  const baseUrl = String(env.feishuBitableBaseUrl || '').trim().replace(/\/+$/, '');
  const appToken = String(env.feishuBitableAppToken || '').trim();
  if (!baseUrl || !appToken || !tableId) {
    return '';
  }
  const params = new URLSearchParams({ table: tableId });
  if (viewId) {
    params.set('view', viewId);
  }
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
    throw new Error('Feishu ASA table create succeeded without table_id');
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
    {
      field_name: field.label,
      type: fieldSpec.type,
      property: fieldSpec.property ?? {}
    }
  );
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

async function deleteBitableRecord(appToken: string, tableId: string, recordId: string): Promise<void> {
  await feishuJsonRequest('DELETE', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`);
}

async function batchCreateBitableRecords(
  appToken: string,
  tableId: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200).map((fields) => ({ fields }));
    await feishuJsonRequest('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
      records: chunk
    });
  }
}

async function ensureDefaultConfigs(): Promise<void> {
  await upsertBitableExportConfig({
    source_type: 'pull_daily',
    target_table_id: env.feishuBitablePullTableId || null,
    target_table_name: 'Pull 明细表',
    selected_fields: DEFAULT_SELECTED_FIELDS.pull_daily
  });
  await upsertBitableExportConfig({
    source_type: 'asa_raw',
    target_table_name: env.feishuBitableAsaTableName || 'ASA Raw 明细',
    selected_fields: DEFAULT_SELECTED_FIELDS.asa_raw
  });
}

function normalizeSelectedFields(sourceType: BitableExportSourceType, selectedFields: string[]): string[] {
  const allowed = new Set(SOURCE_FIELDS[sourceType].map((field) => field.key));
  const normalized = selectedFields.filter((field) => allowed.has(field));
  return normalized.length > 0 ? normalized : DEFAULT_SELECTED_FIELDS[sourceType];
}

function pullFieldRow(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    date: String(raw.date || ''),
    app_key: String(raw.app_key || ''),
    platform: String(raw.platform || ''),
    media_source: String(raw.media_source || ''),
    country: String(raw.country || ''),
    campaign: String(raw.campaign || ''),
    agency_pmd: String(raw.agency_pmd || ''),
    impressions: Number(raw.impressions || 0),
    clicks: Number(raw.clicks || 0),
    ctr: Number(raw.ctr || 0),
    installs: Number(raw.installs || 0),
    conversion_rate: Number(raw.conversion_rate || 0),
    sessions: Number(raw.sessions || 0),
    loyal_users: Number(raw.loyal_users || 0),
    loyal_users_installs_ratio: Number(raw.loyal_users_installs_ratio || 0),
    total_cost: Number(raw.total_cost || 0),
    average_ecpi: Number(raw.average_ecpi || 0),
    source_report: String(raw.source_report || ''),
    revenue: Number(raw.revenue || 0),
    events: Number(raw.events || 0),
    ingest_time: String(raw.ingest_time || ''),
    raw_json: String(raw.raw_json || '')
  };
}

async function queryPullRows(reportDate: string): Promise<Record<string, unknown>[]> {
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        toString(date) AS report_date,
        app_key,
        platform,
        media_source,
        country,
        campaign,
        agency_pmd,
        impressions,
        clicks,
        ctr,
        installs,
        conversion_rate,
        sessions,
        loyal_users,
        loyal_users_installs_ratio,
        total_cost,
        average_ecpi,
        source_report,
        revenue,
        events,
        formatDateTime(ingest_time, '%F %T') AS ingest_time_text,
        raw_json
       FROM pull_aggregate_daily
      WHERE date = toDate({reportDate:String})
      ORDER BY app_key, platform, media_source, country, campaign, ingest_time`,
    { reportDate }
  );
  return rows.map((row) =>
    pullFieldRow({
      ...row,
      date: row.report_date,
      ingest_time: row.ingest_time_text
    })
  );
}

async function queryAsaRows(reportDate: string): Promise<Record<string, unknown>[]> {
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        dataset_type,
        install_date_text,
        install_time_text,
        event_time_text,
        app_key,
        platform,
        keyword,
        campaign,
        adset,
        country,
        event_name,
        event_revenue_usd,
        currency,
        event_uid,
        raw_json
      FROM (
        SELECT
          'install' AS dataset_type,
          toString(install_date) AS install_date_text,
          formatDateTime(install_time, '%F %T') AS install_time_text,
          '' AS event_time_text,
          app_key,
          platform,
          keyword,
          campaign,
          adset,
          country,
          '' AS event_name,
          0.0 AS event_revenue_usd,
          currency,
          event_uid,
          raw_json
        FROM asa_raw_installs
        WHERE install_date = toDate({reportDate:String})
        UNION ALL
        SELECT
          'in_app_event' AS dataset_type,
          toString(install_date) AS install_date_text,
          formatDateTime(install_time, '%F %T') AS install_time_text,
          formatDateTime(event_time, '%F %T') AS event_time_text,
          app_key,
          platform,
          keyword,
          campaign,
          adset,
          country,
          event_name,
          event_revenue_usd,
          currency,
          event_uid,
          raw_json
        FROM asa_raw_in_app_events
        WHERE install_date = toDate({reportDate:String})
      )
      ORDER BY app_key, platform, keyword, campaign, adset, dataset_type, install_time_text, event_time_text`,
    { reportDate }
  );
  return rows.map((row) => ({
    dataset_type: String(row.dataset_type || ''),
    install_date: String(row.install_date_text || ''),
    install_time: String(row.install_time_text || ''),
    event_time: String(row.event_time_text || ''),
    app_key: String(row.app_key || ''),
    platform: String(row.platform || ''),
    keyword: String(row.keyword || ''),
    campaign: String(row.campaign || ''),
    adset: String(row.adset || ''),
    country: String(row.country || ''),
    event_name: String(row.event_name || ''),
    event_revenue_usd: Number(row.event_revenue_usd || 0),
    currency: String(row.currency || ''),
    event_uid: String(row.event_uid || ''),
    raw_json: String(row.raw_json || '')
  }));
}

function syncKeyForRow(sourceType: BitableExportSourceType, row: Record<string, unknown>): string {
  if (sourceType === 'pull_daily') {
    return [
      row.date,
      row.app_key,
      row.platform,
      row.media_source,
      row.country,
      row.campaign,
      row.source_report,
      row.ingest_time
    ]
      .map((item) => String(item || '').trim())
      .join('|');
  }
  return [
    row.dataset_type,
    row.install_date,
    row.app_key,
    row.platform,
    row.keyword,
    row.campaign,
    row.adset,
    row.event_uid
  ]
    .map((item) => String(item || '').trim())
    .join('|');
}

async function resolvePullTable(appToken: string): Promise<BitableTableRecord> {
  const tableId = String(env.feishuBitablePullTableId || '').trim();
  if (!tableId) {
    throw new Error('Missing FEISHU_BITABLE_PULL_TABLE_ID');
  }
  const tables = await listBitableTables(appToken);
  const matched = tables.find((table) => table.table_id === tableId);
  if (!matched) {
    return { table_id: tableId, name: 'Pull 明细表' };
  }
  return matched;
}

async function resolveAsaTable(appToken: string, config: BitableExportConfigRecord): Promise<BitableTableRecord> {
  const tables = await listBitableTables(appToken);
  const byId = config.target_table_id ? tables.find((table) => table.table_id === config.target_table_id) : null;
  if (byId) {
    return byId;
  }
  const targetName = String(config.target_table_name || env.feishuBitableAsaTableName || 'ASA Raw 明细').trim();
  const byName = tables.find((table) => table.name === targetName);
  if (byName) {
    return byName;
  }
  return createBitableTable(appToken, targetName);
}

async function ensureTableFields(
  appToken: string,
  tableId: string,
  sourceType: BitableExportSourceType,
  selectedFields: string[],
  logger?: LoggerLike
): Promise<void> {
  const existingFields = await listBitableFields(appToken, tableId);
  const existingNames = new Set(existingFields.map((field) => field.field_name));
  const catalog = fieldCatalog(sourceType);
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

async function listRecordIdsForReportDate(appToken: string, tableId: string, reportDate: string): Promise<string[]> {
  const records = await listBitableRecords(appToken, tableId);
  return records
    .filter((record) => String(record.fields['同步报告日期'] || '').trim() === reportDate)
    .map((record) => record.record_id);
}

async function deleteRecordsByIds(appToken: string, tableId: string, recordIds: string[], logger?: LoggerLike): Promise<number> {
  let deleted = 0;
  for (const recordId of recordIds) {
    try {
      await deleteBitableRecord(appToken, tableId, recordId);
      deleted += 1;
    } catch (error) {
      logger?.warn?.('bitable_delete_record_failed', {
        table_id: tableId,
        record_id: recordId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return deleted;
}

function buildRecordFields(
  sourceType: BitableExportSourceType,
  row: Record<string, unknown>,
  selectedFields: string[],
  reportDate: string
): Record<string, unknown> {
  const catalog = fieldCatalog(sourceType);
  const selected = new Set(selectedFields);
  const result: Record<string, unknown> = {
    同步报告日期: reportDate,
    同步键: syncKeyForRow(sourceType, row),
    同步时间: parseToEpochMillis(formatLocalDateTime())
  };
  for (const field of catalog) {
    if (field.system || !selected.has(field.key)) {
      continue;
    }
    const value = serializeFieldValue(field, row[field.key]);
    if (value !== undefined) {
      result[field.label] = value;
    }
  }
  return compactFields(result);
}

function buildNotifyCard(result: BitableExportRunResult): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: result.notify.ok ? 'blue' : 'red',
      title: {
        tag: 'plain_text',
        content: `原始数据表格推送｜${result.label}｜${result.report_date}`
      }
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**结果**：${result.notify.ok ? '导入并通知成功' : '导入完成，但群通知失败'}\n**目标表**：${result.table_name}\n**导入记录**：${result.record_count}\n**清理旧记录**：${result.deleted_count}\n**字段数**：${result.selected_fields.length}`
        }
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开多维表格' },
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
  const rows = await listBitableExportConfigs();
  const bySource = new Map(rows.map((row) => [row.source_type, row]));
  const sources: BitableSourceSnapshot[] = (['pull_daily', 'asa_raw'] as BitableExportSourceType[]).map((sourceType) => {
    const config = mergeConfig(sourceType, bySource.get(sourceType));
    const tableUrl = sourceType === 'pull_daily'
      ? baseTableUrl(config.target_table_id || '', env.feishuBitablePullViewId || null)
      : baseTableUrl(config.target_table_id || '');
    return {
      source_type: sourceType,
      label: SOURCE_LABELS[sourceType],
      fields: SOURCE_FIELDS[sourceType],
      config,
      table_url: tableUrl,
      target_table_hint:
        sourceType === 'pull_daily'
          ? '复用现有 Pull 表'
          : '同一 Base 下自动创建 / 复用 ASA Raw 表'
    };
  });
  return { sources };
}

export async function saveBitableExportConfig(input: {
  sourceType: BitableExportSourceType;
  enabled: boolean;
  chatId: string;
  selectedFields: string[];
}): Promise<BitableSourceSnapshot> {
  await ensureDefaultConfigs();
  const normalizedFields = normalizeSelectedFields(input.sourceType, input.selectedFields);
  const saved = await upsertBitableExportConfig({
    source_type: input.sourceType,
    enabled: input.enabled,
    chat_id: input.chatId,
    selected_fields: normalizedFields,
    target_table_id: input.sourceType === 'pull_daily' ? env.feishuBitablePullTableId || null : undefined,
    target_table_name: input.sourceType === 'pull_daily' ? 'Pull 明细表' : env.feishuBitableAsaTableName || 'ASA Raw 明细'
  });
  const merged = mergeConfig(input.sourceType, saved);
  return {
    source_type: input.sourceType,
    label: SOURCE_LABELS[input.sourceType],
    fields: SOURCE_FIELDS[input.sourceType],
    config: merged,
    table_url:
      input.sourceType === 'pull_daily'
        ? baseTableUrl(merged.target_table_id || '', env.feishuBitablePullViewId || null)
        : baseTableUrl(merged.target_table_id || ''),
    target_table_hint:
      input.sourceType === 'pull_daily' ? '复用现有 Pull 表' : '同一 Base 下自动创建 / 复用 ASA Raw 表'
  };
}

export async function runBitableExport(
  sourceType: BitableExportSourceType,
  reportDate: string,
  logger?: LoggerLike
): Promise<BitableExportRunResult> {
  await ensureDefaultConfigs();
  const appToken = String(env.feishuBitableAppToken || '').trim();
  if (!appToken) {
    throw new Error('Missing FEISHU_BITABLE_APP_TOKEN');
  }
  const config = mergeConfig(sourceType, await getBitableExportConfig(sourceType));
  const selectedFields = normalizeSelectedFields(sourceType, config.selected_fields);
  const chatId = String(config.chat_id || '').trim();
  if (!chatId) {
    throw new Error(`${SOURCE_LABELS[sourceType]} 未配置 Chat ID`);
  }

  const table = sourceType === 'pull_daily'
    ? await resolvePullTable(appToken)
    : await resolveAsaTable(appToken, config);
  await ensureTableFields(appToken, table.table_id, sourceType, selectedFields, logger);

  const rows = sourceType === 'pull_daily' ? await queryPullRows(reportDate) : await queryAsaRows(reportDate);
  const oldRecordIds = await listRecordIdsForReportDate(appToken, table.table_id, reportDate);
  const deletedCount = await deleteRecordsByIds(appToken, table.table_id, oldRecordIds, logger);
  const recordPayloads = rows.map((row) => buildRecordFields(sourceType, row, selectedFields, reportDate));
  await batchCreateBitableRecords(appToken, table.table_id, recordPayloads);

  const resultBase = {
    source_type: sourceType,
    label: SOURCE_LABELS[sourceType],
    report_date: reportDate,
    table_id: table.table_id,
    table_name: table.name,
    table_url:
      sourceType === 'pull_daily'
        ? baseTableUrl(table.table_id, env.feishuBitablePullViewId || null)
        : baseTableUrl(table.table_id),
    selected_fields: selectedFields,
    deleted_count: deletedCount,
    record_count: recordPayloads.length
  };

  const notifyOverride: AlertChannelConfig = {
    notify_feishu_chat_id: chatId
  };
  const notify = await sendFeishuInteractiveCardNotification(
    {
      title: `${SOURCE_LABELS[sourceType]}｜${reportDate}`,
      text: `${SOURCE_LABELS[sourceType]} 导入 ${recordPayloads.length} 行`,
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
    source_type: sourceType,
    target_table_id: table.table_id,
    target_table_name: table.name,
    last_status: notify.ok ? 'success' : 'failed',
    last_error: notify.ok ? null : notify.error || 'notify_failed',
    last_synced_at: new Date().toISOString(),
    last_record_count: recordPayloads.length
  });

  return result;
}

export async function runScheduledBitableExports(logger?: LoggerLike): Promise<BitableExportRunResult[]> {
  if (!env.feishuBitableEnabled) {
    logger?.info?.('bitable_exports_disabled');
    return [];
  }
  await ensureDefaultConfigs();
  const reportDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const configs = await listBitableExportConfigs();
  const enabled = configs
    .map((row) => mergeConfig(row.source_type, row))
    .filter((row) => row.enabled && String(row.chat_id || '').trim());
  const results: BitableExportRunResult[] = [];
  for (const config of enabled) {
    try {
      const result = await runBitableExport(config.source_type, reportDate, logger);
      results.push(result);
    } catch (error) {
      await updateBitableExportSyncResult({
        source_type: config.source_type,
        target_table_id: config.target_table_id,
        target_table_name: config.target_table_name,
        last_status: 'failed',
        last_error: error instanceof Error ? error.message : String(error),
        last_synced_at: new Date().toISOString(),
        last_record_count: 0
      });
      logger?.error?.('scheduled_bitable_export_failed', {
        source_type: config.source_type,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}
