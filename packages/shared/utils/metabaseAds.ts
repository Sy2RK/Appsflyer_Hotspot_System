import crypto from 'crypto';
import { readFile } from 'fs/promises';
import { env } from '../config/env.js';
import { classifyAfSyncScope, isAfWindowProvisional } from './afMetricScopes.js';
import { buildAfContentSignature, upsertAfOfficialSnapshot } from './appsflyerOfficialSnapshots.js';

export const METABASE_DAILY_SOURCE_REPORT = 'metabase_ua_dashboard';

export type MetabaseAccessSourceApi = 'metabase_saved_card' | 'bigquery_warehouse';

export interface MetabaseProductConfig {
  appKey: string;
  schema: string;
  platforms?: string[];
  dashboardId?: number;
  campaignDashcardId?: number;
  campaignCardId?: number;
  adDashcardId?: number;
  adCardId?: number;
  asaKeywordDashcardId?: number;
  asaKeywordCardId?: number;
  asaKeywordTable?: string;
}

export interface MetabaseAdsMetricRow {
  date: string;
  app_key: string;
  platform: string;
  media_source: string;
  country: string;
  campaign: string;
  adset: string;
  ad: string;
  installs: number;
  paid_users: number;
  cost: number;
  impressions: number;
  clicks: number;
  ecpi: number;
  d0_roas: number | null;
  d7_roas: number | null;
  d14_roas: number | null;
  d30_roas: number | null;
  source_api: MetabaseAccessSourceApi;
  raw_json: Record<string, unknown>;
}

export interface MetabaseAsaKeywordMetricRow {
  date: string;
  app_key: string;
  platform: string;
  media_source: string;
  campaign: string;
  adset: string;
  keyword: string;
  country: string;
  installs: number;
  paid_users: number;
  cost: number;
  ecpi: number;
  d7_roas: number | null;
  revenue_d7: number | null;
  source_api: MetabaseAccessSourceApi;
  raw_json: Record<string, unknown>;
}

interface MetabaseColumn {
  name?: string;
  display_name?: string;
  field_ref?: unknown;
}

interface MetabaseQueryPayload {
  data?: {
    cols?: MetabaseColumn[];
    rows?: unknown[][];
    results_metadata?: {
      columns?: MetabaseColumn[];
    };
  };
}

interface DashboardParameter {
  id?: string;
  name?: string;
  slug?: string;
  type?: string;
}

interface DashboardParameterMapping {
  parameter_id?: string;
  card_id?: number;
  target?: unknown;
}

interface DashboardDashcard {
  id?: number;
  card_id?: number;
  parameter_mappings?: DashboardParameterMapping[];
}

interface DashboardPayload {
  parameters?: DashboardParameter[];
  dashcards?: DashboardDashcard[];
  ordered_cards?: DashboardDashcard[];
}

interface BigQueryServiceAccount {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
  project_id?: string;
}

interface BigQueryQueryResponse {
  schema?: {
    fields?: Array<{ name?: string }>;
  };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  error?: {
    message?: string;
  };
}

interface FetchRowsInput {
  appKey: string;
  platform: string;
  date: string;
}

const DEFAULT_PRODUCT_CONFIGS: Record<string, MetabaseProductConfig> = {
  'ai-screen-time-coach': {
    appKey: 'ai-screen-time-coach',
    schema: 'ai_screen_time_coach',
    dashboardId: 5480,
    campaignDashcardId: 291494,
    campaignCardId: 252856,
    adDashcardId: 291520,
    adCardId: 252881
  },
  'ai-seek': {
    appKey: 'ai-seek',
    schema: 'ai_seek',
    dashboardId: 5482,
    campaignDashcardId: 291643,
    campaignCardId: 252988,
    adDashcardId: 291669,
    adCardId: 253013
  },
  'ai-video-plus': {
    appKey: 'ai-video-plus',
    schema: 'ai_video_plus',
    dashboardId: 5486,
    campaignDashcardId: 291941,
    campaignCardId: 253252,
    adDashcardId: 291967,
    adCardId: 253277
  },
  'photo-enhancer': {
    appKey: 'photo-enhancer',
    schema: 'photo_enhancer',
    dashboardId: 5582,
    campaignDashcardId: 299093,
    campaignCardId: 259588,
    adDashcardId: 299119,
    adCardId: 259613
  },
  'ai-video': {
    appKey: 'ai-video',
    schema: 'ai_video',
    dashboardId: 5484,
    campaignDashcardId: 291792,
    campaignCardId: 253120,
    adDashcardId: 291818,
    adCardId: 253145
  }
};

const DEFAULT_MEDIA_SOURCE_MAP: Record<string, string> = {
  google: 'googleadwords_int',
  googleadwords_int: 'googleadwords_int',
  'apple search': 'Apple Search Ads',
  'apple search ads': 'Apple Search Ads',
  facebook: 'Facebook Ads',
  'facebook ads': 'Facebook Ads',
  'facebook owner': 'Facebook Ads'
};

