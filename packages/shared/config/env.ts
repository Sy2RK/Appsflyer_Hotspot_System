import dotenv from 'dotenv';

dotenv.config();

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
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: optionalNumber('PORT', 3000),
  timezone: process.env.TZ ?? 'Asia/Shanghai',

  clickhouse: {
    host: requireEnv('CLICKHOUSE_HOST', 'localhost'),
    port: optionalNumber('CLICKHOUSE_PORT', 8123),
    user: requireEnv('CLICKHOUSE_USER', 'default'),
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: requireEnv('CLICKHOUSE_DB', 'hotspot')
  },

  postgresUrl: requireEnv('POSTGRES_URL', 'postgres://postgres:postgres@localhost:5432/hotspot'),
  redisUrl: process.env.REDIS_URL ?? '',
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
  feishuAppId: process.env.FEISHU_APP_ID ?? '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET ?? '',
  feishuChatId: process.env.FEISHU_CHAT_ID ?? '',
  pullToken: process.env.APPSFLYER_PULL_TOKEN ?? '',

  aggregatorLookbackHours: optionalNumber('AGGREGATOR_LOOKBACK_HOURS', 6),
  aggregatorIntervalMs: optionalNumber('AGGREGATOR_INTERVAL_MS', 5 * 60 * 1000),
  detectorIntervalMs: optionalNumber('DETECTOR_INTERVAL_MS', 5 * 60 * 1000),
  pullerIntervalMs: optionalNumber('PULLER_INTERVAL_MS', 24 * 60 * 60 * 1000),
  pullerBackfillDays: optionalNumber('PULLER_BACKFILL_DAYS', 3),
  pullerRunOnBoot: (process.env.PULLER_RUN_ON_BOOT ?? 'false').toLowerCase() === 'true',
  pullerRequestIntervalMs: optionalNumber('PULLER_REQUEST_INTERVAL_MS', 1000),
  pullerLockTtlMs: optionalNumber('PULLER_LOCK_TTL_MS', 15 * 60 * 1000),
  pullerSameContentCooldownRecentMs: optionalNumber(
    'PULLER_SAME_CONTENT_COOLDOWN_RECENT_MS',
    2 * 60 * 60 * 1000
  ),
  pullerSameContentCooldownHistoricalMs: optionalNumber(
    'PULLER_SAME_CONTENT_COOLDOWN_HISTORICAL_MS',
    24 * 60 * 60 * 1000
  ),

  keywordEngineIntervalMs: optionalNumber('KEYWORD_ENGINE_INTERVAL_MS', 24 * 60 * 60 * 1000),
  keywordEngineInitialBackfillDays: optionalNumber('KEYWORD_ENGINE_INITIAL_BACKFILL_DAYS', 30),
  keywordEngineRollingBackfillDays: optionalNumber('KEYWORD_ENGINE_ROLLING_BACKFILL_DAYS', 3),
  budgetAdvisorIntervalMs: optionalNumber('BUDGET_ADVISOR_INTERVAL_MS', 24 * 60 * 60 * 1000),
  budgetAdvisorLookbackDays: optionalNumber('BUDGET_ADVISOR_LOOKBACK_DAYS', 30),
  dailyBriefEnabled: (process.env.DAILY_BRIEF_ENABLED ?? 'true').toLowerCase() !== 'false',
  dailyBriefIntervalMs: optionalNumber('DAILY_BRIEF_INTERVAL_MS', 60 * 60 * 1000),
  dailyBriefReportHour: optionalNumber('DAILY_BRIEF_REPORT_HOUR', 10),
  dailyBriefTitlePrefix: process.env.DAILY_BRIEF_TITLE_PREFIX ?? 'Hotspot 每日简报',

  qwen: {
    baseUrl: process.env.QWEN_BASE_URL ?? '',
    apiKey: process.env.QWEN_API_KEY ?? '',
    model: process.env.QWEN_MODEL ?? 'qwen3.5-plus',
    thinkingEnabled: (process.env.QWEN_THINKING_ENABLED ?? 'true').toLowerCase() !== 'false',
    timeoutMs: optionalNumber('QWEN_TIMEOUT_MS', 15000),
    maxTokens: optionalNumber('QWEN_MAX_TOKENS', 1200)
  }
};

export type AppEnv = typeof env;
