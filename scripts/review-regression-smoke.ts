import assert from 'node:assert/strict';
import {
  classifyAppsflyerHttpFailure,
  classifyAppsflyerTransportFailure
} from '../packages/shared/utils/appsflyerRequest.js';
import { resolveManualBitableExportHttpResult, type BitableExportRunResult } from '../packages/shared/utils/bitableExport.js';
import { shouldUpsertFeedbackRow } from '../packages/shared/utils/recommendationFeedback.js';
import { evaluateScheduledWorkerRunDecision } from '../packages/shared/utils/scheduledWorkerRun.js';
import { getSevenDayLaterTodayDateString } from '../packages/shared/utils/sevenDayLaterData.js';
import type { RecommendationExecutionFeedbackRecord } from '../packages/shared/types/models.js';
import type { ScheduledWorkerRunRecord } from '../packages/shared/utils/repositories.js';

function buildBitableResult(overrides: Partial<BitableExportRunResult>): BitableExportRunResult {
  return {
    source_type: 'delivery_actions',
    label: '投放执行表',
    report_date: '2026-03-26',
    table_id: 'tbl_demo',
    table_name: '投放执行表_2026-03-26',
    table_name_prefix: '投放执行表',
    table_url: 'https://example.com',
    selected_fields: [],
    deleted_count: 0,
    record_count: 1,
    export_status: 'success',
    export_error: null,
    breakdown: {
      campaign_actions: 1,
      asa_actions: 0
    },
    notify: {
      ok: true
    },
    ...overrides
  };
}

function buildExistingFeedback(): RecommendationExecutionFeedbackRecord {
  return {
    id: 1,
    source_type: 'delivery_actions',
    recommendation_type: 'budget',
    recommendation_id: 101,
    report_date: '2026-03-26',
    table_id: 'tbl_demo',
    record_id: 'rec_demo',
    sync_key: 'sync_demo',
    execution_status: '执行中',
    is_adopted: true,
    validation_result: '保持观察',
    raw_fields_json: {},
    bitable_last_modified_time: '2026-03-27T00:00:00.000Z',
    synced_at: '2026-03-27T00:01:00.000Z',
    created_at: '2026-03-27T00:01:00.000Z',
    updated_at: '2026-03-27T00:01:00.000Z'
  };
}

function buildScheduledWorkerRun(
  overrides: Partial<ScheduledWorkerRunRecord> = {}
): ScheduledWorkerRunRecord {
  return {
    worker_name: 'worker.daily_brief',
    run_marker: '2026-03-27|10:00',
    status: 'failed',
    attempt_count: 1,
    last_attempt_at: '2026-03-27T01:00:00.000Z',
    next_allowed_at: '2026-03-27T01:15:00.000Z',
    completed_at: null,
    last_error: 'network_error',
    created_at: '2026-03-27T01:00:00.000Z',
    updated_at: '2026-03-27T01:00:00.000Z',
    ...overrides
  };
}