const DEFAULT_METABASE_PLATFORMS = ['ios', 'android'];

let productConfigCache: Record<string, MetabaseProductConfig> | null = null;
let mediaSourceMapCache: Record<string, string> | null = null;
let metabaseSessionPromise: Promise<Record<string, string>> | null = null;
let dashboardCache = new Map<number, Promise<DashboardPayload>>();
let bigQueryTokenPromise: Promise<{ token: string; expiresAtMs: number }> | null = null;

function safeJsonObject(value: string, envName: string): Record<string, unknown> {
  const text = String(value || '').trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    throw new Error(`${envName}_parse_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

function numberFromConfig(value: unknown): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringFromConfig(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text ? text : undefined;
}

function stringArrayFromConfig(value: unknown): string[] | undefined {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const items = Array.from(
    new Set(rawItems.map((item) => normalizePlatform(String(item || ''))).filter((item) => item.length > 0))
  );
  return items.length > 0 ? items : undefined;
}

function normalizeProductConfig(appKey: string, value: unknown): Partial<MetabaseProductConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const row = value as Record<string, unknown>;
  const normalized: Partial<MetabaseProductConfig> = {
    appKey,
    schema: stringFromConfig(row.schema ?? row.dataset),
    platforms: stringArrayFromConfig(row.platforms ?? row.platform),
    dashboardId: numberFromConfig(row.dashboardId ?? row.dashboard_id),
    campaignDashcardId: numberFromConfig(row.campaignDashcardId ?? row.campaign_dashcard_id),
    campaignCardId: numberFromConfig(row.campaignCardId ?? row.campaign_card_id),
    adDashcardId: numberFromConfig(row.adDashcardId ?? row.ad_dashcard_id),
    adCardId: numberFromConfig(row.adCardId ?? row.ad_card_id),
    asaKeywordDashcardId: numberFromConfig(row.asaKeywordDashcardId ?? row.asa_keyword_dashcard_id),
    asaKeywordCardId: numberFromConfig(row.asaKeywordCardId ?? row.asa_keyword_card_id),
    asaKeywordTable: stringFromConfig(row.asaKeywordTable ?? row.asa_keyword_table)
  };
  return Object.fromEntries(
    Object.entries(normalized).filter(([, entryValue]) => entryValue !== undefined)
  ) as Partial<MetabaseProductConfig>;
}

export function getMetabaseProductConfigs(): Record<string, MetabaseProductConfig> {
  if (productConfigCache) {
    return productConfigCache;
  }
  const overrides = safeJsonObject(env.metabase.productConfigJson, 'METABASE_PRODUCT_CONFIG_JSON');
  const merged: Record<string, MetabaseProductConfig> = {};
  for (const [appKey, config] of Object.entries(DEFAULT_PRODUCT_CONFIGS)) {
    merged[appKey] = { ...config, ...normalizeProductConfig(appKey, overrides[appKey]) };
  }
  for (const [appKey, value] of Object.entries(overrides)) {
    if (!merged[appKey]) {
      const normalized = normalizeProductConfig(appKey, value);
      if (normalized.schema) {
        merged[appKey] = {
          appKey,
          schema: normalized.schema,
          ...normalized
        };
      }
    }
  }
  productConfigCache = merged;
  return merged;
}

export function getMetabaseProductConfig(appKey: string): MetabaseProductConfig | null {
  return getMetabaseProductConfigs()[appKey] ?? null;
}

export function getMetabaseProductPlatforms(appKey: string): string[] {
  const config = getMetabaseProductConfig(appKey);
  if (!config) {
    return [];
  }
  const platforms = config.platforms?.map((item) => normalizePlatform(item)).filter((item) => item.length > 0) ?? [];
  return platforms.length > 0 ? Array.from(new Set(platforms)) : [...DEFAULT_METABASE_PLATFORMS];
}

function normalizeKey(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[_:\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMediaSourceMap(): Record<string, string> {
  if (mediaSourceMapCache) {
    return mediaSourceMapCache;
  }
  const overrides = safeJsonObject(env.metabase.mediaSourceMapJson, 'METABASE_MEDIA_SOURCE_MAP_JSON');
  const merged = { ...DEFAULT_MEDIA_SOURCE_MAP };
  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = normalizeKey(key);
    const normalizedValue = String(value ?? '').trim();
    if (normalizedKey && normalizedValue) {
      merged[normalizedKey] = normalizedValue;
    }
  }
  mediaSourceMapCache = merged;
  return merged;
}

export function normalizeMetabaseMediaSource(value: string): string {
  const text = String(value || '').trim();
  if (!text) {
    return 'unknown';
  }
  return getMediaSourceMap()[normalizeKey(text)] ?? text;
}

function normalizePlatform(value: string): string {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'android' || text === '安卓') {
    return 'android';
  }
  if (text === 'ios' || text === 'iphone' || text === 'apple') {
    return 'ios';
  }
  return text || 'unknown';
}

function toMetabasePlatformFilter(platform: string): string {
  const normalized = normalizePlatform(platform);
  return normalized === 'unknown' ? '' : normalized.toUpperCase();
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && !Number.isNaN(value);
}

function parseMetricNumber(value: unknown): number {
  if (typeof value === 'number') {
    return isFiniteNumber(value) ? value : 0;
  }
  const text = String(value ?? '').trim();
  if (!text || text.toLowerCase() === 'n/a' || text === '-') {
    return 0;
  }
  const parsed = Number(text.replace(/[,$%\s]/g, ''));
  return isFiniteNumber(parsed) ? parsed : 0;
}

function parseMetricRate(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return isFiniteNumber(value) ? value : null;
  }
  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'n/a' || text === '-') {
    return null;
  }
  const parsed = parseMetricNumber(text);
  if (!isFiniteNumber(parsed)) {
    return null;
  }
  return text.includes('%') ? parsed / 100 : parsed;
}

function valueToString(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.value != null) {
      return valueToString(record.value);
    }
    if (record.name != null) {
      return valueToString(record.name);
    }
  }
  return String(value).trim();
}

function parseDateCell(value: unknown, fallback: string): string {
  const text = valueToString(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : fallback;
}

function isTotalLike(value: string): boolean {
  const normalized = normalizeKey(value);
  return ['total', 'totals', 'subtotal', 'grand total', '汇总', '总计'].includes(normalized);
}

function firstExistingColumn(cols: MetabaseColumn[], aliases: string[], containsAliases: string[] = []): number {
  const normalizedAliases = aliases.map((item) => normalizeKey(item));
  const normalizedContains = containsAliases.map((item) => normalizeKey(item));
  return cols.findIndex((col) => {
    const names = [col.display_name, col.name]
      .map((item) => normalizeKey(String(item ?? '')))
      .filter((item) => item.length > 0);
    return names.some(
      (name) =>
        normalizedAliases.includes(name) ||
        normalizedContains.some((needle) => needle.length > 0 && name.includes(needle))
    );
  });
}

function rowToRawJson(cols: MetabaseColumn[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  cols.forEach((col, index) => {
    const key = String(col.display_name || col.name || `col_${index}`);
    out[key] = row[index] as unknown;
  });
  return out;
}

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function fetchJson<T>(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  label?: string;
} = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? env.pullerRequestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${options.label ?? 'http'}_failed status=${response.status} body=${text.slice(0, 500)}`);
    }
    if (!text) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

