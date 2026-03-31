import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRecommendationPoliciesRouter } from '../apps/api/src/modules/recommendationPolicies/recommendationPolicies.routes.js';
import { aggregateBudgetCountryWindowFacts } from '../packages/shared/utils/budgetAdvisor.js';
import {
  classifyAppsflyerHttpFailure,
  classifyAppsflyerTransportFailure
} from '../packages/shared/utils/appsflyerRequest.js';
import { resolveManualBitableExportHttpResult, type BitableExportRunResult } from '../packages/shared/utils/bitableExport.js';
import { shouldUpsertFeedbackRow } from '../packages/shared/utils/recommendationFeedback.js';
import {
  buildAsaContextWindow,
  buildAsaDecisionWindow,
  buildAsaRelativeCompareDecision
} from '../packages/shared/utils/asaKeywords.js';
import {
  didKeywordEngineCycleComplete,
  resolveKeywordEngineBackfillDays
} from '../packages/shared/utils/keywordEngineWorkerPolicy.js';
import {
  evaluateRelativeCompareMetrics,
  RecommendationPolicyValidationError,
  resolveRecommendationTarget,
  summarizeRecommendationPolicySupport,
  validateRecommendationPolicyRule
} from '../packages/shared/utils/recommendationPolicies.js';
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

