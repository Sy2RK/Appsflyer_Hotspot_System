import { pgQuery } from './postgres.js';
import {
  AlertRecord,
  AppConfigRecord,
  AsaKeywordRecommendationRow,
  AsaKeywordRouteRecord,
  AsaKeywordStateRow,
  BudgetExecutionAction,
  BitableExportConfigRecord,
  BitableExportDailyTableRecord,
  BitableExportRecordRefRecord,
  BudgetRecommendationRow,
  BudgetRecommendationStatus,
  BitableExportSourceType,
  DailyBriefDispatchRecord,
  DailyBriefRouteRecord,
  FeedbackSkillVersionRecord,
  KeywordExtractRuleRecord,
  KeywordLifecycleStateRow,
  OperationLogRecord,
  ProductStage,
  ProductStageConfigRecord,
  RecommendationPolicyConfigRecord,
  RecommendationPolicyEngine,
  RecommendationExecutionFeedbackRecord,
  RecommendationType,
  RoasPrimarySource,
  RoasDataStatus,
  RoasWarningCode,
  RuntimeScheduleConfigRecord
} from '../types/models.js';

export interface RuleRecord {
  id: number;
  app_key: string;
  name: string;
  enabled: boolean;
  rule_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AppRuleRecord extends RuleRecord {
  ios_pull_app_id: string;
  android_pull_app_id: string;
  timezone: string;
  notify_webhook_url: string | null;
  notify_feishu_app_id: string | null;
  notify_feishu_app_secret: string | null;
  notify_feishu_chat_id: string | null;
}

export interface AlertsFilter {
  appKey?: string;
  platform?: string;
  status?: 'open' | 'resolved';
  severity?: 'P0' | 'P1' | 'P2';
  from?: string;
  to?: string;
  limit?: number;
}

export interface UpsertAppInput {
  app_key: string;
  display_name?: string;
  ios_display_name?: string;
  android_display_name?: string;
  pull_app_id: string;
  ios_pull_app_id?: string;
  android_pull_app_id?: string;
  dataset: string;
  push_auth_token?: string;
  timezone: string;
  notify_webhook_url?: string | null;
  notify_feishu_app_id?: string | null;
  notify_feishu_app_secret?: string | null;
  notify_feishu_chat_id?: string | null;
  replace_notify_feishu_app_secret?: boolean;
}

export interface PullCycleLockRecord {
  name: string;
  owner_id: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface PullContentGuardRecord {
  app_key: string;
  platform: string;
  report_date: string;
  source_report: string;
  content_signature: string;
  last_status: string;
  last_error: string | null;
  attempted_at: string;
  next_allowed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PullReportReadinessStatus = 'pending' | 'ready' | 'blocked';

export interface PullReportReadinessRecord {
  report_date: string;
  source_report: string;
  status: PullReportReadinessStatus;
  expected_targets: number;
  ok_targets: number;
  blocked_targets: number;
  last_cycle_started_at: string | null;
  last_cycle_finished_at: string | null;
  last_error_summary: string | null;
  updated_at: string;
}

export type ScheduledWorkerRunStatus = 'running' | 'failed' | 'completed';

export interface ScheduledWorkerRunRecord {
  worker_name: string;
  run_marker: string;
  status: ScheduledWorkerRunStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  next_allowed_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertPullContentGuardInput {
  app_key: string;
  platform: string;
  report_date: string;
  source_report: string;
  content_signature?: string;
  last_status: string;
  last_error?: string | null;
  attempted_at?: string;
  next_allowed_at?: string | null;
}

export interface UpsertPullReportReadinessInput {
  report_date: string;
  source_report: string;
  status: PullReportReadinessStatus;
  expected_targets: number;
  ok_targets: number;
  blocked_targets: number;
  last_cycle_started_at?: string | null;
  last_cycle_finished_at?: string | null;
  last_error_summary?: string | null;
}

export async function claimIngestDedupKeys(
  rows: Array<{ event_uid: string; app_key: string }>
): Promise<Set<string>> {
  if (rows.length === 0) {
    return new Set();
  }

  const eventUids = rows.map((row) => row.event_uid);
  const appKeys = rows.map((row) => row.app_key);
  const result = await pgQuery<{ event_uid: string }>(
    `INSERT INTO ingest_dedup_keys (event_uid, app_key)
     SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (event_uid) DO NOTHING
     RETURNING event_uid`,
    [eventUids, appKeys]
  );

  return new Set(result.rows.map((row) => row.event_uid));
}

export async function releaseIngestDedupKeys(eventUids: string[]): Promise<void> {
  if (eventUids.length === 0) {
    return;
  }

  await pgQuery(`DELETE FROM ingest_dedup_keys WHERE event_uid = ANY($1::text[])`, [eventUids]);
}

export async function tryAcquirePullCycleLock(name: string, ownerId: string, ttlMs: number): Promise<boolean> {
  const result = await pgQuery<{ name: string }>(
    `INSERT INTO pull_cycle_locks (name, owner_id, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'))
     ON CONFLICT (name) DO UPDATE
        SET owner_id = EXCLUDED.owner_id,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
      WHERE pull_cycle_locks.expires_at <= NOW()
     RETURNING name`,
    [name, ownerId, Math.max(1000, Math.floor(ttlMs))]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function releasePullCycleLock(name: string, ownerId: string): Promise<void> {
  await pgQuery(`DELETE FROM pull_cycle_locks WHERE name = $1 AND owner_id = $2`, [name, ownerId]);
}

export async function renewPullCycleLock(name: string, ownerId: string, ttlMs: number): Promise<boolean> {
  const result = await pgQuery<{ name: string }>(
    `UPDATE pull_cycle_locks
        SET expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
            updated_at = NOW()
      WHERE name = $1
        AND owner_id = $2
      RETURNING name`,
    [name, ownerId, Math.max(1000, Math.floor(ttlMs))]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function getActivePullCycleLock(name: string): Promise<PullCycleLockRecord | null> {
  const result = await pgQuery<PullCycleLockRecord>(
    `SELECT name, owner_id, expires_at, created_at, updated_at
       FROM pull_cycle_locks
      WHERE name = $1
        AND expires_at > NOW()
      LIMIT 1`,
    [name]
  );

  return result.rows[0] ?? null;
}

export async function tryAcquireJobLock(name: string, ownerId: string, ttlMs: number): Promise<boolean> {
  return tryAcquirePullCycleLock(name, ownerId, ttlMs);
}

export async function releaseJobLock(name: string, ownerId: string): Promise<void> {
  await releasePullCycleLock(name, ownerId);
}

export async function renewJobLock(name: string, ownerId: string, ttlMs: number): Promise<boolean> {
  return renewPullCycleLock(name, ownerId, ttlMs);
}

export async function getActiveJobLock(name: string): Promise<PullCycleLockRecord | null> {
  return getActivePullCycleLock(name);
}

let ensureBitableExportRecordRefsSchemaPromise: Promise<void> | null = null;
let ensureBitableExportConfigSchemaPromise: Promise<void> | null = null;
let ensureBitableExportDailyTablesSchemaPromise: Promise<void> | null = null;
let ensureRecommendationExecutionFeedbacksSchemaPromise: Promise<void> | null = null;
let ensureFeedbackSkillVersionsSchemaPromise: Promise<void> | null = null;
let ensurePullReportReadinessSchemaPromise: Promise<void> | null = null;
let ensureScheduledWorkerRunsSchemaPromise: Promise<void> | null = null;
let ensureRecommendationPolicyConfigsSchemaPromise: Promise<void> | null = null;
let ensureBudgetRecommendationsSchemaPromise: Promise<void> | null = null;
let ensureAsaKeywordRoasSchemaPromise: Promise<void> | null = null;

async function ensurePullReportReadinessSchema(): Promise<void> {
  if (!ensurePullReportReadinessSchemaPromise) {
    ensurePullReportReadinessSchemaPromise = (async () => {
      await pgQuery(`CREATE TABLE IF NOT EXISTS pull_report_readiness (
        report_date DATE NOT NULL,
        source_report TEXT NOT NULL DEFAULT 'daily_report_v5',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'blocked')),
        expected_targets INTEGER NOT NULL DEFAULT 0,
        ok_targets INTEGER NOT NULL DEFAULT 0,
        blocked_targets INTEGER NOT NULL DEFAULT 0,
        last_cycle_started_at TIMESTAMPTZ,
        last_cycle_finished_at TIMESTAMPTZ,
        last_error_summary TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (report_date, source_report)
      )`);
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_pull_report_readiness_status
          ON pull_report_readiness (status, report_date DESC)`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensurePullReportReadinessSchemaPromise = null;
        throw error;
      });
  }
  await ensurePullReportReadinessSchemaPromise;
}

export async function ensureBudgetRecommendationsSchema(): Promise<void> {
  if (!ensureBudgetRecommendationsSchemaPromise) {
    ensureBudgetRecommendationsSchemaPromise = (async () => {
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS execution_actions JSONB NOT NULL DEFAULT '[]'::jsonb`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS scenario_tags JSONB NOT NULL DEFAULT '[]'::jsonb`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS roas_window_from DATE`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS roas_window_to DATE`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS roas_data_status TEXT NOT NULL DEFAULT 'unavailable'`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS af_cohort_roas DOUBLE PRECISION`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS local_derived_roas DOUBLE PRECISION`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS roas_primary_source TEXT NOT NULL DEFAULT 'local_fallback'`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS roas_warning_code TEXT NOT NULL DEFAULT 'none'`
      );
      await pgQuery(
        `ALTER TABLE budget_recommendations
            ADD COLUMN IF NOT EXISTS roas_deviation_ratio DOUBLE PRECISION`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensureBudgetRecommendationsSchemaPromise = null;
        throw error;
      });
  }
  await ensureBudgetRecommendationsSchemaPromise;
}

export async function ensureAsaKeywordRoasSchema(): Promise<void> {
  if (!ensureAsaKeywordRoasSchemaPromise) {
    ensureAsaKeywordRoasSchemaPromise = (async () => {
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS roas_window_from DATE`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS roas_window_to DATE`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS roas_data_status TEXT NOT NULL DEFAULT 'unavailable'`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS roas_coverage_ratio DOUBLE PRECISION NOT NULL DEFAULT 0`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS af_cohort_roas DOUBLE PRECISION`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS local_derived_roas DOUBLE PRECISION`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS roas_primary_source TEXT NOT NULL DEFAULT 'local_fallback'`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS roas_warning_code TEXT NOT NULL DEFAULT 'none'`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_states
            ADD COLUMN IF NOT EXISTS roas_deviation_ratio DOUBLE PRECISION`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_recommendations
            ADD COLUMN IF NOT EXISTS roas_window_from DATE`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_recommendations
            ADD COLUMN IF NOT EXISTS roas_window_to DATE`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_recommendations
            ADD COLUMN IF NOT EXISTS roas_data_status TEXT NOT NULL DEFAULT 'unavailable'`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_recommendations
            ADD COLUMN IF NOT EXISTS af_cohort_roas DOUBLE PRECISION`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_recommendations
            ADD COLUMN IF NOT EXISTS local_derived_roas DOUBLE PRECISION`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_recommendations
            ADD COLUMN IF NOT EXISTS roas_primary_source TEXT NOT NULL DEFAULT 'local_fallback'`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_recommendations
            ADD COLUMN IF NOT EXISTS roas_warning_code TEXT NOT NULL DEFAULT 'none'`
      );
      await pgQuery(
        `ALTER TABLE asa_keyword_recommendations
            ADD COLUMN IF NOT EXISTS roas_deviation_ratio DOUBLE PRECISION`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensureAsaKeywordRoasSchemaPromise = null;
        throw error;
      });
  }
  await ensureAsaKeywordRoasSchemaPromise;
}

async function ensureScheduledWorkerRunsSchema(): Promise<void> {
  if (!ensureScheduledWorkerRunsSchemaPromise) {
    ensureScheduledWorkerRunsSchemaPromise = (async () => {
      await pgQuery(`CREATE TABLE IF NOT EXISTS scheduled_worker_runs (
        worker_name TEXT NOT NULL,
        run_marker TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'failed', 'completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        next_allowed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (worker_name, run_marker)
      )`);
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_scheduled_worker_runs_lookup
          ON scheduled_worker_runs (worker_name, completed_at, next_allowed_at, updated_at DESC)`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensureScheduledWorkerRunsSchemaPromise = null;
        throw error;
      });
  }
  await ensureScheduledWorkerRunsSchemaPromise;
}

async function ensureRecommendationPolicyConfigsSchema(): Promise<void> {
  if (!ensureRecommendationPolicyConfigsSchemaPromise) {
    ensureRecommendationPolicyConfigsSchemaPromise = (async () => {
      await pgQuery(`CREATE TABLE IF NOT EXISTS recommendation_policy_configs (
        id BIGSERIAL PRIMARY KEY,
        app_key TEXT NOT NULL REFERENCES apps(app_key) ON DELETE CASCADE,
        platform TEXT NOT NULL DEFAULT 'unknown',
        engine TEXT NOT NULL CHECK (engine IN ('budget', 'asa')),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        rule_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        manual_prompt_markdown TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (app_key, platform, engine)
      )`);
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_recommendation_policy_configs_lookup
          ON recommendation_policy_configs (engine, enabled, app_key, platform)`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensureRecommendationPolicyConfigsSchemaPromise = null;
        throw error;
      });
  }
  await ensureRecommendationPolicyConfigsSchemaPromise;
}

async function ensureBitableExportConfigSchema(): Promise<void> {
  if (!ensureBitableExportConfigSchemaPromise) {
    ensureBitableExportConfigSchemaPromise = (async () => {
      await pgQuery(`CREATE TABLE IF NOT EXISTS bitable_export_configs (
        id BIGSERIAL PRIMARY KEY,
        source_type TEXT NOT NULL UNIQUE,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        target_table_id TEXT,
        target_table_name TEXT,
        table_name_prefix TEXT NOT NULL DEFAULT '投放执行表',
        chat_id TEXT,
        selected_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        last_synced_at TIMESTAMPTZ,
        last_record_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pgQuery(
        `ALTER TABLE bitable_export_configs
           ADD COLUMN IF NOT EXISTS table_name_prefix TEXT NOT NULL DEFAULT '投放执行表'`
      );
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_bitable_export_configs_lookup
          ON bitable_export_configs (enabled, source_type, updated_at DESC)`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensureBitableExportConfigSchemaPromise = null;
        throw error;
      });
  }
  await ensureBitableExportConfigSchemaPromise;
}

async function ensureBitableExportDailyTablesSchema(): Promise<void> {
  if (!ensureBitableExportDailyTablesSchemaPromise) {
    ensureBitableExportDailyTablesSchemaPromise = (async () => {
      await pgQuery(`CREATE TABLE IF NOT EXISTS bitable_export_daily_tables (
        id BIGSERIAL PRIMARY KEY,
        source_type TEXT NOT NULL,
        report_date DATE NOT NULL,
        table_id TEXT NOT NULL DEFAULT '',
        table_name TEXT NOT NULL DEFAULT '',
        table_name_prefix TEXT NOT NULL DEFAULT '投放执行表',
        last_record_count INTEGER NOT NULL DEFAULT 0,
        last_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (source_type, report_date)
      )`);
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_bitable_export_daily_tables_lookup
          ON bitable_export_daily_tables (source_type, report_date DESC, updated_at DESC)`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensureBitableExportDailyTablesSchemaPromise = null;
        throw error;
      });
  }
  await ensureBitableExportDailyTablesSchemaPromise;
}

async function ensureBitableExportRecordRefsSchema(): Promise<void> {
  if (!ensureBitableExportRecordRefsSchemaPromise) {
    ensureBitableExportRecordRefsSchemaPromise = Promise.all([
      pgQuery(
        `ALTER TABLE bitable_export_record_refs
           ADD COLUMN IF NOT EXISTS is_adopted BOOLEAN NOT NULL DEFAULT FALSE`
      ),
      pgQuery(
        `ALTER TABLE bitable_export_record_refs
           ADD COLUMN IF NOT EXISTS recommendation_type TEXT`
      ),
      pgQuery(
        `ALTER TABLE bitable_export_record_refs
           ADD COLUMN IF NOT EXISTS recommendation_id BIGINT`
      )
    ])
      .then(() => undefined)
      .catch((error) => {
        ensureBitableExportRecordRefsSchemaPromise = null;
        throw error;
      });
  }
  await ensureBitableExportRecordRefsSchemaPromise;
}

async function ensureRecommendationExecutionFeedbacksSchema(): Promise<void> {
  if (!ensureRecommendationExecutionFeedbacksSchemaPromise) {
    ensureRecommendationExecutionFeedbacksSchemaPromise = (async () => {
      await pgQuery(`CREATE TABLE IF NOT EXISTS recommendation_execution_feedbacks (
        id BIGSERIAL PRIMARY KEY,
        source_type TEXT NOT NULL,
        recommendation_type TEXT NOT NULL,
        recommendation_id BIGINT NOT NULL,
        report_date DATE NOT NULL,
        table_id TEXT NOT NULL DEFAULT '',
        record_id TEXT NOT NULL DEFAULT '',
        sync_key TEXT NOT NULL DEFAULT '',
        execution_status TEXT,
        is_adopted BOOLEAN NOT NULL DEFAULT FALSE,
        validation_result TEXT,
        raw_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        bitable_last_modified_time TIMESTAMPTZ,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (source_type, recommendation_type, recommendation_id)
      )`);
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_recommendation_execution_feedbacks_lookup
          ON recommendation_execution_feedbacks (source_type, recommendation_type, report_date DESC, synced_at DESC)`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensureRecommendationExecutionFeedbacksSchemaPromise = null;
        throw error;
      });
  }
  await ensureRecommendationExecutionFeedbacksSchemaPromise;
}

async function ensureFeedbackSkillVersionsSchema(): Promise<void> {
  if (!ensureFeedbackSkillVersionsSchemaPromise) {
    ensureFeedbackSkillVersionsSchemaPromise = (async () => {
      await pgQuery(`CREATE TABLE IF NOT EXISTS feedback_skill_versions (
        id BIGSERIAL PRIMARY KEY,
        scope TEXT NOT NULL,
        source_type TEXT NOT NULL,
        from_date DATE,
        to_date DATE,
        dataset_row_count INTEGER NOT NULL DEFAULT 0,
        stats_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        skills_markdown TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_hash TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pgQuery(
        `CREATE INDEX IF NOT EXISTS idx_feedback_skill_versions_lookup
          ON feedback_skill_versions (scope, source_type, created_at DESC)`
      );
    })()
      .then(() => undefined)
      .catch((error) => {
        ensureFeedbackSkillVersionsSchemaPromise = null;
        throw error;
      });
  }
  await ensureFeedbackSkillVersionsSchemaPromise;
}

export async function ensureRecommendationFeedbackStorage(): Promise<void> {
  await ensureBitableExportRecordRefsSchema();
  await ensureRecommendationExecutionFeedbacksSchema();
  await ensureFeedbackSkillVersionsSchema();
}

export async function getPullContentGuard(
  appKey: string,
  platform: string,
  reportDate: string,
  sourceReport: string
): Promise<PullContentGuardRecord | null> {
  const result = await pgQuery<PullContentGuardRecord>(
    `SELECT app_key, platform, report_date, source_report, content_signature, last_status, last_error,
            attempted_at, next_allowed_at, created_at, updated_at
       FROM pull_content_guards
      WHERE app_key = $1
        AND platform = $2
        AND report_date = $3::date
        AND source_report = $4
      LIMIT 1`,
    [appKey, platform, reportDate, sourceReport]
  );

  return result.rows[0] ?? null;
}

export async function upsertPullContentGuard(input: UpsertPullContentGuardInput): Promise<PullContentGuardRecord> {
  const result = await pgQuery<PullContentGuardRecord>(
    `INSERT INTO pull_content_guards (
      app_key, platform, report_date, source_report, content_signature, last_status, last_error, attempted_at, next_allowed_at
    ) VALUES (
      $1, $2, $3::date, $4, COALESCE($5, ''), $6, NULLIF($7, ''), COALESCE($8::timestamptz, NOW()), $9::timestamptz
    )
    ON CONFLICT (app_key, platform, report_date, source_report) DO UPDATE SET
      content_signature = COALESCE($5, pull_content_guards.content_signature),
      last_status = EXCLUDED.last_status,
      last_error = EXCLUDED.last_error,
      attempted_at = EXCLUDED.attempted_at,
      next_allowed_at = EXCLUDED.next_allowed_at,
      updated_at = NOW()
    RETURNING app_key, platform, report_date, source_report, content_signature, last_status, last_error,
              attempted_at, next_allowed_at, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.report_date,
      input.source_report,
      input.content_signature ?? '',
      input.last_status,
      input.last_error ?? '',
      input.attempted_at ?? null,
      input.next_allowed_at ?? null
    ]
  );

  return result.rows[0];
}

export async function getPullReportReadiness(
  reportDate: string,
  sourceReport: string
): Promise<PullReportReadinessRecord | null> {
  await ensurePullReportReadinessSchema();
  const result = await pgQuery<PullReportReadinessRecord>(
    `SELECT report_date, source_report, status, expected_targets, ok_targets, blocked_targets,
            last_cycle_started_at, last_cycle_finished_at, last_error_summary, updated_at
       FROM pull_report_readiness
      WHERE report_date = $1::date
        AND source_report = $2
      LIMIT 1`,
    [reportDate, sourceReport]
  );

  return result.rows[0] ?? null;
}

export async function getScheduledWorkerRun(
  workerName: string,
  runMarker: string
): Promise<ScheduledWorkerRunRecord | null> {
  await ensureScheduledWorkerRunsSchema();
  const result = await pgQuery<ScheduledWorkerRunRecord>(
    `SELECT worker_name, run_marker, status, attempt_count,
            last_attempt_at::text AS last_attempt_at,
            next_allowed_at::text AS next_allowed_at,
            completed_at::text AS completed_at,
            last_error, created_at, updated_at
       FROM scheduled_worker_runs
      WHERE worker_name = $1
        AND run_marker = $2
      LIMIT 1`,
    [workerName, runMarker]
  );
  return result.rows[0] ?? null;
}

export async function hasCompletedScheduledWorkerRun(workerName: string): Promise<boolean> {
  await ensureScheduledWorkerRunsSchema();
  const result = await pgQuery<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
         FROM scheduled_worker_runs
        WHERE worker_name = $1
          AND completed_at IS NOT NULL
     ) AS exists`,
    [workerName]
  );
  return result.rows[0]?.exists === true;
}

export async function tryStartScheduledWorkerRunAttempt(
  workerName: string,
  runMarker: string,
  maxAttempts: number,
  retryCooldownMs: number
): Promise<ScheduledWorkerRunRecord | null> {
  await ensureScheduledWorkerRunsSchema();
  const result = await pgQuery<ScheduledWorkerRunRecord>(
    `WITH claimed AS (
       INSERT INTO scheduled_worker_runs (
         worker_name, run_marker, status, attempt_count, last_attempt_at, next_allowed_at, completed_at, last_error
       ) VALUES (
         $1, $2, 'running', 1, NOW(), NOW() + ($3 * INTERVAL '1 millisecond'), NULL, NULL
       )
       ON CONFLICT (worker_name, run_marker) DO UPDATE SET
         status = 'running',
         attempt_count = scheduled_worker_runs.attempt_count + 1,
         last_attempt_at = NOW(),
         next_allowed_at = NOW() + ($3 * INTERVAL '1 millisecond'),
         last_error = NULL,
         updated_at = NOW()
       WHERE scheduled_worker_runs.completed_at IS NULL
         AND scheduled_worker_runs.attempt_count < $4
         AND (scheduled_worker_runs.next_allowed_at IS NULL OR scheduled_worker_runs.next_allowed_at <= NOW())
       RETURNING worker_name, run_marker, status, attempt_count,
                 last_attempt_at::text AS last_attempt_at,
                 next_allowed_at::text AS next_allowed_at,
                 completed_at::text AS completed_at,
                 last_error, created_at, updated_at
     )
     SELECT worker_name, run_marker, status, attempt_count, last_attempt_at, next_allowed_at, completed_at, last_error, created_at, updated_at
       FROM claimed`,
    [workerName, runMarker, Math.max(1000, Math.floor(retryCooldownMs)), Math.max(1, Math.floor(maxAttempts))]
  );
  return result.rows[0] ?? null;
}

export async function markScheduledWorkerRunCompleted(workerName: string, runMarker: string): Promise<void> {
  await ensureScheduledWorkerRunsSchema();
  await pgQuery(
    `UPDATE scheduled_worker_runs
        SET status = 'completed',
            completed_at = NOW(),
            next_allowed_at = NULL,
            last_error = NULL,
            updated_at = NOW()
      WHERE worker_name = $1
        AND run_marker = $2`,
    [workerName, runMarker]
  );
}

export async function markScheduledWorkerRunFailed(
  workerName: string,
  runMarker: string,
  lastError?: string | null
): Promise<void> {
  await ensureScheduledWorkerRunsSchema();
  await pgQuery(
    `UPDATE scheduled_worker_runs
        SET status = 'failed',
            last_error = NULLIF($3, ''),
            updated_at = NOW()
      WHERE worker_name = $1
        AND run_marker = $2`,
    [workerName, runMarker, lastError ?? '']
  );
}

export async function upsertPullReportReadiness(
  input: UpsertPullReportReadinessInput
): Promise<PullReportReadinessRecord> {
  await ensurePullReportReadinessSchema();
  const result = await pgQuery<PullReportReadinessRecord>(
    `INSERT INTO pull_report_readiness (
      report_date,
      source_report,
      status,
      expected_targets,
      ok_targets,
      blocked_targets,
      last_cycle_started_at,
      last_cycle_finished_at,
      last_error_summary,
      updated_at
    ) VALUES (
      $1::date,
      $2,
      $3,
      GREATEST(0, $4::int),
      GREATEST(0, $5::int),
      GREATEST(0, $6::int),
      $7::timestamptz,
      $8::timestamptz,
      NULLIF($9, ''),
      NOW()
    )
    ON CONFLICT (report_date, source_report) DO UPDATE SET
      status = EXCLUDED.status,
      expected_targets = EXCLUDED.expected_targets,
      ok_targets = EXCLUDED.ok_targets,
      blocked_targets = EXCLUDED.blocked_targets,
      last_cycle_started_at = EXCLUDED.last_cycle_started_at,
      last_cycle_finished_at = EXCLUDED.last_cycle_finished_at,
      last_error_summary = EXCLUDED.last_error_summary,
      updated_at = NOW()
    RETURNING report_date, source_report, status, expected_targets, ok_targets, blocked_targets,
              last_cycle_started_at, last_cycle_finished_at, last_error_summary, updated_at`,
    [
      input.report_date,
      input.source_report,
      input.status,
      input.expected_targets,
      input.ok_targets,
      input.blocked_targets,
      input.last_cycle_started_at ?? null,
      input.last_cycle_finished_at ?? null,
      input.last_error_summary ?? ''
    ]
  );

  return result.rows[0];
}

export async function listApps(): Promise<AppConfigRecord[]> {
  const result = await pgQuery<AppConfigRecord>(
    `SELECT id, app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
            notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id, created_at, updated_at
       FROM apps
      ORDER BY app_key ASC`
  );
  return result.rows;
}

export async function getAppByKey(appKey: string): Promise<AppConfigRecord | null> {
  const result = await pgQuery<AppConfigRecord>(
    `SELECT id, app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
            notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id, created_at, updated_at
       FROM apps
      WHERE app_key = $1
      LIMIT 1`,
    [appKey]
  );
  return result.rows[0] ?? null;
}

export async function getAppByKeyAndDataset(appKey: string, dataset: string): Promise<AppConfigRecord | null> {
  const result = await pgQuery<AppConfigRecord>(
    `SELECT id, app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
            notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id, created_at, updated_at
       FROM apps
      WHERE app_key = $1 AND dataset = $2
      LIMIT 1`,
    [appKey, dataset]
  );
  return result.rows[0] ?? null;
}

export async function upsertAppConfig(input: UpsertAppInput): Promise<AppConfigRecord> {
  const result = await pgQuery<AppConfigRecord>(
    `INSERT INTO apps (
      app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
      notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id
    ) VALUES (
      $1,
      COALESCE(NULLIF($2, ''), replace($1, '-', ' ')),
      COALESCE(NULLIF($3, ''), ''),
      COALESCE(NULLIF($4, ''), ''),
      $5, COALESCE(NULLIF($6, ''), ''), COALESCE(NULLIF($7, ''), ''),
      $8, COALESCE(NULLIF($9, ''), md5(random()::text || clock_timestamp()::text)),
      $10, NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, '')
    )
    ON CONFLICT (app_key) DO UPDATE SET
      display_name = COALESCE(NULLIF($2, ''), replace(apps.app_key, '-', ' ')),
      ios_display_name = COALESCE(NULLIF($3, ''), apps.ios_display_name),
      android_display_name = COALESCE(NULLIF($4, ''), apps.android_display_name),
      pull_app_id = EXCLUDED.pull_app_id,
      ios_pull_app_id = COALESCE(NULLIF($6, ''), apps.ios_pull_app_id),
      android_pull_app_id = COALESCE(NULLIF($7, ''), apps.android_pull_app_id),
      dataset = EXCLUDED.dataset,
      push_auth_token = CASE
        WHEN NULLIF($9, '') IS NULL THEN apps.push_auth_token
        ELSE NULLIF($9, '')
      END,
      timezone = EXCLUDED.timezone,
      notify_webhook_url = NULLIF($11, ''),
      notify_feishu_app_id = NULLIF($12, ''),
      notify_feishu_app_secret = CASE
        WHEN $15::boolean IS TRUE THEN NULLIF($13, '')
        ELSE apps.notify_feishu_app_secret
      END,
      notify_feishu_chat_id = NULLIF($14, ''),
      updated_at = NOW()
    RETURNING id, app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
              notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id, created_at, updated_at`,
    [
      input.app_key,
      input.display_name ?? '',
      input.ios_display_name ?? '',
      input.android_display_name ?? '',
      input.pull_app_id,
      input.ios_pull_app_id ?? '',
      input.android_pull_app_id ?? '',
      input.dataset,
      input.push_auth_token ?? '',
      input.timezone,
      input.notify_webhook_url ?? '',
      input.notify_feishu_app_id ?? '',
      input.notify_feishu_app_secret ?? '',
      input.notify_feishu_chat_id ?? '',
      input.replace_notify_feishu_app_secret === true
    ]
  );

  return result.rows[0];
}

export async function listRules(appKey?: string): Promise<RuleRecord[]> {
  const values: unknown[] = [];
  let where = '';
  if (appKey) {
    values.push(appKey);
    where = 'WHERE app_key = $1';
  }

  const result = await pgQuery<RuleRecord>(
    `SELECT id, app_key, name, enabled, rule_json, created_at, updated_at
       FROM rules
       ${where}
      ORDER BY updated_at DESC`,
    values
  );
  return result.rows;
}

export async function listEnabledRulesWithApp(): Promise<AppRuleRecord[]> {
  const result = await pgQuery<AppRuleRecord>(
    `SELECT r.id, r.app_key, r.name, r.enabled, r.rule_json, r.created_at, r.updated_at,
            a.ios_pull_app_id, a.android_pull_app_id, a.timezone,
            a.notify_webhook_url, a.notify_feishu_app_id, a.notify_feishu_app_secret, a.notify_feishu_chat_id
       FROM rules r
       JOIN apps a ON a.app_key = r.app_key
      WHERE r.enabled = true`
  );

  return result.rows;
}

export interface UpsertRuleInput {
  id?: number;
  app_key: string;
  name: string;
  enabled?: boolean;
  rule_json: Record<string, unknown>;
}

export async function upsertRule(input: UpsertRuleInput): Promise<RuleRecord> {
  if (input.id) {
    const result = await pgQuery<RuleRecord>(
      `UPDATE rules
          SET app_key = $1,
              name = $2,
              enabled = COALESCE($3, enabled),
              rule_json = $4,
              updated_at = NOW()
        WHERE id = $5
      RETURNING id, app_key, name, enabled, rule_json, created_at, updated_at`,
      [input.app_key, input.name, input.enabled ?? null, input.rule_json, input.id]
    );
    if (!result.rows[0]) {
      throw new Error(`Rule id ${input.id} not found`);
    }
    return result.rows[0];
  }

  const result = await pgQuery<RuleRecord>(
    `INSERT INTO rules (app_key, name, enabled, rule_json)
     VALUES ($1, $2, COALESCE($3, true), $4)
     RETURNING id, app_key, name, enabled, rule_json, created_at, updated_at`,
    [input.app_key, input.name, input.enabled ?? true, input.rule_json]
  );

  return result.rows[0];
}

export async function setRuleEnabled(id: number, enabled: boolean): Promise<RuleRecord | null> {
  const result = await pgQuery<RuleRecord>(
    `UPDATE rules
        SET enabled = $1,
            updated_at = NOW()
      WHERE id = $2
    RETURNING id, app_key, name, enabled, rule_json, created_at, updated_at`,
    [enabled, id]
  );

  return result.rows[0] ?? null;
}

export async function listAlerts(filters: AlertsFilter): Promise<AlertRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filters.appKey) {
    values.push(filters.appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (filters.platform) {
    values.push(filters.platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    clauses.push(`severity = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    clauses.push(`created_at >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    clauses.push(`created_at <= $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(filters.limit ?? 200);

  const result = await pgQuery<AlertRecord>(
    `SELECT id, app_key, platform, rule_id, severity, status, metric, "window", current_value, baseline_value,
            delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
            updated_at, resolved_at
       FROM alerts
       ${where}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
    values
  );

  return result.rows;
}

export async function getAlertById(id: number): Promise<AlertRecord | null> {
  const result = await pgQuery<AlertRecord>(
    `SELECT id, app_key, platform, rule_id, severity, status, metric, "window", current_value, baseline_value,
            delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
            updated_at, resolved_at
       FROM alerts
      WHERE id = $1`,
    [id]
  );

  return result.rows[0] ?? null;
}

export interface CreateAlertInput {
  app_key: string;
  platform: string;
  rule_id: number | null;
  severity: 'P0' | 'P1' | 'P2';
  status: 'open' | 'resolved';
  metric: string;
  window: string;
  current_value: number;
  baseline_value: number;
  delta_value: number;
  delta_ratio: number;
  top_contributors: unknown;
  explanation: string;
  fingerprint: string;
}

export async function createAlert(input: CreateAlertInput): Promise<AlertRecord> {
  const result = await pgQuery<AlertRecord>(
    `INSERT INTO alerts (
      app_key, platform, rule_id, severity, status, metric, "window", current_value, baseline_value,
      delta_value, delta_ratio, top_contributors, explanation, fingerprint
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14
    )
    ON CONFLICT (fingerprint) WHERE status = 'open' DO UPDATE SET
      updated_at = NOW(),
      current_value = EXCLUDED.current_value,
      baseline_value = EXCLUDED.baseline_value,
      delta_value = EXCLUDED.delta_value,
      delta_ratio = EXCLUDED.delta_ratio,
      top_contributors = EXCLUDED.top_contributors,
      explanation = EXCLUDED.explanation
    RETURNING id, app_key, platform, rule_id, severity, status, metric, "window", current_value, baseline_value,
              delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
              updated_at, resolved_at`,
    [
      input.app_key,
      input.platform,
      input.rule_id,
      input.severity,
      input.status,
      input.metric,
      input.window,
      input.current_value,
      input.baseline_value,
      input.delta_value,
      input.delta_ratio,
      JSON.stringify(input.top_contributors),
      input.explanation,
      input.fingerprint
    ]
  );
  return result.rows[0];
}

export async function findRecentOpenAlertByFingerprint(
  fingerprint: string,
  silenceMinutes: number
): Promise<AlertRecord | null> {
  const result = await pgQuery<AlertRecord>(
    `SELECT id, app_key, platform, rule_id, severity, status, metric, "window", current_value, baseline_value,
            delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
            updated_at, resolved_at
       FROM alerts
      WHERE fingerprint = $1
        AND status = 'open'
        AND created_at >= NOW() - ($2::text || ' minutes')::interval
      ORDER BY created_at DESC
      LIMIT 1`,
    [fingerprint, silenceMinutes]
  );

  return result.rows[0] ?? null;
}

export async function resolveOpenAlertsByRuleMetric(
  appKey: string,
  platform: string,
  ruleId: number,
  metric: string,
  window: string
): Promise<number> {
  const result = await pgQuery<{ id: number }>(
    `UPDATE alerts
        SET status = 'resolved',
            updated_at = NOW(),
            resolved_at = NOW()
      WHERE app_key = $1
        AND platform = $2
        AND rule_id = $3
        AND metric = $4
        AND "window" = $5
        AND status = 'open'
      RETURNING id`,
    [appKey, platform, ruleId, metric, window]
  );

  return result.rowCount ?? 0;
}

export async function listOpenAlertsByRuleMetric(
  appKey: string,
  platform: string,
  ruleId: number,
  metric: string,
  window: string
): Promise<AlertRecord[]> {
  const result = await pgQuery<AlertRecord>(
    `SELECT id, app_key, platform, rule_id, severity, status, metric, "window", current_value, baseline_value,
            delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
            updated_at, resolved_at
       FROM alerts
      WHERE app_key = $1
        AND platform = $2
        AND rule_id = $3
        AND metric = $4
        AND "window" = $5
        AND status = 'open'`,
    [appKey, platform, ruleId, metric, window]
  );

  return result.rows;
}

export async function listKeywordExtractRules(appKey?: string): Promise<KeywordExtractRuleRecord[]> {
  const values: unknown[] = [];
  const where = appKey ? 'WHERE app_key = $1' : '';
  if (appKey) {
    values.push(appKey);
  }
  const result = await pgQuery<KeywordExtractRuleRecord>(
    `SELECT id, app_key, priority, regex_pattern, keyword_group_index, match_type_group_index,
            enabled, created_at, updated_at
       FROM keyword_extract_rules
       ${where}
      ORDER BY app_key ASC, priority ASC, id ASC`,
    values
  );
  return result.rows;
}

export async function listKeywordLifecycleStatesByApp(appKey: string): Promise<KeywordLifecycleStateRow[]> {
  return listKeywordLifecycleStatesByAppPlatform(appKey);
}

export async function listKeywordLifecycleStatesByAppPlatform(
  appKey: string,
  platform?: string
): Promise<KeywordLifecycleStateRow[]> {
  const values: unknown[] = [appKey];
  const platformFilter = platform ? `AND platform = $2` : '';
  if (platform) {
    values.push(platform);
  }
  const result = await pgQuery<KeywordLifecycleStateRow>(
    `SELECT id, app_key, platform, keyword, match_type, current_stage, stage_score, first_seen_date, last_seen_date,
            days_in_stage, last_cpi, last_installs, last_clicks, trend_json, created_at, updated_at
       FROM keyword_lifecycle_states
      WHERE app_key = $1
        ${platformFilter}
      ORDER BY updated_at DESC`,
    values
  );
  return result.rows;
}

export interface KeywordLifecycleFilter {
  appKey?: string;
  platform?: string;
  stage?: string;
  keyword?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function queryKeywordLifecycleStates(
  filter: KeywordLifecycleFilter
): Promise<PagedResult<KeywordLifecycleStateRow>> {
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));
  const page = Math.max(1, filter.page ?? 1);
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.appKey) {
    values.push(filter.appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (filter.platform) {
    values.push(filter.platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (filter.stage) {
    values.push(filter.stage);
    clauses.push(`current_stage = $${values.length}`);
  }
  if (filter.keyword) {
    values.push(`%${filter.keyword}%`);
    clauses.push(`keyword ILIKE $${values.length}`);
  }
  if (filter.from) {
    values.push(filter.from);
    clauses.push(`last_seen_date >= $${values.length}::date`);
  }
  if (filter.to) {
    values.push(filter.to);
    clauses.push(`last_seen_date <= $${values.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countResult = await pgQuery<{ total: string }>(
    `SELECT to_char(count(*), 'FM999999999999999') AS total
       FROM keyword_lifecycle_states
      ${where}`,
    values
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const listValues = [...values, pageSize, offset];
  const rowsResult = await pgQuery<KeywordLifecycleStateRow>(
    `SELECT id, app_key, platform, keyword, match_type, current_stage, stage_score, first_seen_date, last_seen_date,
            days_in_stage, last_cpi, last_installs, last_clicks, trend_json, created_at, updated_at
       FROM keyword_lifecycle_states
       ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}`,
    listValues
  );

  return {
    rows: rowsResult.rows,
    total,
    page: safePage,
    pageSize,
    totalPages
  };
}

export interface UpsertKeywordLifecycleInput {
  app_key: string;
  platform: string;
  keyword: string;
  match_type: string;
  current_stage: string;
  stage_score: number;
  first_seen_date: string;
  last_seen_date: string;
  days_in_stage: number;
  last_cpi: number;
  last_installs: number;
  last_clicks: number;
  trend_json: unknown;
}

export async function upsertKeywordLifecycleState(
  input: UpsertKeywordLifecycleInput
): Promise<KeywordLifecycleStateRow> {
  const stageScore = Number(input.stage_score);
  const daysInStage = Number(input.days_in_stage);
  const lastCpi = Number(input.last_cpi);
  const lastInstalls = Number(input.last_installs);
  const lastClicks = Number(input.last_clicks);

  const result = await pgQuery<KeywordLifecycleStateRow>(
    `INSERT INTO keyword_lifecycle_states (
      app_key, platform, keyword, match_type, current_stage, stage_score, first_seen_date, last_seen_date,
      days_in_stage, last_cpi, last_installs, last_clicks, trend_json
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::date, $8::date,
      $9, $10, $11, $12, $13
    )
    ON CONFLICT (app_key, platform, keyword, match_type) DO UPDATE SET
      current_stage = EXCLUDED.current_stage,
      stage_score = EXCLUDED.stage_score,
      first_seen_date = LEAST(keyword_lifecycle_states.first_seen_date, EXCLUDED.first_seen_date),
      last_seen_date = EXCLUDED.last_seen_date,
      days_in_stage = EXCLUDED.days_in_stage,
      last_cpi = EXCLUDED.last_cpi,
      last_installs = EXCLUDED.last_installs,
      last_clicks = EXCLUDED.last_clicks,
      trend_json = EXCLUDED.trend_json,
      updated_at = NOW()
    RETURNING id, app_key, platform, keyword, match_type, current_stage, stage_score, first_seen_date, last_seen_date,
              days_in_stage, last_cpi, last_installs, last_clicks, trend_json, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.keyword,
      input.match_type,
      input.current_stage,
      Number.isFinite(stageScore) ? stageScore : 0,
      input.first_seen_date,
      input.last_seen_date,
      Number.isFinite(daysInStage) ? Math.max(1, Math.floor(daysInStage)) : 1,
      Number.isFinite(lastCpi) ? lastCpi : 0,
      Number.isFinite(lastInstalls) ? lastInstalls : 0,
      Number.isFinite(lastClicks) ? lastClicks : 0,
      JSON.stringify(input.trend_json ?? {})
    ]
  );
  return result.rows[0];
}

export interface BudgetRecommendationFilter {
  appKey?: string;
  platform?: string;
  status?: BudgetRecommendationStatus;
  from?: string;
  to?: string;
  executionStatus?: string;
  isAdopted?: boolean;
  hasManualReview?: boolean;
  page?: number;
  pageSize?: number;
}

export interface UpsertBudgetRecommendationInput {
  app_key: string;
  platform: string;
  media_source: string;
  keyword: string;
  match_type: string;
  date: string;
  action: 'increase' | 'decrease' | 'hold' | 'pause';
  change_ratio: number;
  suggested_budget: number;
  current_cost: number;
  current_ecpi: number;
  target_ecpi: number;
  primary_metric: 'ecpi' | 'roas';
  metric_mode: 'active' | 'roas_pending_revenue';
  current_roas?: number | null;
  af_cohort_roas?: number | null;
  local_derived_roas?: number | null;
  roas_primary_source?: RoasPrimarySource;
  roas_warning_code?: RoasWarningCode;
  roas_deviation_ratio?: number | null;
  target_roas?: number | null;
  roas_window_from?: string | null;
  roas_window_to?: string | null;
  roas_data_status?: RoasDataStatus;
  volume_tier: string;
  expected_installs_delta: number;
  confidence: number;
  reason_code: string;
  llm_summary: unknown;
  execution_actions: BudgetExecutionAction[];
  scenario_tags: string[];
  status?: BudgetRecommendationStatus;
}

export async function upsertBudgetRecommendation(
  input: UpsertBudgetRecommendationInput
): Promise<BudgetRecommendationRow> {
  await ensureBudgetRecommendationsSchema();
  const result = await pgQuery<BudgetRecommendationRow>(
    `INSERT INTO budget_recommendations (
      app_key, platform, media_source, keyword, match_type, date, action, change_ratio, suggested_budget, current_cost,
      current_ecpi, target_ecpi, primary_metric, metric_mode, current_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, target_roas, roas_window_from, roas_window_to, roas_data_status,
      volume_tier, expected_installs_delta, confidence, reason_code, llm_summary, execution_actions, scenario_tags, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::date, $23::date, $24,
      $25, $26, $27, $28, $29, $30, $31, COALESCE($32, 'pending')
    )
    ON CONFLICT (app_key, platform, media_source, keyword, match_type, date) DO UPDATE SET
      action = EXCLUDED.action,
      change_ratio = EXCLUDED.change_ratio,
      suggested_budget = EXCLUDED.suggested_budget,
      current_cost = EXCLUDED.current_cost,
      current_ecpi = EXCLUDED.current_ecpi,
      target_ecpi = EXCLUDED.target_ecpi,
      primary_metric = EXCLUDED.primary_metric,
      metric_mode = EXCLUDED.metric_mode,
      current_roas = EXCLUDED.current_roas,
      af_cohort_roas = EXCLUDED.af_cohort_roas,
      local_derived_roas = EXCLUDED.local_derived_roas,
      roas_primary_source = EXCLUDED.roas_primary_source,
      roas_warning_code = EXCLUDED.roas_warning_code,
      roas_deviation_ratio = EXCLUDED.roas_deviation_ratio,
      target_roas = EXCLUDED.target_roas,
      roas_window_from = EXCLUDED.roas_window_from,
      roas_window_to = EXCLUDED.roas_window_to,
      roas_data_status = EXCLUDED.roas_data_status,
      volume_tier = EXCLUDED.volume_tier,
      expected_installs_delta = EXCLUDED.expected_installs_delta,
      confidence = EXCLUDED.confidence,
      reason_code = EXCLUDED.reason_code,
      llm_summary = EXCLUDED.llm_summary,
      execution_actions = EXCLUDED.execution_actions,
      scenario_tags = EXCLUDED.scenario_tags,
      status = CASE
        WHEN budget_recommendations.status IN ('applied', 'rejected') THEN budget_recommendations.status
        ELSE EXCLUDED.status
      END,
      updated_at = NOW()
    RETURNING id, app_key, platform, media_source, keyword, match_type, date, action, change_ratio, suggested_budget, current_cost,
              current_ecpi, target_ecpi, primary_metric, metric_mode, current_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, target_roas, roas_window_from, roas_window_to, roas_data_status, volume_tier,
              expected_installs_delta, confidence, reason_code, llm_summary, execution_actions, scenario_tags, status,
              NULL::text AS execution_status, FALSE AS is_adopted, NULL::text AS validation_result,
              NULL::text AS feedback_synced_at, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.media_source,
      input.keyword,
      input.match_type,
      input.date,
      input.action,
      input.change_ratio,
      input.suggested_budget,
      input.current_cost,
      input.current_ecpi,
      input.target_ecpi,
      input.primary_metric,
      input.metric_mode,
      input.current_roas ?? null,
      input.af_cohort_roas ?? null,
      input.local_derived_roas ?? null,
      input.roas_primary_source ?? 'local_fallback',
      input.roas_warning_code ?? 'none',
      input.roas_deviation_ratio ?? null,
      input.target_roas ?? null,
      input.roas_window_from ?? null,
      input.roas_window_to ?? null,
      input.roas_data_status ?? 'unavailable',
      input.volume_tier,
      input.expected_installs_delta,
      input.confidence,
      input.reason_code,
      JSON.stringify(input.llm_summary ?? {}),
      JSON.stringify(input.execution_actions ?? []),
      JSON.stringify(input.scenario_tags ?? []),
      input.status ?? 'pending'
    ]
  );
  return result.rows[0];
}

export async function queryBudgetRecommendations(
  filter: BudgetRecommendationFilter
): Promise<PagedResult<BudgetRecommendationRow>> {
  await Promise.all([ensureRecommendationExecutionFeedbacksSchema(), ensureBudgetRecommendationsSchema()]);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));
  const page = Math.max(1, filter.page ?? 1);
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.appKey) {
    values.push(filter.appKey);
    clauses.push(`br.app_key = $${values.length}`);
  }
  if (filter.platform) {
    values.push(filter.platform);
    clauses.push(`br.platform = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    clauses.push(`br.status = $${values.length}`);
  }
  if (filter.from) {
    values.push(filter.from);
    clauses.push(`br.date >= $${values.length}::date`);
  }
  if (filter.to) {
    values.push(filter.to);
    clauses.push(`br.date <= $${values.length}::date`);
  }
  if (filter.executionStatus) {
    values.push(filter.executionStatus);
    clauses.push(`COALESCE(ref.execution_status, '') = $${values.length}`);
  }
  if (typeof filter.isAdopted === 'boolean') {
    values.push(filter.isAdopted);
    clauses.push(`COALESCE(ref.is_adopted, FALSE) = $${values.length}`);
  }
  if (typeof filter.hasManualReview === 'boolean') {
    clauses.push(
      filter.hasManualReview
        ? `NULLIF(BTRIM(COALESCE(ref.validation_result, '')), '') IS NOT NULL`
        : `NULLIF(BTRIM(COALESCE(ref.validation_result, '')), '') IS NULL`
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const feedbackJoin = `LEFT JOIN recommendation_execution_feedbacks ref
       ON ref.source_type = 'delivery_actions'
      AND ref.recommendation_type = 'budget'
      AND ref.recommendation_id = br.id`;

  const countResult = await pgQuery<{ total: string }>(
    `SELECT to_char(count(*), 'FM999999999999999') AS total
       FROM budget_recommendations br
       ${feedbackJoin}
      ${where}`,
    values
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const listValues = [...values, pageSize, offset];

  const rowsResult = await pgQuery<BudgetRecommendationRow>(
    `SELECT br.id, br.app_key, br.platform, br.media_source, br.keyword, br.match_type, br.date, br.action, br.change_ratio,
            br.suggested_budget, br.current_cost, br.current_ecpi, br.target_ecpi, br.primary_metric, br.metric_mode,
            br.current_roas, br.af_cohort_roas, br.local_derived_roas, br.roas_primary_source, br.roas_warning_code, br.roas_deviation_ratio,
            br.target_roas, br.roas_window_from, br.roas_window_to, br.roas_data_status, br.volume_tier, br.expected_installs_delta, br.confidence, br.reason_code,
            br.llm_summary, br.execution_actions, br.scenario_tags, br.status,
            ref.execution_status,
            COALESCE(ref.is_adopted, FALSE) AS is_adopted,
            ref.validation_result,
            ref.synced_at::text AS feedback_synced_at,
            br.created_at, br.updated_at
       FROM budget_recommendations br
       ${feedbackJoin}
       ${where}
      ORDER BY br.date DESC, br.updated_at DESC, br.id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}`,
    listValues
  );

  return {
    rows: rowsResult.rows,
    total,
    page: safePage,
    pageSize,
    totalPages
  };
}

export async function setBudgetRecommendationStatus(
  id: number,
  status: BudgetRecommendationStatus
): Promise<BudgetRecommendationRow | null> {
  await ensureBudgetRecommendationsSchema();
  const result = await pgQuery<BudgetRecommendationRow>(
    `UPDATE budget_recommendations
        SET status = $1,
            updated_at = NOW()
      WHERE id = $2
      RETURNING id, app_key, platform, media_source, keyword, match_type, date, action, change_ratio, suggested_budget, current_cost,
                current_ecpi, target_ecpi, primary_metric, metric_mode, current_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, target_roas, roas_window_from, roas_window_to, roas_data_status, volume_tier,
                expected_installs_delta, confidence, reason_code, llm_summary, execution_actions, scenario_tags, status,
                NULL::text AS execution_status, FALSE AS is_adopted, NULL::text AS validation_result,
                NULL::text AS feedback_synced_at, created_at, updated_at`,
    [status, id]
  );
  return result.rows[0] ?? null;
}

export async function expirePendingBudgetRecommendationsForDate(appKey: string, date: string): Promise<void> {
  await pgQuery(
    `UPDATE budget_recommendations
        SET status = 'expired',
            updated_at = NOW()
      WHERE app_key = $1
        AND date = $2::date
        AND status = 'pending'`,
    [appKey, date]
  );
}

export interface LlmAuditLogInput {
  biz_type: string;
  biz_id: string;
  model: string;
  prompt_hash: string;
  response_json: unknown;
  latency_ms: number;
  success: boolean;
}

export async function insertLlmAuditLog(input: LlmAuditLogInput): Promise<void> {
  await pgQuery(
    `INSERT INTO llm_audit_logs (
      biz_type, biz_id, model, prompt_hash, response_json, latency_ms, success
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.biz_type,
      input.biz_id,
      input.model,
      input.prompt_hash,
      JSON.stringify(input.response_json ?? {}),
      input.latency_ms,
      input.success
    ]
  );
}

export async function getDailyBriefDispatch(
  reportDate: string,
  kind = 'ops_daily',
  channel = 'feishu',
  routeKey = 'all'
): Promise<DailyBriefDispatchRecord | null> {
  const result = await pgQuery<DailyBriefDispatchRecord>(
    `SELECT id, report_date, kind, channel, route_key, title, content, payload_json, status, manual_triggered,
            last_error, sent_at, created_at, updated_at
       FROM daily_brief_dispatches
      WHERE report_date = $1::date
        AND kind = $2
        AND channel = $3
        AND route_key = $4
      LIMIT 1`,
    [reportDate, kind, channel, routeKey]
  );
  return result.rows[0] ?? null;
}

export interface UpsertDailyBriefDispatchInput {
  report_date: string;
  kind?: string;
  channel?: string;
  route_key?: string;
  title: string;
  content: string;
  payload_json: unknown;
  status: 'sent' | 'failed';
  manual_triggered?: boolean;
  last_error?: string | null;
  sent_at?: string | null;
}

export async function upsertDailyBriefDispatch(
  input: UpsertDailyBriefDispatchInput
): Promise<DailyBriefDispatchRecord> {
  const result = await pgQuery<DailyBriefDispatchRecord>(
    `INSERT INTO daily_brief_dispatches (
      report_date, kind, channel, route_key, title, content, payload_json, status, manual_triggered, last_error, sent_at
    ) VALUES (
      $1::date, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, false), NULLIF($10, ''), $11::timestamptz
    )
    ON CONFLICT (report_date, kind, channel, route_key) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      payload_json = EXCLUDED.payload_json,
      status = EXCLUDED.status,
      manual_triggered = daily_brief_dispatches.manual_triggered OR EXCLUDED.manual_triggered,
      last_error = EXCLUDED.last_error,
      sent_at = EXCLUDED.sent_at,
      updated_at = NOW()
    RETURNING id, report_date, kind, channel, route_key, title, content, payload_json, status, manual_triggered,
              last_error, sent_at, created_at, updated_at`,
    [
      input.report_date,
      input.kind ?? 'ops_daily',
      input.channel ?? 'feishu',
      input.route_key ?? 'all',
      input.title,
      input.content,
      JSON.stringify(input.payload_json ?? {}),
      input.status,
      input.manual_triggered ?? false,
      input.last_error ?? '',
      input.sent_at ?? null
    ]
  );
  return result.rows[0];
}

export interface UpsertDailyBriefRouteInput {
  enabled?: boolean;
  route_name: string;
  media_sources: string[];
  app_key?: string | null;
  platform?: string | null;
  notify_feishu_app_id?: string | null;
  notify_feishu_app_secret?: string | null;
  notify_feishu_chat_id?: string | null;
  priority?: number;
}

export async function listEnabledDailyBriefRoutes(): Promise<DailyBriefRouteRecord[]> {
  const result = await pgQuery<DailyBriefRouteRecord>(
    `SELECT id, enabled, route_name, media_sources, app_key, platform,
            notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id,
            priority, created_at, updated_at
       FROM daily_brief_routes
      WHERE enabled = TRUE
      ORDER BY priority ASC, id ASC`
  );
  return result.rows.map((row) => ({
    ...row,
    media_sources: Array.isArray(row.media_sources) ? row.media_sources.map((item) => String(item)) : []
  }));
}

function normalizeSelectedFields(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => String(item || '').trim()).filter(Boolean);
}

export async function listBitableExportConfigs(): Promise<BitableExportConfigRecord[]> {
  await ensureBitableExportConfigSchema();
  const result = await pgQuery<BitableExportConfigRecord>(
    `SELECT id, source_type, enabled, target_table_id, target_table_name, table_name_prefix, chat_id, selected_fields,
            last_status, last_error, last_synced_at, last_record_count, created_at, updated_at
       FROM bitable_export_configs
      ORDER BY source_type ASC`
  );
  return result.rows.map((row) => ({
    ...row,
    selected_fields: normalizeSelectedFields(row.selected_fields)
  }));
}

export async function getBitableExportConfig(
  sourceType: BitableExportSourceType
): Promise<BitableExportConfigRecord | null> {
  await ensureBitableExportConfigSchema();
  const result = await pgQuery<BitableExportConfigRecord>(
    `SELECT id, source_type, enabled, target_table_id, target_table_name, table_name_prefix, chat_id, selected_fields,
            last_status, last_error, last_synced_at, last_record_count, created_at, updated_at
       FROM bitable_export_configs
      WHERE source_type = $1
      LIMIT 1`,
    [sourceType]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    ...row,
    selected_fields: normalizeSelectedFields(row.selected_fields)
  };
}

export async function upsertBitableExportConfig(input: {
  source_type: BitableExportSourceType;
  enabled?: boolean;
  target_table_id?: string | null;
  target_table_name?: string | null;
  table_name_prefix?: string | null;
  chat_id?: string | null;
  selected_fields?: string[];
}): Promise<BitableExportConfigRecord> {
  await ensureBitableExportConfigSchema();
  const result = await pgQuery<BitableExportConfigRecord>(
    `INSERT INTO bitable_export_configs (
      source_type, enabled, target_table_id, target_table_name, table_name_prefix, chat_id, selected_fields
    ) VALUES (
      $1, COALESCE($2, false), NULLIF($3, ''), NULLIF($4, ''), COALESCE(NULLIF($5, ''), '投放执行表'), NULLIF($6, ''), $7
    )
    ON CONFLICT (source_type) DO UPDATE SET
      enabled = COALESCE($2, bitable_export_configs.enabled),
      target_table_id = COALESCE(NULLIF($3, ''), bitable_export_configs.target_table_id),
      target_table_name = COALESCE(NULLIF($4, ''), bitable_export_configs.target_table_name),
      table_name_prefix = COALESCE(NULLIF($5, ''), bitable_export_configs.table_name_prefix),
      chat_id = CASE
        WHEN $6 IS NULL THEN bitable_export_configs.chat_id
        ELSE NULLIF($6, '')
      END,
      selected_fields = CASE
        WHEN $7::jsonb = '[]'::jsonb AND COALESCE(jsonb_array_length(bitable_export_configs.selected_fields), 0) > 0
          THEN bitable_export_configs.selected_fields
        ELSE $7::jsonb
      END,
      updated_at = NOW()
    RETURNING id, source_type, enabled, target_table_id, target_table_name, table_name_prefix, chat_id, selected_fields,
              last_status, last_error, last_synced_at, last_record_count, created_at, updated_at`,
    [
      input.source_type,
      typeof input.enabled === 'boolean' ? input.enabled : null,
      input.target_table_id ?? '',
      input.target_table_name ?? '',
      input.table_name_prefix ?? '',
      input.chat_id === undefined ? null : input.chat_id,
      JSON.stringify(input.selected_fields ?? [])
    ]
  );
  return {
    ...result.rows[0],
    selected_fields: normalizeSelectedFields(result.rows[0]?.selected_fields)
  };
}

export async function updateBitableExportSyncResult(input: {
  source_type: BitableExportSourceType;
  target_table_id?: string | null;
  target_table_name?: string | null;
  table_name_prefix?: string | null;
  last_status: 'idle' | 'success' | 'failed' | 'partial_success';
  last_error?: string | null;
  last_synced_at?: string | null;
  last_record_count?: number;
}): Promise<BitableExportConfigRecord> {
  await ensureBitableExportConfigSchema();
  const result = await pgQuery<BitableExportConfigRecord>(
    `INSERT INTO bitable_export_configs (
      source_type, enabled, target_table_id, target_table_name, table_name_prefix, selected_fields, last_status, last_error, last_synced_at, last_record_count
    ) VALUES (
      $1, FALSE, NULLIF($2, ''), NULLIF($3, ''), COALESCE(NULLIF($4, ''), '投放执行表'), '[]'::jsonb, $5, NULLIF($6, ''), $7::timestamptz, COALESCE($8, 0)
    )
    ON CONFLICT (source_type) DO UPDATE SET
      target_table_id = COALESCE(NULLIF($2, ''), bitable_export_configs.target_table_id),
      target_table_name = COALESCE(NULLIF($3, ''), bitable_export_configs.target_table_name),
      table_name_prefix = COALESCE(NULLIF($4, ''), bitable_export_configs.table_name_prefix),
      last_status = $5,
      last_error = NULLIF($6, ''),
      last_synced_at = $7::timestamptz,
      last_record_count = COALESCE($8, bitable_export_configs.last_record_count),
      updated_at = NOW()
    RETURNING id, source_type, enabled, target_table_id, target_table_name, table_name_prefix, chat_id, selected_fields,
              last_status, last_error, last_synced_at, last_record_count, created_at, updated_at`,
    [
      input.source_type,
      input.target_table_id ?? '',
      input.target_table_name ?? '',
      input.table_name_prefix ?? '',
      input.last_status,
      input.last_error ?? '',
      input.last_synced_at ?? null,
      input.last_record_count ?? 0
    ]
  );
  return {
    ...result.rows[0],
    selected_fields: normalizeSelectedFields(result.rows[0]?.selected_fields)
  };
}

export async function getBitableExportDailyTable(
  sourceType: BitableExportSourceType,
  reportDate: string
): Promise<BitableExportDailyTableRecord | null> {
  await ensureBitableExportDailyTablesSchema();
  const result = await pgQuery<BitableExportDailyTableRecord>(
    `SELECT id, source_type, report_date::text AS report_date, table_id, table_name, table_name_prefix,
            last_record_count, last_synced_at::text AS last_synced_at, created_at, updated_at
       FROM bitable_export_daily_tables
      WHERE source_type = $1
        AND report_date = $2::date
      LIMIT 1`,
    [sourceType, reportDate]
  );
  return result.rows[0] ?? null;
}

export async function listBitableExportDailyTables(
  sourceType: BitableExportSourceType,
  limit?: number
): Promise<BitableExportDailyTableRecord[]> {
  await ensureBitableExportDailyTablesSchema();
  const values: unknown[] = [sourceType];
  const hasLimit = Number.isFinite(Number(limit)) && Number(limit) > 0;
  const limitSql = hasLimit ? `LIMIT $2` : '';
  if (hasLimit) {
    values.push(Number(limit));
  }
  const result = await pgQuery<BitableExportDailyTableRecord>(
    `SELECT id, source_type, report_date::text AS report_date, table_id, table_name, table_name_prefix,
            last_record_count, last_synced_at::text AS last_synced_at, created_at, updated_at
       FROM bitable_export_daily_tables
      WHERE source_type = $1
      ORDER BY report_date DESC, updated_at DESC
      ${limitSql}`,
    values
  );
  return result.rows;
}

export async function upsertBitableExportDailyTable(input: {
  source_type: BitableExportSourceType;
  report_date: string;
  table_id: string;
  table_name: string;
  table_name_prefix: string;
  last_record_count?: number;
  last_synced_at?: string | null;
}): Promise<BitableExportDailyTableRecord> {
  await ensureBitableExportDailyTablesSchema();
  const result = await pgQuery<BitableExportDailyTableRecord>(
    `INSERT INTO bitable_export_daily_tables (
      source_type, report_date, table_id, table_name, table_name_prefix, last_record_count, last_synced_at
    ) VALUES (
      $1, $2::date, NULLIF($3, ''), NULLIF($4, ''), COALESCE(NULLIF($5, ''), '投放执行表'), COALESCE($6, 0), $7::timestamptz
    )
    ON CONFLICT (source_type, report_date) DO UPDATE SET
      table_id = EXCLUDED.table_id,
      table_name = EXCLUDED.table_name,
      table_name_prefix = EXCLUDED.table_name_prefix,
      last_record_count = EXCLUDED.last_record_count,
      last_synced_at = EXCLUDED.last_synced_at,
      updated_at = NOW()
    RETURNING id, source_type, report_date::text AS report_date, table_id, table_name, table_name_prefix,
              last_record_count, last_synced_at::text AS last_synced_at, created_at, updated_at`,
    [
      input.source_type,
      input.report_date,
      input.table_id,
      input.table_name,
      input.table_name_prefix,
      input.last_record_count ?? 0,
      input.last_synced_at ?? null
    ]
  );
  return result.rows[0];
}

export async function listBitableExportRecordRefs(
  sourceType: BitableExportSourceType,
  reportDate: string,
  tableId?: string
): Promise<BitableExportRecordRefRecord[]> {
  await ensureBitableExportRecordRefsSchema();
  const result = await pgQuery<BitableExportRecordRefRecord>(
    `SELECT id, source_type, report_date::text AS report_date, table_id, snapshot_id, sync_key, record_id,
            recommendation_type, recommendation_id, validation_result, is_adopted, created_at, updated_at
       FROM bitable_export_record_refs
      WHERE source_type = $1
        AND report_date = $2::date
        AND ($3::text IS NULL OR table_id = $3::text)
      ORDER BY created_at DESC, id DESC`,
    [sourceType, reportDate, tableId ?? null]
  );
  return result.rows;
}

export async function listBitableExportRecordRefsByTable(
  sourceType: BitableExportSourceType,
  tableId: string
): Promise<BitableExportRecordRefRecord[]> {
  await ensureBitableExportRecordRefsSchema();
  const result = await pgQuery<BitableExportRecordRefRecord>(
    `SELECT id, source_type, report_date::text AS report_date, table_id, snapshot_id, sync_key, record_id,
            recommendation_type, recommendation_id, validation_result, is_adopted, created_at, updated_at
       FROM bitable_export_record_refs
      WHERE source_type = $1
        AND table_id = $2
      ORDER BY created_at DESC, id DESC`,
    [sourceType, tableId]
  );
  return result.rows;
}

export async function upsertBitableExportRecordRefs(
  rows: Array<{
    source_type: BitableExportSourceType;
    report_date: string;
    table_id: string;
    snapshot_id: string;
    sync_key: string;
    record_id: string;
    recommendation_type?: RecommendationType | null;
    recommendation_id?: number | null;
    validation_result?: string | null;
    is_adopted?: boolean;
  }>
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await ensureBitableExportRecordRefsSchema();
  await pgQuery(
    `INSERT INTO bitable_export_record_refs (
      source_type, report_date, table_id, snapshot_id, sync_key, record_id, recommendation_type, recommendation_id,
      validation_result, is_adopted
    )
    SELECT
      x.source_type,
      x.report_date::date,
      x.table_id,
      x.snapshot_id,
      x.sync_key,
      x.record_id,
      NULLIF(x.recommendation_type, ''),
      x.recommendation_id,
      NULLIF(x.validation_result, ''),
      COALESCE(x.is_adopted, FALSE)
    FROM jsonb_to_recordset($1::jsonb) AS x(
      source_type text,
      report_date text,
      table_id text,
      snapshot_id text,
      sync_key text,
      record_id text,
      recommendation_type text,
      recommendation_id bigint,
      validation_result text,
      is_adopted boolean
    )
    ON CONFLICT (source_type, record_id) DO UPDATE SET
      report_date = EXCLUDED.report_date,
      table_id = EXCLUDED.table_id,
      snapshot_id = EXCLUDED.snapshot_id,
      sync_key = EXCLUDED.sync_key,
      recommendation_type = EXCLUDED.recommendation_type,
      recommendation_id = EXCLUDED.recommendation_id,
      validation_result = EXCLUDED.validation_result,
      is_adopted = EXCLUDED.is_adopted,
      updated_at = NOW()`,
    [JSON.stringify(rows)]
  );
}

export async function deleteBitableExportRecordRefsByRecordIds(
  sourceType: BitableExportSourceType,
  recordIds: string[]
): Promise<void> {
  if (recordIds.length === 0) {
    return;
  }
  await pgQuery(
    `DELETE FROM bitable_export_record_refs
      WHERE source_type = $1
        AND record_id = ANY($2::text[])`,
    [sourceType, recordIds]
  );
}

export async function upsertRecommendationExecutionFeedbacks(
  rows: Array<{
    source_type: BitableExportSourceType;
    recommendation_type: RecommendationType;
    recommendation_id: number;
    report_date: string;
    table_id: string;
    record_id: string;
    sync_key: string;
    execution_status?: string | null;
    is_adopted?: boolean;
    validation_result?: string | null;
    raw_fields_json?: unknown;
    bitable_last_modified_time?: string | null;
    synced_at?: string | null;
  }>
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await ensureRecommendationExecutionFeedbacksSchema();
  await pgQuery(
    `INSERT INTO recommendation_execution_feedbacks (
      source_type, recommendation_type, recommendation_id, report_date, table_id, record_id, sync_key,
      execution_status, is_adopted, validation_result, raw_fields_json, bitable_last_modified_time, synced_at
    )
    SELECT
      x.source_type,
      x.recommendation_type,
      x.recommendation_id,
      x.report_date::date,
      x.table_id,
      x.record_id,
      x.sync_key,
      NULLIF(x.execution_status, ''),
      COALESCE(x.is_adopted, FALSE),
      NULLIF(x.validation_result, ''),
      COALESCE(x.raw_fields_json, '{}'::jsonb),
      x.bitable_last_modified_time::timestamptz,
      COALESCE(x.synced_at::timestamptz, NOW())
    FROM jsonb_to_recordset($1::jsonb) AS x(
      source_type text,
      recommendation_type text,
      recommendation_id bigint,
      report_date text,
      table_id text,
      record_id text,
      sync_key text,
      execution_status text,
      is_adopted boolean,
      validation_result text,
      raw_fields_json jsonb,
      bitable_last_modified_time text,
      synced_at text
    )
    ON CONFLICT (source_type, recommendation_type, recommendation_id) DO UPDATE SET
      report_date = EXCLUDED.report_date,
      table_id = EXCLUDED.table_id,
      record_id = EXCLUDED.record_id,
      sync_key = EXCLUDED.sync_key,
      execution_status = EXCLUDED.execution_status,
      is_adopted = EXCLUDED.is_adopted,
      validation_result = EXCLUDED.validation_result,
      raw_fields_json = EXCLUDED.raw_fields_json,
      bitable_last_modified_time = EXCLUDED.bitable_last_modified_time,
      synced_at = EXCLUDED.synced_at,
      updated_at = NOW()`,
    [JSON.stringify(rows)]
  );
}

export async function listRecommendationExecutionFeedbacksByRecommendations(
  sourceType: BitableExportSourceType,
  rows: Array<{ recommendation_type: RecommendationType; recommendation_id: number }>
): Promise<RecommendationExecutionFeedbackRecord[]> {
  if (rows.length === 0) {
    return [];
  }
  await ensureRecommendationExecutionFeedbacksSchema();
  const result = await pgQuery<RecommendationExecutionFeedbackRecord>(
    `SELECT ref.id, ref.source_type, ref.recommendation_type, ref.recommendation_id, ref.report_date::text AS report_date,
            ref.table_id, ref.record_id, ref.sync_key, ref.execution_status, ref.is_adopted, ref.validation_result,
            ref.raw_fields_json, ref.bitable_last_modified_time::text AS bitable_last_modified_time,
            ref.synced_at::text AS synced_at, ref.created_at, ref.updated_at
       FROM recommendation_execution_feedbacks ref
       JOIN jsonb_to_recordset($2::jsonb) AS q(recommendation_type text, recommendation_id bigint)
         ON ref.recommendation_type = q.recommendation_type
        AND ref.recommendation_id = q.recommendation_id
      WHERE ref.source_type = $1
      ORDER BY ref.updated_at DESC, ref.id DESC`,
    [sourceType, JSON.stringify(rows)]
  );
  return result.rows;
}

export async function insertFeedbackSkillVersion(input: {
  scope: string;
  source_type: BitableExportSourceType;
  from_date?: string | null;
  to_date?: string | null;
  dataset_row_count: number;
  stats_json?: unknown;
  skills_markdown: string;
  model: string;
  prompt_hash: string;
}): Promise<FeedbackSkillVersionRecord> {
  await ensureFeedbackSkillVersionsSchema();
  const result = await pgQuery<FeedbackSkillVersionRecord>(
    `INSERT INTO feedback_skill_versions (
      scope, source_type, from_date, to_date, dataset_row_count, stats_json, skills_markdown, model, prompt_hash
    ) VALUES (
      $1, $2, $3::date, $4::date, $5, $6, $7, $8, $9
    )
    RETURNING id, scope, source_type, from_date::text AS from_date, to_date::text AS to_date, dataset_row_count,
              stats_json, skills_markdown, model, prompt_hash, created_at`,
    [
      input.scope,
      input.source_type,
      input.from_date ?? null,
      input.to_date ?? null,
      input.dataset_row_count,
      JSON.stringify(input.stats_json ?? {}),
      input.skills_markdown,
      input.model,
      input.prompt_hash
    ]
  );
  return result.rows[0];
}

export async function getLatestFeedbackSkillVersion(
  scope: string,
  sourceType: BitableExportSourceType
): Promise<FeedbackSkillVersionRecord | null> {
  await ensureFeedbackSkillVersionsSchema();
  const result = await pgQuery<FeedbackSkillVersionRecord>(
    `SELECT id, scope, source_type, from_date::text AS from_date, to_date::text AS to_date, dataset_row_count,
            stats_json, skills_markdown, model, prompt_hash, created_at
       FROM feedback_skill_versions
      WHERE scope = $1
        AND source_type = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [scope, sourceType]
  );
  return result.rows[0] ?? null;
}

export async function getLatestOperationLog(
  filter: { source?: string; action?: string; targetKey?: string }
): Promise<OperationLogRecord | null> {
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.source) {
    values.push(filter.source);
    clauses.push(`source = $${values.length}`);
  }
  if (filter.action) {
    values.push(filter.action);
    clauses.push(`action = $${values.length}`);
  }
  if (filter.targetKey) {
    values.push(filter.targetKey);
    clauses.push(`target_key = $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pgQuery<OperationLogRecord>(
    `SELECT id, source, action, target_type, target_key, status, summary, detail_json, created_at
       FROM operation_logs
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    values
  );
  return result.rows[0] ?? null;
}

export async function ensureRuntimeScheduleConfig(
  defaultPullTime: string,
  defaultPushTime: string
): Promise<RuntimeScheduleConfigRecord> {
  await pgQuery(
    `INSERT INTO runtime_schedule_configs (singleton_key, pull_time, push_time)
     VALUES ('global', $1, $2)
     ON CONFLICT (singleton_key) DO NOTHING`,
    [defaultPullTime, defaultPushTime]
  );

  const result = await pgQuery<RuntimeScheduleConfigRecord>(
    `SELECT singleton_key, pull_time, push_time, created_at, updated_at
       FROM runtime_schedule_configs
      WHERE singleton_key = 'global'
      LIMIT 1`
  );

  return result.rows[0];
}

export async function upsertRuntimeScheduleConfig(input: {
  pull_time: string;
  push_time: string;
}): Promise<RuntimeScheduleConfigRecord> {
  const result = await pgQuery<RuntimeScheduleConfigRecord>(
    `INSERT INTO runtime_schedule_configs (singleton_key, pull_time, push_time)
     VALUES ('global', $1, $2)
     ON CONFLICT (singleton_key) DO UPDATE SET
       pull_time = EXCLUDED.pull_time,
       push_time = EXCLUDED.push_time,
       updated_at = NOW()
     RETURNING singleton_key, pull_time, push_time, created_at, updated_at`,
    [input.pull_time, input.push_time]
  );

  return result.rows[0];
}

export interface CreateOperationLogInput {
  source: string;
  action: string;
  target_type?: string;
  target_key?: string;
  status?: 'success' | 'failed' | 'skipped' | 'info';
  summary?: string;
  detail_json?: unknown;
}

export async function createOperationLog(input: CreateOperationLogInput): Promise<OperationLogRecord> {
  const result = await pgQuery<OperationLogRecord>(
    `INSERT INTO operation_logs (
      source, action, target_type, target_key, status, summary, detail_json
    ) VALUES (
      $1, $2, COALESCE($3, ''), COALESCE($4, ''), COALESCE($5, 'info'), COALESCE($6, ''), $7
    )
    RETURNING id, source, action, target_type, target_key, status, summary, detail_json, created_at`,
    [
      input.source,
      input.action,
      input.target_type ?? '',
      input.target_key ?? '',
      input.status ?? 'info',
      input.summary ?? '',
      JSON.stringify(input.detail_json ?? {})
    ]
  );
  return result.rows[0];
}

export interface OperationLogFilter {
  source?: string;
  status?: 'success' | 'failed' | 'skipped' | 'info';
  limit?: number;
}

export interface OperationLogLookupFilter {
  source: string;
  action?: string;
  target_type?: string;
  target_key?: string;
}

export async function listOperationLogs(filter: OperationLogFilter = {}): Promise<OperationLogRecord[]> {
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.source) {
    values.push(filter.source);
    clauses.push(`source = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    clauses.push(`status = $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(Math.min(200, Math.max(1, filter.limit ?? 50)));

  const result = await pgQuery<OperationLogRecord>(
    `SELECT id, source, action, target_type, target_key, status, summary, detail_json, created_at
       FROM operation_logs
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

export async function getLatestOperationLogEntry(
  filter: OperationLogLookupFilter
): Promise<OperationLogRecord | null> {
  const values: unknown[] = [filter.source];
  const clauses: string[] = [`source = $${values.length}`];

  if (filter.action) {
    values.push(filter.action);
    clauses.push(`action = $${values.length}`);
  }
  if (filter.target_type) {
    values.push(filter.target_type);
    clauses.push(`target_type = $${values.length}`);
  }
  if (filter.target_key) {
    values.push(filter.target_key);
    clauses.push(`target_key = $${values.length}`);
  }

  const result = await pgQuery<OperationLogRecord>(
    `SELECT id, source, action, target_type, target_key, status, summary, detail_json, created_at
       FROM operation_logs
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    values
  );

  return result.rows[0] ?? null;
}

export interface RecommendationPolicyConfigFilter {
  appKey?: string;
  platform?: string;
  engine?: RecommendationPolicyEngine;
  enabled?: boolean;
}

export async function listRecommendationPolicyConfigs(
  filter: RecommendationPolicyConfigFilter = {}
): Promise<RecommendationPolicyConfigRecord[]> {
  await ensureRecommendationPolicyConfigsSchema();
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.appKey) {
    values.push(filter.appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (filter.platform) {
    values.push(filter.platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (filter.engine) {
    values.push(filter.engine);
    clauses.push(`engine = $${values.length}`);
  }
  if (typeof filter.enabled === 'boolean') {
    values.push(filter.enabled);
    clauses.push(`enabled = $${values.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pgQuery<RecommendationPolicyConfigRecord>(
    `SELECT id, app_key, platform, engine, enabled, rule_json, manual_prompt_markdown, created_at, updated_at
       FROM recommendation_policy_configs
       ${where}
      ORDER BY app_key ASC, platform ASC, engine ASC, updated_at DESC`,
    values
  );
  return result.rows;
}

export async function getRecommendationPolicyConfig(
  appKey: string,
  platform: string,
  engine: RecommendationPolicyEngine
): Promise<RecommendationPolicyConfigRecord | null> {
  await ensureRecommendationPolicyConfigsSchema();
  const result = await pgQuery<RecommendationPolicyConfigRecord>(
    `SELECT id, app_key, platform, engine, enabled, rule_json, manual_prompt_markdown, created_at, updated_at
       FROM recommendation_policy_configs
      WHERE app_key = $1
        AND platform = $2
        AND engine = $3
      LIMIT 1`,
    [appKey, platform, engine]
  );
  return result.rows[0] ?? null;
}

export async function upsertRecommendationPolicyConfig(input: {
  app_key: string;
  platform: string;
  engine: RecommendationPolicyEngine;
  enabled?: boolean;
  rule_json: Record<string, unknown>;
  manual_prompt_markdown?: string | null;
}): Promise<RecommendationPolicyConfigRecord> {
  await ensureRecommendationPolicyConfigsSchema();
  const result = await pgQuery<RecommendationPolicyConfigRecord>(
    `INSERT INTO recommendation_policy_configs (app_key, platform, engine, enabled, rule_json, manual_prompt_markdown)
     VALUES ($1, $2, $3, COALESCE($4, TRUE), $5::jsonb, NULLIF($6, ''))
     ON CONFLICT (app_key, platform, engine) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       rule_json = EXCLUDED.rule_json,
       manual_prompt_markdown = EXCLUDED.manual_prompt_markdown,
       updated_at = NOW()
     RETURNING id, app_key, platform, engine, enabled, rule_json, manual_prompt_markdown, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.engine,
      input.enabled ?? true,
      JSON.stringify(input.rule_json ?? {}),
      input.manual_prompt_markdown ?? null
    ]
  );
  return result.rows[0];
}

export async function listProductStageConfigs(): Promise<ProductStageConfigRecord[]> {
  const result = await pgQuery<ProductStageConfigRecord>(
    `SELECT id, app_key, platform, stage, enabled, created_at, updated_at
       FROM product_stage_configs
      ORDER BY app_key ASC, platform ASC`
  );
  return result.rows;
}

export async function getProductStageConfig(
  appKey: string,
  platform: string
): Promise<ProductStageConfigRecord | null> {
  const result = await pgQuery<ProductStageConfigRecord>(
    `SELECT id, app_key, platform, stage, enabled, created_at, updated_at
       FROM product_stage_configs
      WHERE app_key = $1 AND platform = $2
      LIMIT 1`,
    [appKey, platform]
  );
  return result.rows[0] ?? null;
}

export async function upsertProductStageConfig(input: {
  app_key: string;
  platform: string;
  stage: ProductStage;
  enabled?: boolean;
}): Promise<ProductStageConfigRecord> {
  const result = await pgQuery<ProductStageConfigRecord>(
    `INSERT INTO product_stage_configs (app_key, platform, stage, enabled)
     VALUES ($1, $2, $3, COALESCE($4, TRUE))
     ON CONFLICT (app_key, platform) DO UPDATE SET
       stage = EXCLUDED.stage,
       enabled = EXCLUDED.enabled,
       updated_at = NOW()
     RETURNING id, app_key, platform, stage, enabled, created_at, updated_at`,
    [input.app_key, input.platform, input.stage, input.enabled ?? true]
  );
  return result.rows[0];
}

export interface AsaKeywordStateFilter {
  appKey?: string;
  platform?: string;
  stage?: ProductStage;
  keyword?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export async function queryAsaKeywordStates(filter: AsaKeywordStateFilter): Promise<{
  rows: AsaKeywordStateRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  await ensureAsaKeywordRoasSchema();
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.appKey) {
    values.push(filter.appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (filter.platform) {
    values.push(filter.platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (filter.stage) {
    values.push(filter.stage);
    clauses.push(`current_stage = $${values.length}`);
  }
  if (filter.keyword) {
    values.push(`%${filter.keyword.toLowerCase()}%`);
    clauses.push(`(LOWER(keyword) LIKE $${values.length} OR LOWER(campaign) LIKE $${values.length} OR LOWER(adset) LIKE $${values.length})`);
  }
  if (filter.from) {
    values.push(filter.from);
    clauses.push(`last_seen_date >= $${values.length}::date`);
  }
  if (filter.to) {
    values.push(filter.to);
    clauses.push(`last_seen_date <= $${values.length}::date`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countResult = await pgQuery<{ total: string }>(
    `SELECT to_char(count(*), 'FM999999999999999') AS total
       FROM asa_keyword_states
       ${where}`,
    values
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / filter.pageSize));
  const page = Math.min(filter.page, totalPages);
  const offset = (page - 1) * filter.pageSize;
  const listValues = [...values, filter.pageSize, offset];

  const rowsResult = await pgQuery<AsaKeywordStateRow>(
    `SELECT id, app_key, platform, keyword, campaign, adset, current_stage, stage_score, first_seen_date, last_seen_date,
            current_ecpi, current_cpp, current_d7_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio,
            roas_window_from, roas_window_to, roas_data_status, roas_coverage_ratio, target_ecpi, target_cpp, target_d7_roas,
            installs_7d, total_cost_7d, purchase_count_7d, revenue_d7_7d, trend_json, created_at, updated_at
       FROM asa_keyword_states
       ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}`,
    listValues
  );

  return { rows: rowsResult.rows, total, page, pageSize: filter.pageSize, totalPages };
}

export async function upsertAsaKeywordState(input: {
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  current_stage: ProductStage;
  stage_score: number;
  first_seen_date: string;
  last_seen_date: string;
  current_ecpi: number;
  current_cpp: number;
  current_d7_roas: number;
  af_cohort_roas?: number | null;
  local_derived_roas?: number | null;
  roas_primary_source?: RoasPrimarySource;
  roas_warning_code?: RoasWarningCode;
  roas_deviation_ratio?: number | null;
  roas_window_from?: string | null;
  roas_window_to?: string | null;
  roas_data_status?: RoasDataStatus;
  roas_coverage_ratio?: number;
  target_ecpi: number;
  target_cpp: number;
  target_d7_roas: number;
  installs_7d: number;
  total_cost_7d: number;
  purchase_count_7d: number;
  revenue_d7_7d: number;
  trend_json: unknown;
}): Promise<AsaKeywordStateRow> {
  await ensureAsaKeywordRoasSchema();
  const result = await pgQuery<AsaKeywordStateRow>(
    `INSERT INTO asa_keyword_states (
      app_key, platform, keyword, campaign, adset, current_stage, stage_score, first_seen_date, last_seen_date,
      current_ecpi, current_cpp, current_d7_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, roas_window_from, roas_window_to, roas_data_status, roas_coverage_ratio, target_ecpi, target_cpp, target_d7_roas,
      installs_7d, total_cost_7d, purchase_count_7d, revenue_d7_7d, trend_json
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11, $12, $13, $14, $15, $16, $17, $18::date, $19::date, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29
    )
    ON CONFLICT (app_key, platform, keyword, campaign, adset) DO UPDATE SET
      current_stage = EXCLUDED.current_stage,
      stage_score = EXCLUDED.stage_score,
      first_seen_date = LEAST(asa_keyword_states.first_seen_date, EXCLUDED.first_seen_date),
      last_seen_date = GREATEST(asa_keyword_states.last_seen_date, EXCLUDED.last_seen_date),
      current_ecpi = EXCLUDED.current_ecpi,
      current_cpp = EXCLUDED.current_cpp,
      current_d7_roas = EXCLUDED.current_d7_roas,
      af_cohort_roas = EXCLUDED.af_cohort_roas,
      local_derived_roas = EXCLUDED.local_derived_roas,
      roas_primary_source = EXCLUDED.roas_primary_source,
      roas_warning_code = EXCLUDED.roas_warning_code,
      roas_deviation_ratio = EXCLUDED.roas_deviation_ratio,
      roas_window_from = EXCLUDED.roas_window_from,
      roas_window_to = EXCLUDED.roas_window_to,
      roas_data_status = EXCLUDED.roas_data_status,
      roas_coverage_ratio = EXCLUDED.roas_coverage_ratio,
      target_ecpi = EXCLUDED.target_ecpi,
      target_cpp = EXCLUDED.target_cpp,
      target_d7_roas = EXCLUDED.target_d7_roas,
      installs_7d = EXCLUDED.installs_7d,
      total_cost_7d = EXCLUDED.total_cost_7d,
      purchase_count_7d = EXCLUDED.purchase_count_7d,
      revenue_d7_7d = EXCLUDED.revenue_d7_7d,
      trend_json = EXCLUDED.trend_json,
      updated_at = NOW()
    RETURNING id, app_key, platform, keyword, campaign, adset, current_stage, stage_score, first_seen_date, last_seen_date,
              current_ecpi, current_cpp, current_d7_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, roas_window_from, roas_window_to, roas_data_status, roas_coverage_ratio, target_ecpi, target_cpp, target_d7_roas,
              installs_7d, total_cost_7d, purchase_count_7d, revenue_d7_7d, trend_json, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.keyword,
      input.campaign,
      input.adset,
      input.current_stage,
      input.stage_score,
      input.first_seen_date,
      input.last_seen_date,
      input.current_ecpi,
      input.current_cpp,
      input.current_d7_roas,
      input.af_cohort_roas ?? null,
      input.local_derived_roas ?? null,
      input.roas_primary_source ?? 'local_fallback',
      input.roas_warning_code ?? 'none',
      input.roas_deviation_ratio ?? null,
      input.roas_window_from ?? null,
      input.roas_window_to ?? null,
      input.roas_data_status ?? 'unavailable',
      Number(input.roas_coverage_ratio || 0),
      input.target_ecpi,
      input.target_cpp,
      input.target_d7_roas,
      input.installs_7d,
      input.total_cost_7d,
      input.purchase_count_7d,
      input.revenue_d7_7d,
      JSON.stringify(input.trend_json ?? {})
    ]
  );
  return result.rows[0];
}

export async function deleteStaleAsaKeywordStates(
  appKey: string,
  platform: string,
  scopes: Array<{ keyword: string; campaign: string; adset: string }>
): Promise<void> {
  if (!scopes.length) {
    await pgQuery(`DELETE FROM asa_keyword_states WHERE app_key = $1 AND platform = $2`, [appKey, platform]);
    return;
  }
  await pgQuery(
    `WITH keep AS (
        SELECT keyword, campaign, adset
        FROM jsonb_to_recordset($3::jsonb) AS x(keyword text, campaign text, adset text)
      )
      DELETE FROM asa_keyword_states s
      WHERE s.app_key = $1
        AND s.platform = $2
        AND NOT EXISTS (
          SELECT 1
          FROM keep k
          WHERE k.keyword = s.keyword
            AND k.campaign = s.campaign
            AND k.adset = s.adset
        )`,
    [appKey, platform, JSON.stringify(scopes)]
  );
}

export async function replaceAsaKeywordRecommendationsForDate(
  appKey: string,
  platform: string,
  date: string
): Promise<void> {
  await pgQuery(
    `UPDATE asa_keyword_recommendations
        SET status = 'expired',
            updated_at = NOW()
      WHERE app_key = $1
        AND platform = $2
        AND date = $3::date
        AND status = 'pending'`,
    [appKey, platform, date]
  );
}

export async function upsertAsaKeywordRecommendation(input: {
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  date: string;
  action: 'increase' | 'decrease' | 'hold' | 'pause';
  change_ratio: number;
  primary_metric: 'ecpi' | 'd7_roas_cpp';
  current_ecpi: number;
  current_cpp: number;
  current_d7_roas: number;
  af_cohort_roas?: number | null;
  local_derived_roas?: number | null;
  roas_primary_source?: RoasPrimarySource;
  roas_warning_code?: RoasWarningCode;
  roas_deviation_ratio?: number | null;
  roas_window_from?: string | null;
  roas_window_to?: string | null;
  roas_data_status?: RoasDataStatus;
  target_ecpi: number;
  target_cpp: number;
  target_d7_roas: number;
  reason_code: string;
  llm_summary: unknown;
  status?: 'pending' | 'sent' | 'applied' | 'rejected' | 'expired';
}): Promise<AsaKeywordRecommendationRow> {
  await ensureAsaKeywordRoasSchema();
  const result = await pgQuery<AsaKeywordRecommendationRow>(
    `INSERT INTO asa_keyword_recommendations (
      app_key, platform, keyword, campaign, adset, date, action, change_ratio, primary_metric,
      current_ecpi, current_cpp, current_d7_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, roas_window_from, roas_window_to, roas_data_status, target_ecpi, target_cpp, target_d7_roas,
      reason_code, llm_summary, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6::date, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16, $17, $18::date, $19::date, $20, $21, $22, $23, $24, $25, COALESCE($26, 'pending')
    )
    ON CONFLICT (app_key, platform, keyword, campaign, adset, date) DO UPDATE SET
      action = EXCLUDED.action,
      change_ratio = EXCLUDED.change_ratio,
      primary_metric = EXCLUDED.primary_metric,
      current_ecpi = EXCLUDED.current_ecpi,
      current_cpp = EXCLUDED.current_cpp,
      current_d7_roas = EXCLUDED.current_d7_roas,
      af_cohort_roas = EXCLUDED.af_cohort_roas,
      local_derived_roas = EXCLUDED.local_derived_roas,
      roas_primary_source = EXCLUDED.roas_primary_source,
      roas_warning_code = EXCLUDED.roas_warning_code,
      roas_deviation_ratio = EXCLUDED.roas_deviation_ratio,
      roas_window_from = EXCLUDED.roas_window_from,
      roas_window_to = EXCLUDED.roas_window_to,
      roas_data_status = EXCLUDED.roas_data_status,
      target_ecpi = EXCLUDED.target_ecpi,
      target_cpp = EXCLUDED.target_cpp,
      target_d7_roas = EXCLUDED.target_d7_roas,
      reason_code = EXCLUDED.reason_code,
      llm_summary = EXCLUDED.llm_summary,
      status = CASE
        WHEN asa_keyword_recommendations.status IN ('applied', 'rejected') THEN asa_keyword_recommendations.status
        ELSE EXCLUDED.status
      END,
      updated_at = NOW()
    RETURNING id, app_key, platform, keyword, campaign, adset, date, action, change_ratio, primary_metric,
              current_ecpi, current_cpp, current_d7_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, roas_window_from, roas_window_to, roas_data_status, target_ecpi, target_cpp, target_d7_roas,
              reason_code, llm_summary, status, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.keyword,
      input.campaign,
      input.adset,
      input.date,
      input.action,
      input.change_ratio,
      input.primary_metric,
      input.current_ecpi,
      input.current_cpp,
      input.current_d7_roas,
      input.af_cohort_roas ?? null,
      input.local_derived_roas ?? null,
      input.roas_primary_source ?? 'local_fallback',
      input.roas_warning_code ?? 'none',
      input.roas_deviation_ratio ?? null,
      input.roas_window_from ?? null,
      input.roas_window_to ?? null,
      input.roas_data_status ?? 'unavailable',
      input.target_ecpi,
      input.target_cpp,
      input.target_d7_roas,
      input.reason_code,
      JSON.stringify(input.llm_summary ?? {}),
      input.status ?? 'pending'
    ]
  );
  return result.rows[0];
}

export async function deleteStaleAsaKeywordRecommendations(
  appKey: string,
  platform: string,
  from: string,
  to: string,
  scopes: Array<{ keyword: string; campaign: string; adset: string }>
): Promise<void> {
  if (!scopes.length) {
    await pgQuery(
      `DELETE FROM asa_keyword_recommendations
        WHERE app_key = $1
          AND platform = $2
          AND date BETWEEN $3::date AND $4::date`,
      [appKey, platform, from, to]
    );
    return;
  }
  await pgQuery(
    `WITH keep AS (
        SELECT keyword, campaign, adset
        FROM jsonb_to_recordset($5::jsonb) AS x(keyword text, campaign text, adset text)
      )
      DELETE FROM asa_keyword_recommendations r
      WHERE r.app_key = $1
        AND r.platform = $2
        AND r.date BETWEEN $3::date AND $4::date
        AND NOT EXISTS (
          SELECT 1
          FROM keep k
          WHERE k.keyword = r.keyword
            AND k.campaign = r.campaign
            AND k.adset = r.adset
        )`,
    [appKey, platform, from, to, JSON.stringify(scopes)]
  );
}

export async function queryAsaKeywordRecommendations(filter: {
  appKey?: string;
  platform?: string;
  status?: 'pending' | 'sent' | 'applied' | 'rejected' | 'expired';
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}): Promise<{
  rows: AsaKeywordRecommendationRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  await ensureAsaKeywordRoasSchema();
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (filter.appKey) {
    values.push(filter.appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (filter.platform) {
    values.push(filter.platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filter.from) {
    values.push(filter.from);
    clauses.push(`date >= $${values.length}::date`);
  }
  if (filter.to) {
    values.push(filter.to);
    clauses.push(`date <= $${values.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countResult = await pgQuery<{ total: string }>(
    `SELECT to_char(count(*), 'FM999999999999999') AS total
       FROM asa_keyword_recommendations
      ${where}`,
    values
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / filter.pageSize));
  const page = Math.min(filter.page, totalPages);
  const offset = (page - 1) * filter.pageSize;
  const listValues = [...values, filter.pageSize, offset];
  const rowsResult = await pgQuery<AsaKeywordRecommendationRow>(
    `SELECT id, app_key, platform, keyword, campaign, adset, date, action, change_ratio, primary_metric,
            current_ecpi, current_cpp, current_d7_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, roas_window_from, roas_window_to, roas_data_status, target_ecpi, target_cpp, target_d7_roas,
            reason_code, llm_summary, status, created_at, updated_at
       FROM asa_keyword_recommendations
       ${where}
      ORDER BY date DESC, updated_at DESC, id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}`,
    listValues
  );
  return { rows: rowsResult.rows, total, page, pageSize: filter.pageSize, totalPages };
}

export async function setAsaKeywordRecommendationStatus(
  id: number,
  status: 'pending' | 'sent' | 'applied' | 'rejected' | 'expired'
): Promise<AsaKeywordRecommendationRow | null> {
  await ensureAsaKeywordRoasSchema();
  const result = await pgQuery<AsaKeywordRecommendationRow>(
    `UPDATE asa_keyword_recommendations
        SET status = $1,
            updated_at = NOW()
      WHERE id = $2
      RETURNING id, app_key, platform, keyword, campaign, adset, date, action, change_ratio, primary_metric,
                current_ecpi, current_cpp, current_d7_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, roas_window_from, roas_window_to, roas_data_status, target_ecpi, target_cpp, target_d7_roas,
                reason_code, llm_summary, status, created_at, updated_at`,
    [status, id]
  );
  return result.rows[0] ?? null;
}

export async function listEnabledAsaKeywordRoutes(): Promise<AsaKeywordRouteRecord[]> {
  const result = await pgQuery<AsaKeywordRouteRecord>(
    `SELECT id, enabled, route_name, app_key, platform, notify_feishu_app_id,
            notify_feishu_app_secret, notify_feishu_chat_id, priority, created_at, updated_at
       FROM asa_keyword_routes
      WHERE enabled = TRUE
      ORDER BY priority ASC, id ASC`
  );
  return result.rows;
}