function hasSavedCardAuthConfig(): boolean {
  return Boolean(
    env.metabase.baseUrl &&
      (String(env.metabase.apiKey || '').trim() ||
        (String(env.metabase.username || '').trim() && String(env.metabase.password || '').trim()))
  );
}

function hasBigQueryConfig(): boolean {
  return Boolean(String(env.metabase.bigqueryProject || '').trim() && String(env.metabase.bigqueryCredentialsPath || '').trim());
}

async function getMetabaseHeaders(): Promise<Record<string, string>> {
  if (env.metabase.apiKey.trim()) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': env.metabase.apiKey.trim()
    };
  }
  if (!metabaseSessionPromise) {
    metabaseSessionPromise = fetchJson<{ id?: string }>(appendPath(env.metabase.baseUrl, '/api/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: env.metabase.username,
        password: env.metabase.password
      }),
      timeoutMs: env.pullerRequestTimeoutMs,
      label: 'metabase_session'
    }).then((payload) => {
      const sessionId = String(payload.id || '').trim();
      if (!sessionId) {
        throw new Error('metabase_session_missing_id');
      }
      return {
        'Content-Type': 'application/json',
        'X-Metabase-Session': sessionId
      };
    });
  }
  return metabaseSessionPromise;
}

async function getDashboard(dashboardId: number): Promise<DashboardPayload> {
  const cached = dashboardCache.get(dashboardId);
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    const headers = await getMetabaseHeaders();
    return fetchJson<DashboardPayload>(appendPath(env.metabase.baseUrl, `/api/dashboard/${dashboardId}`), {
      headers,
      timeoutMs: env.pullerRequestTimeoutMs,
      label: 'metabase_dashboard'
    });
  })();
  dashboardCache.set(dashboardId, promise);
  return promise;
}

function buildParameterValue(parameter: DashboardParameter, platform: string, date: string): unknown {
  const descriptor = normalizeKey([parameter.name, parameter.slug, parameter.type].filter(Boolean).join(' '));
  if (descriptor.includes('temporal unit') || descriptor.includes('time grouping') || descriptor.includes('granularity')) {
    return 'day';
  }
  if (descriptor.includes('date') || descriptor.includes('create dt') || descriptor.includes('day')) {
    if (descriptor.includes('range') || descriptor.includes('all options')) {
      return `${date}~${date}`;
    }
    return date;
  }
  if (descriptor.includes('platform')) {
    return toMetabasePlatformFilter(platform);
  }
  if (descriptor.includes('media') || descriptor.includes('campaign') || descriptor.includes('adset') || descriptor.includes('geo')) {
    return null;
  }
  return null;
}

