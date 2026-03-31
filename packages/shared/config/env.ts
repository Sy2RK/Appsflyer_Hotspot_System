import dotenv from 'dotenv';

dotenv.config();

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number env ${name}: ${raw}`);
  }
  return parsed;
}

export const env = {
  nodeEnv,
  port: optionalNumber('PORT', 3000),
  timezone: process.env.TZ ?? 'Asia/Shanghai',
  adminBasicAuthUser: process.env.ADMIN_BASIC_AUTH_USER?.trim() ?? '',
  adminBasicAuthPassword: process.env.ADMIN_BASIC_AUTH_PASSWORD ?? '',

  clickhouse: {
    host: requireEnv('CLICKHOUSE_HOST', 'localhost'),
    port: optionalNumber('CLICKHOUSE_PORT', 8123),
    user: isProduction ? requireEnv('CLICKHOUSE_USER') : requireEnv('CLICKHOUSE_USER', 'default'),
    password: requireEnv('CLICKHOUSE_PASSWORD'),
    database: requireEnv('CLICKHOUSE_DB', 'hotspot')
  },

  postgresUrl: isProduction
    ? requireEnv('POSTGRES_URL')
    : requireEnv('POSTGRES_URL', 'postgres://postgres:postgres@localhost:5432/hotspot'),
  redisUrl: process.env.REDIS_URL ?? '',
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
  feishuAppId: process.env.FEISHU_APP_ID ?? '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET ?? '',
  feishuChatId: process.env.FEISHU_CHAT_ID ?? '',
  feishuBitableAppToken: process.env.FEISHU_BITABLE_APP_TOKEN ?? '',
  feishuBitableBaseUrl: process.env.FEISHU_BITABLE_BASE_URL ?? '',
  feishuBitablePullTableId: process.env.FEISHU_BITABLE_PULL_TABLE_ID ?? '',
  feishuBitablePullViewId: process.env.FEISHU_BITABLE_PULL_VIEW_ID ?? '',
  feishuBitableAsaTableName: process.env.FEISHU_BITABLE_ASA_TABLE_NAME ?? 'ASA Raw 明细',
  feishuBitableActionTableName: process.env.FEISHU_BITABLE_ACTION_TABLE_NAME ?? '投放执行表',
  pullToken: process.env.APPSFLYER_PULL_TOKEN ?? '',
  masterApiToken:
    process.env.APPSFLYER_MASTER_API_TOKEN ??
    process.env.APPSFLYER_PULL_TOKEN ??
    '',
  rawDataToken:
    process.env.BI_APPSFLYER_RAWDATA_TOKEN ??
    process.env.bi_appsflyer_rawdata_token ??
    process.env.APPSFLYER_RAWDATA_TOKEN ??
    process.env.APPSFLYER_PULL_TOKEN ??
    '',
  rawDataEndpointTemplate:
    process.env.APPSFLYER_RAWDATA_ENDPOINT_TEMPLATE ??
    'https://hq1.appsflyer.com/api/raw-data/export/app/{app_id}/in_app_events_report/v5',
  rawInstallsEndpointTemplate:
    process.env.APPSFLYER_RAW_INSTALLS_ENDPOINT_TEMPLATE ??
    'https://hq1.appsflyer.com/api/raw-data/export/app/{app_id}/installs_report/v5',
  rawEventsEndpointTemplate:
    process.env.APPSFLYER_RAW_EVENTS_ENDPOINT_TEMPLATE ??
    'https://hq1.appsflyer.com/api/raw-data/export/app/{app_id}/in_app_events_report/v5',

  aggregatorLookbackHours: optionalNumber('AGGREGATOR_LOOKBACK_HOURS', 6),
  aggregatorIntervalMs: optionalNumber('AGGREGATOR_INTERVAL_MS', 5 * 60 * 1000),
  aggregatorLockTtlMs: optionalNumber('AGGREGATOR_LOCK_TTL_MS', 30 * 60 * 1000),
  detectorIntervalMs: optionalNumber('DETECTOR_INTERVAL_MS', 5 * 60 * 1000),
  pullerIntervalMs: optionalNumber('PULLER_INTERVAL_MS', 24 * 60 * 60 * 1000),
  pullerReportHour: optionalNumber('PULLER_REPORT_HOUR', 9),
  pullerBackfillDays: optionalNumber('PULLER_BACKFILL_DAYS', 3),
  pullerRunOnBoot: (process.env.PULLER_RUN_ON_BOOT ?? 'false').toLowerCase() === 'true',
  pullerRequestIntervalMs: optionalNumber('PULLER_REQUEST_INTERVAL_MS', 1000),
  pullerRequestTimeoutMs: optionalNumber('PULLER_REQUEST_TIMEOUT_MS', 20 * 1000),
  pullerLockTtlMs: optionalNumber('PULLER_LOCK_TTL_MS', 15 * 60 * 1000),
  pullerSameContentCooldownRecentMs: optionalNumber(
    'PULLER_SAME_CONTENT_COOLDOWN_RECENT_MS',
    2 * 60 * 60 * 1000
  ),
  pullerSameContentCooldownHistoricalMs: optionalNumber(
    'PULLER_SAME_CONTENT_COOLDOWN_HISTORICAL_MS',
    24 * 60 * 60 * 1000
  ),
  scheduledWorkerMaxRuntimeMs: optionalNumber('SCHEDULED_WORKER_MAX_RUNTIME_MS', 6 * 60 * 60 * 1000),

  keywordEngineInitialBackfillDays: optionalNumber('KEYWORD_ENGINE_INITIAL_BACKFILL_DAYS', 30),
  keywordEngineRollingBackfillDays: optionalNumber('KEYWORD_ENGINE_ROLLING_BACKFILL_DAYS', 3),
  budgetAdvisorIntervalMs: optionalNumber('BUDGET_ADVISOR_INTERVAL_MS', 24 * 60 * 60 * 1000),
  budgetAdvisorLookbackDays: optionalNumber('BUDGET_ADVISOR_LOOKBACK_DAYS', 30),
  asaKeywordIntervalMs: optionalNumber('ASA_KEYWORD_INTERVAL_MS', 24 * 60 * 60 * 1000),
  asaKeywordReportHour: optionalNumber('ASA_KEYWORD_REPORT_HOUR', 9),
  asaKeywordBackfillDays: optionalNumber('ASA_KEYWORD_BACKFILL_DAYS', 14),
  asaKeywordRunOnBoot: (process.env.ASA_KEYWORD_RUN_ON_BOOT ?? 'false').toLowerCase() === 'true',
  asaKeywordRequestIntervalMs: optionalNumber('ASA_KEYWORD_REQUEST_INTERVAL_MS', 1200),
  asaKeywordRequestTimeoutMs: optionalNumber('ASA_KEYWORD_REQUEST_TIMEOUT_MS', 20 * 1000),
  asaMasterApiRequestIntervalMs: optionalNumber(
    'ASA_MASTER_API_REQUEST_INTERVAL_MS',
    optionalNumber('ASA_KEYWORD_REQUEST_INTERVAL_MS', 1200)
  ),
  asaMasterApiTimeoutMs: optionalNumber(
    'ASA_MASTER_API_TIMEOUT_MS',
    optionalNumber('ASA_KEYWORD_REQUEST_TIMEOUT_MS', 20 * 1000)
  ),
  asaDailyBriefEnabled: (process.env.ASA_DAILY_BRIEF_ENABLED ?? 'true').toLowerCase() !== 'false',
  asaDailyBriefIntervalMs: optionalNumber('ASA_DAILY_BRIEF_INTERVAL_MS', 60 * 60 * 1000),
  asaDailyBriefReportHour: optionalNumber('ASA_DAILY_BRIEF_REPORT_HOUR', 10),
  feishuBitableEnabled: (process.env.FEISHU_BITABLE_ENABLED ?? 'true').toLowerCase() !== 'false',
  feishuBitableScheduleHour: optionalNumber('FEISHU_BITABLE_SCHEDULE_HOUR', 10),
  feishuBitableScheduleMinute: optionalNumber('FEISHU_BITABLE_SCHEDULE_MINUTE', 5),
  bitableFeedbackSyncIntervalMs: optionalNumber('BITABLE_FEEDBACK_SYNC_INTERVAL_MS', 15 * 60 * 1000),
  dailyBriefEnabled: (process.env.DAILY_BRIEF_ENABLED ?? 'true').toLowerCase() !== 'false',
  dailyBriefIntervalMs: optionalNumber('DAILY_BRIEF_INTERVAL_MS', 60 * 60 * 1000),
  dailyBriefReportHour: optionalNumber('DAILY_BRIEF_REPORT_HOUR', 10),
  dailyBriefTitlePrefix: process.env.DAILY_BRIEF_TITLE_PREFIX ?? 'Hotspot 每日简报',
  detectorLockTtlMs: optionalNumber('DETECTOR_LOCK_TTL_MS', 30 * 60 * 1000),

  qwen: {
    baseUrl: process.env.QWEN_BASE_URL ?? '',
    apiKey: process.env.QWEN_API_KEY ?? '',
    model: process.env.QWEN_MODEL ?? 'qwen3.5-plus',
    thinkingEnabled: (process.env.QWEN_THINKING_ENABLED ?? 'true').toLowerCase() !== 'false',
    timeoutMs: optionalNumber('QWEN_TIMEOUT_MS', 15000),
    maxTokens: optionalNumber('QWEN_MAX_TOKENS', 1200)
  }
};

function pushMissing(missing: string[], name: string, value: string): void {
  if (!String(value || '').trim()) {
    missing.push(name);
  }
}

function hasValue(value: string): boolean {
  return String(value || '').trim().length > 0;
}

function validateEnv(): void {
  const missing: string[] = [];
  pushMissing(missing, 'CLICKHOUSE_HOST', env.clickhouse.host);
  pushMissing(missing, 'CLICKHOUSE_USER', env.clickhouse.user);
  pushMissing(missing, 'CLICKHOUSE_PASSWORD', env.clickhouse.password);
  pushMissing(missing, 'CLICKHOUSE_DB', env.clickhouse.database);

  const hasGlobalFeishuAppId = hasValue(env.feishuAppId);
  const hasGlobalFeishuAppSecret = hasValue(env.feishuAppSecret);
  const hasGlobalFeishuChatId = hasValue(env.feishuChatId);
  const hasAnyGlobalFeishuConfig = hasGlobalFeishuAppId || hasGlobalFeishuAppSecret || hasGlobalFeishuChatId;
  if (hasAnyGlobalFeishuConfig) {
    pushMissing(missing, 'FEISHU_APP_ID', env.feishuAppId);
    pushMissing(missing, 'FEISHU_APP_SECRET', env.feishuAppSecret);
    pushMissing(missing, 'FEISHU_CHAT_ID', env.feishuChatId);
  }
  if (env.feishuBitableEnabled) {
    pushMissing(missing, 'FEISHU_BITABLE_APP_TOKEN', env.feishuBitableAppToken);
    pushMissing(missing, 'FEISHU_BITABLE_BASE_URL', env.feishuBitableBaseUrl);
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }
}

validateEnv();

export type AppEnv = typeof env;