async function withHttpApi<T>(
  router: express.Router,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use(router);

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
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

  const validatedPolicy = validateRecommendationPolicyRule({
    metric_family: 'relative_compare',
    decision_mode: 'hybrid',
    traffic_scope: 'media_sources',
    media_sources: ['Apple Search Ads'],
    maturity_window: {
      exclude_recent_days: 7,
      decision_window_days: 14,
      context_window_days: [7, 14, 21]
    },
    targets: {
      global_targets: { ecpi_max: 3 },
      country_targets: {
        US: { ecpi_max: 2.5 }
      },
      media_targets: {
        'Apple Search Ads': { ecpi_max: 2.8 }
      }
    },
    relative_compare: {
      compare_granularity: 'campaign',
      metrics: ['cpi', 'roas'],
      min_peer_count: 3,
      underperform_ratio: 0.2,
      min_failed_metrics: 2
    }
  }).rule;

  assert.equal(resolveRecommendationTarget(validatedPolicy, { country: 'US', mediaSource: 'Apple Search Ads' }).ecpi_max, 2.5);
  assert.equal(resolveRecommendationTarget(validatedPolicy, { country: 'BR', mediaSource: 'Apple Search Ads' }).ecpi_max, 2.8);
  assert.equal(resolveRecommendationTarget(validatedPolicy, { country: 'BR', mediaSource: 'Meta' }).ecpi_max, 3);

  const relativeCompareDecision = evaluateRelativeCompareMetrics(
    [
      { metric: 'cpi', current: 12, peers: [5, 6, 7, 8] },
      { metric: 'roas', current: 0.2, peers: [0.4, 0.45, 0.5, 0.55] },
      { metric: 'ctr', current: 0.08, peers: [0.03, 0.04, 0.05, 0.06] }
    ],
    {
      minPeerCount: 3,
      underperformRatio: 0.2
    }
  );
  assert.deepEqual(relativeCompareDecision.failedMetrics.sort(), ['cpi', 'roas']);
  assert.deepEqual(relativeCompareDecision.strongMetrics, ['ctr']);

  const asaDecisionWindow = buildAsaDecisionWindow('2026-03-31', validatedPolicy);
  assert.deepEqual(asaDecisionWindow, {
    from: '2026-03-11',
    to: '2026-03-24'
  });
  const asaContextWindow = buildAsaContextWindow('2026-03-31', validatedPolicy);
  assert.deepEqual(asaContextWindow, {
    from: '2026-03-11',
    to: '2026-03-31'
  });
  const asaRelativeIncrease = buildAsaRelativeCompareDecision({
    stage: 'rising',
    currentEcpi: 2,
    currentD7Roas: 0.8,
    peerEcpi: [3, 3.2, 3.5, 3.6],
    peerRoas: [0.35, 0.4, 0.45, 0.5],
    policy: validatedPolicy
  });
  assert.equal(asaRelativeIncrease.action, 'increase');
  assert.deepEqual(asaRelativeIncrease.strongMetrics.sort(), ['cpi', 'roas']);

  const countryWindowFacts = aggregateBudgetCountryWindowFacts(
    [
      {
        date: '2026-03-08',
        platform: 'ios',
        media_source: 'Apple Search Ads',
        keyword: 'demo',
        match_type: 'exact',
        country: 'US',
        installs: 4,
        total_cost: 8
      },
      {
        date: '2026-03-12',
        platform: 'ios',
        media_source: 'Apple Search Ads',
        keyword: 'demo',
        match_type: 'exact',
        country: 'US',
        installs: 2,
        total_cost: 10
      },
      {
        date: '2026-03-14',
        platform: 'ios',
        media_source: 'Apple Search Ads',
        keyword: 'demo',
        match_type: 'exact',
        country: 'BR',
        installs: 5,
        total_cost: 5
      }
    ],
    '2026-03-10',
    '2026-03-15'
  );
  assert.deepEqual(countryWindowFacts, [
    {
      country: 'US',
      installs: 2,
      total_cost: 10,
      current_ecpi: 5
    },
    {
      country: 'BR',
      installs: 5,
      total_cost: 5,
      current_ecpi: 1
    }
  ]);

  assert.equal(resolveKeywordEngineBackfillDays(false, 30, 3), 30);
  assert.equal(resolveKeywordEngineBackfillDays(true, 30, 3), 3);
  assert.equal(didKeywordEngineCycleComplete({ failed_count: 0 }), true);
  assert.equal(didKeywordEngineCycleComplete({ failed_count: 1 }), false);

  const supportSummary = summarizeRecommendationPolicySupport('budget', validatedPolicy);
  assert.equal(supportSummary.automation_level, 'partial');
  assert.ok(supportSummary.notes.some((note) => note.includes('relative_compare 已接入 evaluator')));
  assert.ok(supportSummary.notes.some((note) => note.includes('国家级 eCPI 阈值判断')));
  assert.ok(!supportSummary.notes.some((note) => note.includes('主要用于解释上下文')));

  assert.throws(
    () =>
      validateRecommendationPolicyRule({
        metric_family: 'ecpi',
        decision_mode: 'deterministic',
        traffic_scope: 'all',
        unexpected_field: true
      }),
    (error: unknown) =>
      error instanceof RecommendationPolicyValidationError &&
      error.code === 'invalid_rule_json' &&
      error.message.includes('unexpected_field')
  );

  assert.throws(
    () =>
      validateRecommendationPolicyRule({
        metric_family: 'ecpi',
        decision_mode: 'deterministic',
        traffic_scope: 'media_sources',
        media_sources: []
      }),
    (error: unknown) =>
      error instanceof RecommendationPolicyValidationError && error.code === 'invalid_media_sources'
  );

  const mockedPolicyRouter = createRecommendationPoliciesRouter({
    getAppByKey: async () =>
      ({
        id: 1,
        app_key: 'demo',
        display_name: 'Demo',
        ios_display_name: null,
        android_display_name: null,
        pull_app_id: null,
        ios_pull_app_id: null,
        android_pull_app_id: null,
        dataset: null,
        push_auth_token: null,
        timezone: 'Asia/Shanghai',
        notify_webhook_url: null,
        notify_feishu_app_id: null,
        notify_feishu_app_secret: null,
        notify_feishu_chat_id: null,
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-01T00:00:00.000Z'
      }) as never,
    listRecommendationPolicyConfigs: async () => [],
    upsertRecommendationPolicyConfig: (async () => {
      throw new Error('upsert_should_not_be_called');
    }) as never,
    writeOperationLog: async () => undefined
  } as never);

  await withHttpApi(mockedPolicyRouter, async (baseUrl) => {
    const invalidPlatformResponse = await fetch(`${baseUrl}/api/recommendation-policies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appKey: 'demo',
        platform: 'web',
        engine: 'budget',
        ruleJson: {
          metric_family: 'ecpi',
          decision_mode: 'deterministic',
          traffic_scope: 'all'
        }
      })
    });
    assert.equal(invalidPlatformResponse.status, 400);
    assert.deepEqual(await invalidPlatformResponse.json(), {
      ok: false,
      error: 'invalid_platform'
    });

    const invalidRuleResponse = await fetch(`${baseUrl}/api/recommendation-policies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appKey: 'demo',
        platform: 'ios',
        engine: 'budget',
        ruleJson: {
          metric_family: 'ecpi',
          decision_mode: 'deterministic',
          traffic_scope: 'all',
          unexpected_field: true
        }
      })
    });
    assert.equal(invalidRuleResponse.status, 400);
    const invalidRulePayload = await invalidRuleResponse.json();
    assert.equal(invalidRulePayload.ok, false);
    assert.equal(invalidRulePayload.error, 'invalid_rule_json');
    assert.match(invalidRulePayload.message, /unexpected_field/);
  });

  const missingAppRouter = createRecommendationPoliciesRouter({
    getAppByKey: async () => null,
    listRecommendationPolicyConfigs: async () => [],
    upsertRecommendationPolicyConfig: (async () => {
      throw new Error('upsert_should_not_be_called');
    }) as never,
    writeOperationLog: async () => undefined
  } as never);

  await withHttpApi(missingAppRouter, async (baseUrl) => {
    const appNotFoundResponse = await fetch(`${baseUrl}/api/recommendation-policies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appKey: 'missing-app',
        platform: 'ios',
        engine: 'budget',
        ruleJson: {
          metric_family: 'ecpi',
          decision_mode: 'deterministic',
          traffic_scope: 'all'
        }
      })
    });
    assert.equal(appNotFoundResponse.status, 404);
    assert.deepEqual(await appNotFoundResponse.json(), {
      ok: false,
      error: 'app_not_found'
    });
  });

  console.log('review_regression_smoke_passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