function buildDashboardParameters(
  dashboard: DashboardPayload,
  dashcardId: number,
  cardId: number,
  platform: string,
  date: string
): Array<Record<string, unknown>> {
  const dashcards = dashboard.dashcards ?? dashboard.ordered_cards ?? [];
  const dashcard = dashcards.find((item) => Number(item.id) === dashcardId) ?? null;
  const paramsById = new Map((dashboard.parameters ?? []).map((item) => [String(item.id || ''), item]));
  return (dashcard?.parameter_mappings ?? [])
    .filter((mapping) => !mapping.card_id || Number(mapping.card_id) === cardId)
    .map((mapping) => {
      const parameter = paramsById.get(String(mapping.parameter_id || '')) ?? {
        id: String(mapping.parameter_id || '')
      };
      return {
        id: parameter.id,
        type: parameter.type,
        value: buildParameterValue(parameter, platform, date),
        target: mapping.target
      };
    })
    .filter((item) => item.id && item.target);
}

async function querySavedCardEndpoint(
  config: MetabaseProductConfig,
  input: FetchRowsInput,
  cardKind: 'campaign' | 'ad' | 'asa_keyword',
  usePivotEndpoint: boolean
): Promise<{
  cols: MetabaseColumn[];
  rows: unknown[][];
}> {
  const dashcardId =
    cardKind === 'campaign'
      ? config.campaignDashcardId
      : cardKind === 'ad'
        ? config.adDashcardId
        : config.asaKeywordDashcardId;
  const cardId =
    cardKind === 'campaign'
      ? config.campaignCardId
      : cardKind === 'ad'
        ? config.adCardId
        : config.asaKeywordCardId;
  if (!config.dashboardId || !dashcardId || !cardId) {
    throw new Error(`metabase_${cardKind}_card_not_configured:${input.appKey}`);
  }
  const dashboard = await getDashboard(config.dashboardId);
  const headers = await getMetabaseHeaders();
  const endpointPrefix = usePivotEndpoint ? '/api/dashboard/pivot' : '/api/dashboard';
  const payload = await fetchJson<MetabaseQueryPayload>(
    appendPath(env.metabase.baseUrl, `${endpointPrefix}/${config.dashboardId}/dashcard/${dashcardId}/card/${cardId}/query`),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ignore_cache: true,
        parameters: buildDashboardParameters(dashboard, dashcardId, cardId, input.platform, input.date)
      }),
      timeoutMs: env.pullerRequestTimeoutMs,
      label: `metabase_${cardKind}_card`
    }
  );
  const data = payload.data ?? {};
  const cols = data.cols ?? data.results_metadata?.columns ?? [];
  const rows = data.rows ?? [];
  return { cols, rows };
}

async function querySavedCard(config: MetabaseProductConfig, input: FetchRowsInput, cardKind: 'campaign' | 'ad' | 'asa_keyword'): Promise<{
  cols: MetabaseColumn[];
  rows: unknown[][];
}> {
  if (cardKind !== 'campaign') {
    return querySavedCardEndpoint(config, input, cardKind, false);
  }
  try {
    return await querySavedCardEndpoint(config, input, cardKind, true);
  } catch (error) {
    return querySavedCardEndpoint(config, input, cardKind, false);
  }
}