async function main(): Promise<void> {
  const policy = {
    max_attempts: 3,
    retry_cooldown_ms: 15 * 60 * 1000
  };

  const initialDecision = evaluateScheduledWorkerRunDecision(null, policy, new Date('2026-03-27T01:00:00.000Z'));
  assert.equal(initialDecision.allowed, true);
  assert.equal(initialDecision.remaining_attempts, 3);

  const cooldownDecision = evaluateScheduledWorkerRunDecision(
    buildScheduledWorkerRun(),
    policy,
    new Date('2026-03-27T01:01:00.000Z')
  );
  assert.equal(cooldownDecision.allowed, false);
  assert.equal(cooldownDecision.reason, 'cooldown');
  assert.equal(cooldownDecision.next_allowed_at, '2026-03-27T01:15:00.000Z');

  const exhaustedDecision = evaluateScheduledWorkerRunDecision(
    buildScheduledWorkerRun({
      attempt_count: 3,
      next_allowed_at: '2026-03-27T01:45:00.000Z'
    }),
    policy,
    new Date('2026-03-27T02:00:00.000Z')
  );
  assert.equal(exhaustedDecision.allowed, false);
  assert.equal(exhaustedDecision.reason, 'max_attempts');

  const completedDecision = evaluateScheduledWorkerRunDecision(
    buildScheduledWorkerRun({
      status: 'completed',
      completed_at: '2026-03-27T02:30:00.000Z',
      next_allowed_at: null
    }),
    policy,
    new Date('2026-03-27T03:00:00.000Z')
  );
  assert.equal(completedDecision.allowed, false);
  assert.equal(completedDecision.reason, 'completed');

  const successResponse = resolveManualBitableExportHttpResult(buildBitableResult({}));
  assert.deepEqual(successResponse, {
    http_status: 200,
    ok: true,
    error: null
  });

  const partialResponse = resolveManualBitableExportHttpResult(
    buildBitableResult({
      export_status: 'partial_success'
    })
  );
  assert.deepEqual(partialResponse, {
    http_status: 207,
    ok: false,
    error: 'bitable_export_partial_success'
  });

  const notifyFailureResponse = resolveManualBitableExportHttpResult(
    buildBitableResult({
      notify: {
        ok: false,
        error: 'network_error'
      }
    })
  );
  assert.deepEqual(notifyFailureResponse, {
    http_status: 502,
    ok: false,
    error: 'bitable_export_notify_failed'
  });

  const existing = buildExistingFeedback();
  const unchanged = shouldUpsertFeedbackRow(
    {
      recommendation_type: 'budget',
      recommendation_id: 101,
      execution_status: '执行中',
      is_adopted: true,
      validation_result: '保持观察',
      record_id: 'rec_demo',
      table_id: 'tbl_demo',
      sync_key: 'sync_demo',
      report_date: '2026-03-26',
      raw_fields_json: {},
      bitable_last_modified_time: '2026-03-27T00:00:00.000Z'
    },
    existing
  );
  assert.equal(unchanged, false);

  const modifiedTimeOnlyChanged = shouldUpsertFeedbackRow(
    {
      recommendation_type: 'budget',
      recommendation_id: 101,
      execution_status: '执行中',
      is_adopted: true,
      validation_result: '保持观察',
      record_id: 'rec_demo',
      table_id: 'tbl_demo',
      sync_key: 'sync_demo',
      report_date: '2026-03-26',
      raw_fields_json: {},
      bitable_last_modified_time: '2026-03-28T00:00:00.000Z'
    },
    existing
  );
  assert.equal(modifiedTimeOnlyChanged, false);

  const changed = shouldUpsertFeedbackRow(
    {
      recommendation_type: 'budget',
      recommendation_id: 101,
      execution_status: '已完成-效果符合预期',
      is_adopted: true,
      validation_result: '保持观察',
      record_id: 'rec_demo',
      table_id: 'tbl_demo',
      sync_key: 'sync_demo',
      report_date: '2026-03-26',
      raw_fields_json: {},
      bitable_last_modified_time: '2026-03-27T00:00:00.000Z'
    },
    existing
  );
  assert.equal(changed, true);

  const inserted = shouldUpsertFeedbackRow(
    {
      recommendation_type: 'budget',
      recommendation_id: 202,
      execution_status: null,
      is_adopted: false,
      validation_result: null,
      record_id: 'rec_new',
      table_id: 'tbl_demo',
      sync_key: 'sync_new',
      report_date: '2026-03-26',
      raw_fields_json: {},
      bitable_last_modified_time: null
    },
    undefined
  );
  assert.equal(inserted, true);

  const timeoutFailure = classifyAppsflyerTransportFailure(
    'pull_api',
    Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
    20_000
  );
  assert.equal(timeoutFailure.kind, 'timeout');
  assert.equal(timeoutFailure.immediateRetryable, true);
  assert.equal(timeoutFailure.scheduledRetryable, true);

  const authFailure = classifyAppsflyerHttpFailure('pull_api', 401, 'Unauthorized');
  assert.equal(authFailure.kind, 'auth');
  assert.equal(authFailure.immediateRetryable, false);
  assert.equal(authFailure.scheduledRetryable, false);

  const rateLimitFailure = classifyAppsflyerHttpFailure('pull_api', 403, 'Limit reached for daily-report');
  assert.equal(rateLimitFailure.kind, 'rate_limit');
  assert.equal(rateLimitFailure.immediateRetryable, false);
  assert.equal(rateLimitFailure.scheduledRetryable, true);

  const serverFailure = classifyAppsflyerHttpFailure('raw_api', 502, 'Bad gateway');
  assert.equal(serverFailure.kind, 'server');
  assert.equal(serverFailure.immediateRetryable, true);
  assert.equal(serverFailure.scheduledRetryable, true);

  const shanghaiAfterMidnight = getSevenDayLaterTodayDateString(new Date('2026-03-27T16:30:00.000Z'));
  assert.equal(shanghaiAfterMidnight, '2026-03-28');

  console.log('review_regression_smoke_passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