function parseCampaignRowsFromSavedCard(input: FetchRowsInput, cols: MetabaseColumn[], rows: unknown[][]): MetabaseAdsMetricRow[] {
  const dateIdx = firstExistingColumn(cols, ['create dt', 'create dt day', 'date'], ['create dt']);
  const platformIdx = firstExistingColumn(cols, ['platform']);
  const mediaIdx = firstExistingColumn(cols, ['af channel', 'af_channel', 'media source', 'pid', 'channel']);
  const countryIdx = firstExistingColumn(cols, ['country', 'geo']);
  const campaignIdx = firstExistingColumn(cols, ['af campaign name', 'af_campaign_name', 'campaign']);
  const installsIdx = firstExistingColumn(cols, ['installs', 'new users', 'new_users', 'attributions']);
  const paidUsersIdx = firstExistingColumn(cols, ['paid users', 'paid_users']);
  const costIdx = firstExistingColumn(cols, ['users cost', 'user cost', 'paid users cost', 'paid_users_cost', 'cost ($)', 'cost']);
  const impressionsIdx = firstExistingColumn(cols, ['impressions', 'impression']);
  const clicksIdx = firstExistingColumn(cols, ['clicks', 'click']);
  const d0Idx = firstExistingColumn(cols, ['d0 roi', 'd0 roas', 'd0_tch_roas_001']);
  const d7Idx = firstExistingColumn(cols, ['d7 roi', 'd7 roas', 'd7_tch_roas_001']);
  const d14Idx = firstExistingColumn(cols, ['d14 roi', 'd14 roas', 'd14_tch_roas_001']);
  const d30Idx = firstExistingColumn(cols, ['d30 roi', 'd30 roas', 'd30_tch_roas_001']);
  if (campaignIdx < 0) {
    throw new Error(`metabase_campaign_column_missing:${input.appKey}`);
  }

  return rows.flatMap((row) => {
    const campaign = valueToString(row[campaignIdx]) || 'unknown';
    if (!campaign || isTotalLike(campaign)) {
      return [];
    }
    const installs = parseMetricNumber(installsIdx >= 0 ? row[installsIdx] : 0);
    const cost = parseMetricNumber(costIdx >= 0 ? row[costIdx] : 0);
    const rawPlatform = platformIdx >= 0 ? valueToString(row[platformIdx]) : input.platform;
    const platform = normalizePlatform(rawPlatform || input.platform);
    if (platformIdx >= 0 && platform !== normalizePlatform(input.platform)) {
      return [];
    }
    const rowDate = dateIdx >= 0 ? parseDateCell(row[dateIdx], input.date) : input.date;
    if (dateIdx >= 0 && rowDate !== input.date) {
      return [];
    }
    const mediaSource = normalizeMetabaseMediaSource(mediaIdx >= 0 ? valueToString(row[mediaIdx]) : 'unknown');
    const rawJson = rowToRawJson(cols, row);
    return [
      {
        date: rowDate,
        app_key: input.appKey,
        platform,
        media_source: mediaSource,
        country: countryIdx >= 0 ? valueToString(row[countryIdx]) || 'unknown' : 'unknown',
        campaign,
        adset: 'unknown',
        ad: 'unknown',
        installs,
        paid_users: parseMetricNumber(paidUsersIdx >= 0 ? row[paidUsersIdx] : 0),
        cost,
        impressions: parseMetricNumber(impressionsIdx >= 0 ? row[impressionsIdx] : 0),
        clicks: parseMetricNumber(clicksIdx >= 0 ? row[clicksIdx] : 0),
        ecpi: installs > 0 ? cost / installs : 0,
        d0_roas: d0Idx >= 0 ? parseMetricRate(row[d0Idx]) : null,
        d7_roas: d7Idx >= 0 ? parseMetricRate(row[d7Idx]) : null,
        d14_roas: d14Idx >= 0 ? parseMetricRate(row[d14Idx]) : null,
        d30_roas: d30Idx >= 0 ? parseMetricRate(row[d30Idx]) : null,
        source_api: 'metabase_saved_card',
        raw_json: rawJson
      }
    ];
  });
}

function parseAsaKeywordRowsFromSavedCard(input: FetchRowsInput, cols: MetabaseColumn[], rows: unknown[][]): MetabaseAsaKeywordMetricRow[] {
  const dateIdx = firstExistingColumn(cols, ['create dt', 'create dt day', 'date'], ['create dt']);
  const platformIdx = firstExistingColumn(cols, ['platform']);
  const mediaIdx = firstExistingColumn(cols, ['af channel', 'af_channel', 'media source', 'pid', 'channel']);
  const campaignIdx = firstExistingColumn(cols, ['af campaign name', 'af_campaign_name', 'campaign']);
  const adsetIdx = firstExistingColumn(cols, ['adset name', 'adset_name', 'af adset', 'af_adset', 'adset']);
  const keywordIdx = firstExistingColumn(cols, ['af keywords', 'af_keywords', 'keyword', 'keywords']);
  const countryIdx = firstExistingColumn(cols, ['country', 'geo']);
  const installsIdx = firstExistingColumn(cols, ['installs', 'new users', 'new_users', 'attributions']);
  const paidUsersIdx = firstExistingColumn(cols, ['paid users', 'paid_users']);
  const costIdx = firstExistingColumn(cols, ['users cost', 'user cost', 'paid users cost', 'paid_users_cost', 'cost ($)', 'cost']);
  const d7Idx = firstExistingColumn(cols, ['d7 roi', 'd7 roas', 'd7_tch_roas_001']);
  if (keywordIdx < 0) {
    throw new Error(`metabase_asa_keyword_grain_unavailable:${input.appKey}:missing_af_keywords`);
  }
  if (campaignIdx < 0) {
    throw new Error(`metabase_asa_keyword_campaign_missing:${input.appKey}`);
  }
  return rows.flatMap((row) => {
    const keyword = valueToString(row[keywordIdx]);
    const campaign = valueToString(row[campaignIdx]) || 'unknown';
    if (!keyword || isTotalLike(keyword) || isTotalLike(campaign)) {
      return [];
    }
    const installs = parseMetricNumber(installsIdx >= 0 ? row[installsIdx] : 0);
    const cost = parseMetricNumber(costIdx >= 0 ? row[costIdx] : 0);
    const d7Roas = d7Idx >= 0 ? parseMetricRate(row[d7Idx]) : null;
    const rawPlatform = platformIdx >= 0 ? valueToString(row[platformIdx]) : input.platform;
    const platform = normalizePlatform(rawPlatform || input.platform);
    if (platformIdx >= 0 && platform !== normalizePlatform(input.platform)) {
      return [];
    }
    const rowDate = dateIdx >= 0 ? parseDateCell(row[dateIdx], input.date) : input.date;
    if (dateIdx >= 0 && rowDate !== input.date) {
      return [];
    }
    const rawJson = rowToRawJson(cols, row);
    return [
      {
        date: rowDate,
        app_key: input.appKey,
        platform,
        media_source: normalizeMetabaseMediaSource(mediaIdx >= 0 ? valueToString(row[mediaIdx]) : 'Apple Search Ads'),
        campaign,
        adset: adsetIdx >= 0 ? valueToString(row[adsetIdx]) || 'unknown' : 'unknown',
        keyword,
        country: countryIdx >= 0 ? valueToString(row[countryIdx]) || 'unknown' : 'unknown',
        installs,
        paid_users: parseMetricNumber(paidUsersIdx >= 0 ? row[paidUsersIdx] : 0),
        cost,
        ecpi: installs > 0 ? cost / installs : 0,
        d7_roas: d7Roas,
        revenue_d7: d7Roas == null ? null : cost * d7Roas,
        source_api: 'metabase_saved_card',
        raw_json: rawJson
      }
    ];
  });
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

async function getBigQueryAccessToken(): Promise<string> {
  if (bigQueryTokenPromise) {
    const cached = await bigQueryTokenPromise;
    if (cached.expiresAtMs > Date.now() + 60_000) {
      return cached.token;
    }
  }

  bigQueryTokenPromise = (async () => {
    const credentials = JSON.parse(await readFile(env.metabase.bigqueryCredentialsPath, 'utf8')) as BigQueryServiceAccount;
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('bigquery_credentials_invalid');
    }
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(
      JSON.stringify({
        iss: credentials.client_email,
        scope: 'https://www.googleapis.com/auth/bigquery',
        aud: credentials.token_uri ?? 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      })
    );
    const unsigned = `${header}.${payload}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key, 'base64url');
    const tokenPayload = await fetchJson<{ access_token?: string; expires_in?: number }>(
      credentials.token_uri ?? 'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${signature}`
        }).toString(),
        timeoutMs: env.pullerRequestTimeoutMs,
        label: 'bigquery_token'
      }
    );
    const token = String(tokenPayload.access_token || '').trim();
    if (!token) {
      throw new Error('bigquery_token_missing');
    }
    return {
      token,
      expiresAtMs: Date.now() + Math.max(300, Number(tokenPayload.expires_in || 3600) - 60) * 1000
    };
  })();

  return (await bigQueryTokenPromise).token;
}

async function runBigQuery(
  query: string,
  params: Record<string, { type: string; value: string }>
): Promise<Record<string, unknown>[]> {
  const token = await getBigQueryAccessToken();
  const response = await fetchJson<BigQueryQueryResponse>(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(env.metabase.bigqueryProject)}/queries`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        useLegacySql: false,
        parameterMode: 'NAMED',
        queryParameters: Object.entries(params).map(([name, param]) => ({
          name,
          parameterType: { type: param.type },
          parameterValue: { value: param.value }
        }))
      }),
      timeoutMs: env.pullerRequestTimeoutMs,
      label: 'bigquery_query'
    }
  );
  if (response.error?.message) {
    throw new Error(`bigquery_query_failed:${response.error.message}`);
  }
  const fields = response.schema?.fields ?? [];
  return (response.rows ?? []).map((row) => {
    const out: Record<string, unknown> = {};
    fields.forEach((field, index) => {
      out[String(field.name || `col_${index}`)] = row.f?.[index]?.v;
    });
    return out;
  });
}

function quoteBigQueryTable(project: string, schema: string, table: string): string {
  return `\`${project.replace(/`/g, '')}.${schema.replace(/`/g, '')}.${table.replace(/`/g, '')}\``;
}

async function fetchCampaignRowsFromBigQuery(config: MetabaseProductConfig, input: FetchRowsInput): Promise<MetabaseAdsMetricRow[]> {
  const table = quoteBigQueryTable(env.metabase.bigqueryProject, config.schema, 'ads_common_ua_af_campaign_metric_da');
  const rows = await runBigQuery(
    `SELECT
       CAST(create_dt AS STRING) AS date,
       LOWER(CAST(platform AS STRING)) AS platform,
       COALESCE(CAST(country AS STRING), 'unknown') AS country,
       COALESCE(CAST(af_channel AS STRING), 'unknown') AS media_source,
       COALESCE(CAST(af_campaign_name AS STRING), 'unknown') AS campaign,
       SUM(COALESCE(new_users, 0)) AS installs,
       SUM(COALESCE(paid_users, 0)) AS paid_users,
       SUM(COALESCE(paid_users_cost, 0)) AS cost,
       SUM(COALESCE(impression, 0)) AS impressions,
       SUM(COALESCE(click, 0)) AS clicks,
	       IF(COUNTIF(d0_tch_roas_001 IS NOT NULL) > 0, SAFE_DIVIDE(SUM(COALESCE(d0_tch_roas_001, 0)), SUM(COALESCE(paid_users_cost, 0))), NULL) AS d0_roas,
	       IF(COUNTIF(d7_tch_roas_001 IS NOT NULL) > 0, SAFE_DIVIDE(SUM(COALESCE(d7_tch_roas_001, 0)), SUM(COALESCE(paid_users_cost, 0))), NULL) AS d7_roas,
	       IF(COUNTIF(d14_tch_roas_001 IS NOT NULL) > 0, SAFE_DIVIDE(SUM(COALESCE(d14_tch_roas_001, 0)), SUM(COALESCE(paid_users_cost, 0))), NULL) AS d14_roas,
	       IF(COUNTIF(d30_tch_roas_001 IS NOT NULL) > 0, SAFE_DIVIDE(SUM(COALESCE(d30_tch_roas_001, 0)), SUM(COALESCE(paid_users_cost, 0))), NULL) AS d30_roas
     FROM ${table}
     WHERE create_dt = @date
       AND LOWER(CAST(platform AS STRING)) = @platform
     GROUP BY date, platform, country, media_source, campaign`,
    {
      date: { type: 'DATE', value: input.date },
      platform: { type: 'STRING', value: normalizePlatform(input.platform) }
    }
  );

  return rows.map((row) => {
    const installs = parseMetricNumber(row.installs);
    const cost = parseMetricNumber(row.cost);
    return {
      date: valueToString(row.date) || input.date,
      app_key: input.appKey,
      platform: normalizePlatform(valueToString(row.platform) || input.platform),
      media_source: normalizeMetabaseMediaSource(valueToString(row.media_source)),
      country: valueToString(row.country) || 'unknown',
      campaign: valueToString(row.campaign) || 'unknown',
      adset: 'unknown',
      ad: 'unknown',
      installs,
      paid_users: parseMetricNumber(row.paid_users),
      cost,
      impressions: parseMetricNumber(row.impressions),
      clicks: parseMetricNumber(row.clicks),
      ecpi: installs > 0 ? cost / installs : 0,
      d0_roas: parseMetricRate(row.d0_roas),
      d7_roas: parseMetricRate(row.d7_roas),
      d14_roas: parseMetricRate(row.d14_roas),
      d30_roas: parseMetricRate(row.d30_roas),
      source_api: 'bigquery_warehouse',
      raw_json: row
    };
  });
}

async function fetchAsaKeywordRowsFromBigQuery(
  config: MetabaseProductConfig,
  input: FetchRowsInput
): Promise<MetabaseAsaKeywordMetricRow[]> {
  if (!config.asaKeywordTable) {
    throw new Error(`metabase_asa_keyword_grain_unavailable:${input.appKey}:missing_asa_keyword_table`);
  }
  const table = config.asaKeywordTable.includes('.')
    ? `\`${config.asaKeywordTable.replace(/`/g, '')}\``
    : quoteBigQueryTable(env.metabase.bigqueryProject, config.schema, config.asaKeywordTable);
  const rows = await runBigQuery(
    `SELECT
       CAST(create_dt AS STRING) AS date,
       LOWER(CAST(platform AS STRING)) AS platform,
       COALESCE(CAST(af_channel AS STRING), 'Apple Search Ads') AS media_source,
       COALESCE(CAST(af_campaign_name AS STRING), 'unknown') AS campaign,
       COALESCE(CAST(adset_name AS STRING), 'unknown') AS adset,
       COALESCE(CAST(af_keywords AS STRING), '') AS keyword,
       COALESCE(CAST(country AS STRING), 'unknown') AS country,
       SUM(COALESCE(new_users, 0)) AS installs,
       SUM(COALESCE(paid_users, 0)) AS paid_users,
       SUM(COALESCE(paid_users_cost, 0)) AS cost,
	       IF(COUNTIF(d7_tch_roas_001 IS NOT NULL) > 0, SUM(COALESCE(d7_tch_roas_001, 0)), NULL) AS revenue_d7,
	       IF(COUNTIF(d7_tch_roas_001 IS NOT NULL) > 0, SAFE_DIVIDE(SUM(COALESCE(d7_tch_roas_001, 0)), SUM(COALESCE(paid_users_cost, 0))), NULL) AS d7_roas
     FROM ${table}
     WHERE create_dt = @date
       AND LOWER(CAST(platform AS STRING)) = @platform
       AND LOWER(CAST(af_channel AS STRING)) IN ('apple search ads', 'apple search')
     GROUP BY date, platform, media_source, campaign, adset, keyword, country`,
    {
      date: { type: 'DATE', value: input.date },
      platform: { type: 'STRING', value: normalizePlatform(input.platform) }
    }
  );

  return rows
    .map((row) => {
      const installs = parseMetricNumber(row.installs);
      const cost = parseMetricNumber(row.cost);
      const d7Roas = parseMetricRate(row.d7_roas);
      return {
        date: valueToString(row.date) || input.date,
        app_key: input.appKey,
        platform: normalizePlatform(valueToString(row.platform) || input.platform),
        media_source: normalizeMetabaseMediaSource(valueToString(row.media_source)),
        campaign: valueToString(row.campaign) || 'unknown',
        adset: valueToString(row.adset) || 'unknown',
        keyword: valueToString(row.keyword),
        country: valueToString(row.country) || 'unknown',
        installs,
        paid_users: parseMetricNumber(row.paid_users),
        cost,
        ecpi: installs > 0 ? cost / installs : 0,
        d7_roas: d7Roas,
        revenue_d7: d7Roas == null ? null : cost * d7Roas,
        source_api: 'bigquery_warehouse' as const,
        raw_json: row
      };
    })
    .filter((row) => row.keyword.length > 0);
}

async function fetchWithConfiguredAccess<T>(
  input: FetchRowsInput,
  savedCardFetcher: () => Promise<T>,
  bigQueryFetcher: () => Promise<T>
): Promise<T> {
  if (env.metabase.accessMode === 'saved_card') {
    return savedCardFetcher();
  }
  if (env.metabase.accessMode === 'bigquery') {
    return bigQueryFetcher();
  }
  const canUseSavedCard = hasSavedCardAuthConfig();
  const canUseBigQuery = hasBigQueryConfig();
  let savedCardError: unknown = null;
  if (canUseSavedCard) {
    try {
      return await savedCardFetcher();
    } catch (error) {
      savedCardError = error;
    }
  }
  if (canUseBigQuery) {
    return bigQueryFetcher();
  }
  throw savedCardError instanceof Error ? savedCardError : new Error(`metabase_access_not_configured:${input.appKey}`);
}

export async function fetchMetabaseCampaignMetrics(input: FetchRowsInput): Promise<MetabaseAdsMetricRow[]> {
  const config = getMetabaseProductConfig(input.appKey);
  if (!config) {
    throw new Error(`metabase_product_not_configured:${input.appKey}`);
  }
  return fetchWithConfiguredAccess(
    input,
    async () => {
      const result = await querySavedCard(config, input, 'campaign');
      return parseCampaignRowsFromSavedCard(input, result.cols, result.rows);
    },
    () => fetchCampaignRowsFromBigQuery(config, input)
  );
}

export async function fetchMetabaseAsaKeywordMetrics(input: FetchRowsInput): Promise<MetabaseAsaKeywordMetricRow[]> {
  const config = getMetabaseProductConfig(input.appKey);
  if (!config) {
    throw new Error(`metabase_product_not_configured:${input.appKey}`);
  }
  return fetchWithConfiguredAccess(
    input,
    async () => {
      const result = await querySavedCard(config, input, config.asaKeywordCardId ? 'asa_keyword' : 'ad');
      return parseAsaKeywordRowsFromSavedCard(input, result.cols, result.rows);
    },
    () => fetchAsaKeywordRowsFromBigQuery(config, input)
  );
}

export async function recordMetabaseOfficialSnapshot(input: {
  appKey: string;
  platform: string;
  date: string;
  rowCount: number;
  rows: unknown[];
  sourceApi: MetabaseAccessSourceApi;
  appId?: string;
  status?: 'failed';
  error?: string | null;
}): Promise<void> {
  const isProvisional = isAfWindowProvisional(input.date);
  await upsertAfOfficialSnapshot({
    metricScope: classifyAfSyncScope(input.date),
    sourceSurface: 'metabase_dashboard',
    sourceApi: input.sourceApi,
    appKey: input.appKey,
    platform: input.platform,
    appId: input.appId ?? '',
    windowFrom: input.date,
    windowTo: input.date,
    timezone: 'preferred',
    currency: 'preferred',
    queryParams: {
      date: input.date,
      platform: input.platform,
      access_mode: env.metabase.accessMode
    },
    rowCount: input.rowCount,
    contentSignature: buildAfContentSignature(input.rows),
    status: input.status ?? (isProvisional ? 'provisional' : undefined),
    isProvisional,
    error: input.error ?? null,
    metadataJson: {
      source_report: METABASE_DAILY_SOURCE_REPORT
    }
  });
}
