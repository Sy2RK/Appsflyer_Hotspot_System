import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRecommendationPoliciesRouter } from '../apps/api/src/modules/recommendationPolicies/recommendationPolicies.routes.js';
import {
  createPolicyTemplate,
  sanitizeRecommendationPolicyDraft,
  mergeRecommendationPolicyRule,
  buildRecommendationPolicyTableSummary,
  getRecommendationPolicyErrorMessage
} from '../apps/api/src/modules/ui/public/recommendationPolicyWizard.js';
import { aggregateBudgetCountryWindowFacts, finalizeBudgetDecisionPlan } from '../packages/shared/utils/budgetAdvisor.js';
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
import { buildAiContextPrompt } from '../packages/shared/utils/aiChat.js';
import {
  didKeywordEngineCycleComplete,
  resolveKeywordEngineBackfillDays
} from '../packages/shared/utils/keywordEngineWorkerPolicy.js';
import { buildKeywordValueRows } from '../packages/shared/utils/keywordEngine.js';
import {
  defaultRecommendationPolicyRule,
  evaluateSpendScenarios,
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

  const defaultPolicyRule = defaultRecommendationPolicyRule();
  assert.equal(defaultPolicyRule.adjustment_policy.default_increase_ratio, 0.2);
  assert.equal(defaultPolicyRule.adjustment_policy.default_decrease_ratio, 0.2);
  assert.equal(defaultPolicyRule.adjustment_policy.high_spend_uptrend_increase_ratio, 0.3);

  const scenarioEvaluation = evaluateSpendScenarios({
    avgDailySpend: 8,
    spendSeries: [6, 7, 8, 9],
    spendPolicy: {
      daily_budget_cap_usd: undefined,
      low_spend_threshold_usd: 10,
      high_spend_threshold_usd: 100,
      trend_lookback_days: 7,
      uptrend_min_ratio: 0.15
    },
    actionPlaybook: defaultPolicyRule.action_playbook
  });
  assert.deepEqual(scenarioEvaluation.scenarioTags, ['low_spend_signal_weak']);
  assert.deepEqual(scenarioEvaluation.executionActionCodes, ['iterate_creative', 'increase_spend_capacity']);

  const lowSpendFinalDecision = finalizeBudgetDecisionPlan({
    decision: {
      action: 'increase',
      changeRatio: 0.2,
      confidence: 0.8,
      reasonCode: 'test_expand',
      volumeTier: 'medium'
    },
    scenarioTags: ['low_spend_signal_weak'],
    adjustmentPolicy: defaultPolicyRule.adjustment_policy
  });
  assert.equal(lowSpendFinalDecision.action, 'hold');
  assert.equal(lowSpendFinalDecision.changeRatio, 0);
  assert.deepEqual(
    lowSpendFinalDecision.executionActions.map((item) => item.code),
    ['iterate_creative', 'increase_spend_capacity']
  );

  const pauseFinalDecision = finalizeBudgetDecisionPlan({
    decision: {
      action: 'pause',
      changeRatio: -1,
      confidence: 0.9,
      reasonCode: 'test_pause',
      volumeTier: 'high'
    },
    scenarioTags: ['low_spend_signal_weak'],
    adjustmentPolicy: defaultPolicyRule.adjustment_policy
  });
  assert.equal(pauseFinalDecision.action, 'pause');
  assert.equal(pauseFinalDecision.changeRatio, -1);
  assert.equal(pauseFinalDecision.executionActions.length, 0);

  const highSpendFinalDecision = finalizeBudgetDecisionPlan({
    decision: {
      action: 'increase',
      changeRatio: 0.2,
      confidence: 0.85,
      reasonCode: 'test_uptrend',
      volumeTier: 'high'
    },
    scenarioTags: ['high_spend_uptrend_expandable'],
    adjustmentPolicy: {
      default_increase_ratio: 0.1,
      default_decrease_ratio: 0.25,
      high_spend_uptrend_increase_ratio: 0.3
    }
  });
  assert.equal(highSpendFinalDecision.action, 'increase');
  assert.equal(highSpendFinalDecision.changeRatio, 0.3);
  assert.deepEqual(
    highSpendFinalDecision.executionActions.map((item) => item.code),
    ['raise_roas_target', 'scale_gradually']
  );

  const defaultDecreaseDecision = finalizeBudgetDecisionPlan({
    decision: {
      action: 'decrease',
      changeRatio: -0.2,
      confidence: 0.7,
      reasonCode: 'test_reduce',
      volumeTier: 'medium'
    },
    scenarioTags: [],
    adjustmentPolicy: null
  });
  assert.equal(defaultDecreaseDecision.changeRatio, -0.2);

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
  assert.ok(supportSummary.notes.some((note) => note.includes('已支持和同类对象比较表现')));
  assert.ok(supportSummary.notes.some((note) => note.includes('按国家单独设置阈值')));
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

  assert.throws(
    () =>
      validateRecommendationPolicyRule({
        metric_family: 'relative_compare',
        decision_mode: 'deterministic',
        traffic_scope: 'all',
        relative_compare: {
          metrics: []
        }
      }),
    (error: unknown) =>
      error instanceof RecommendationPolicyValidationError && error.code === 'invalid_relative_compare'
  );

  const asaTemplate = createPolicyTemplate({ platform: 'ios', appKey: 'demo', engine: 'asa' }, 'recommended');
  assert.equal(asaTemplate.trafficScope, 'asa_only');
  assert.deepEqual(asaTemplate.contextWindowDays, [7, 14, 21]);

  const keywordValueRows = buildKeywordValueRows(
    'demo',
    [
      {
        report_date: '2026-03-20',
        app_key: 'demo',
        platform: 'android',
        campaign: 'camera exact',
        media_source: 'googleadwords_int',
        country: 'US',
        impressions: '1000',
        installs: '10',
        clicks: '100',
        total_cost: '50',
        average_ecpi: '5',
        source_report: 'daily_report_v5'
      }
    ],
    [
      {
        install_date: '2026-03-20',
        app_key: 'demo',
        platform: 'android',
        media_source: 'googleadwords_int',
        country: 'US',
        campaign: 'camera exact',
        raw_event_count: 4,
        purchase_count: 2,
        revenue_d7: 80
      }
    ],
    123,
    new Map()
  );
  assert.equal(keywordValueRows.length, 1);
  assert.equal(keywordValueRows[0].keyword, 'camera exact');
  assert.equal(keywordValueRows[0].purchase_count, 2);
  assert.equal(keywordValueRows[0].revenue_d7, 80);
  assert.equal(keywordValueRows[0].revenue_source_missing, 0);
  assert.equal(keywordValueRows[0].cpp, 25);
  assert.equal(keywordValueRows[0].d7_roas, 1.6);
  assert.equal(keywordValueRows[0].ctr, 0.1);

  const keywordValueRowsWithoutSource = buildKeywordValueRows(
    'demo',
    [
      {
        report_date: '2026-03-20',
        app_key: 'demo',
        platform: 'android',
        campaign: 'camera exact',
        media_source: 'googleadwords_int',
        country: 'US',
        impressions: '1000',
        installs: '10',
        clicks: '100',
        total_cost: '50',
        average_ecpi: '5',
        source_report: 'daily_report_v5'
      }
    ],
    [],
    123,
    new Map()
  );
  assert.equal(keywordValueRowsWithoutSource.length, 1);
  assert.equal(keywordValueRowsWithoutSource[0].purchase_count, 0);
  assert.equal(keywordValueRowsWithoutSource[0].revenue_d7, 0);
  assert.equal(keywordValueRowsWithoutSource[0].revenue_source_missing, 1);
  assert.equal(keywordValueRowsWithoutSource[0].cpp, 0);
  assert.equal(keywordValueRowsWithoutSource[0].d7_roas, 0);

  assert.throws(
    () =>
      validateRecommendationPolicyRule({
        metric_family: 'ecpi',
        decision_mode: 'deterministic',
        traffic_scope: 'all',
        maturity_window: {
          exclude_recent_days: 7,
          decision_window_days: 14,
          context_window_days: [7.9]
        }
      }),
    (error: unknown) =>
      error instanceof RecommendationPolicyValidationError &&
      error.code === 'invalid_window' &&
      /整数/.test(error.message)
  );

  const contextPrompt = buildAiContextPrompt([
    {
      type: 'metrics_trend',
      templateId: 'media_source',
      title: '上下文包一',
      summaryMarkdown: 'A'.repeat(9000),
      structured: { duplicated: true },
      rowCount: 20,
      truncated: false,
      appliedFilters: {
        appKey: 'demo',
        platform: 'ios'
      }
    },
    {
      type: 'budget_summary',
      templateId: 'keyword',
      title: '上下文包二',
      summaryMarkdown: 'B'.repeat(9000),
      structured: { duplicated: true },
      rowCount: 18,
      truncated: false,
      appliedFilters: {
        appKey: 'demo',
        platform: 'ios'
      }
    },
    {
      type: 'asa_keyword_summary',
      templateId: 'stage',
      title: '上下文包三',
      summaryMarkdown: 'C'.repeat(9000),
      structured: { duplicated: true },
      rowCount: 12,
      truncated: false,
      appliedFilters: {
        appKey: 'demo',
        platform: 'ios'
      }
    }
  ]);
  assert.ok(contextPrompt.prompt.includes('上下文包一'));
  assert.ok(!contextPrompt.prompt.includes('结构化摘要'));
  assert.ok(contextPrompt.warnings.some((item) => /截短|跳过/.test(item)));

  const mergedRule = mergeRecommendationPolicyRule(
    {
      metric_family: 'ecpi',
      decision_mode: 'deterministic',
      traffic_scope: 'all',
      custom_branch: {
        keep_me: true
      },
      targets: {
        global_targets: {
          ecpi_max: 6
        }
      }
    },
    {
      ...createPolicyTemplate({ platform: 'ios', appKey: 'demo', engine: 'budget' }, 'blank'),
      globalTargets: {
        ecpi_max: '3',
        roas_min: '',
        roas_good: '',
        cpp_max: '',
        cpp_pause_threshold: ''
      }
    }
  );
  assert.equal(mergedRule.targets.global_targets.ecpi_max, 3);
  assert.equal('roas_min' in mergedRule.targets.global_targets, false);
  assert.deepEqual(mergedRule.custom_branch, { keep_me: true });

  const sanitizedRelativeDraft = sanitizeRecommendationPolicyDraft(
    {
      ...createPolicyTemplate({ platform: 'ios', appKey: 'demo', engine: 'budget' }, 'recommended'),
      metricFamily: 'relative_compare',
      globalTargets: {
        ecpi_max: '2.8',
        roas_min: '0.3',
        roas_good: '',
        cpp_max: '40',
        cpp_pause_threshold: ''
      },
      countryTargets: [
        {
          id: 'country_1',
          key: 'US',
          ecpi_max: '3',
          roas_min: '0.3',
          roas_good: '',
          cpp_max: '',
          cpp_pause_threshold: ''
        }
      ]
    },
    'relative_compare'
  );
  assert.deepEqual(sanitizedRelativeDraft.countryTargets, []);
  assert.equal(sanitizedRelativeDraft.globalTargets.ecpi_max, '');
  assert.equal(sanitizedRelativeDraft.globalTargets.roas_min, '');

  const mergedRelativeRule = mergeRecommendationPolicyRule(
    {
      targets: {
        global_targets: {
          ecpi_max: 3
        },
        country_targets: {
          US: {
            ecpi_max: 3
          }
        }
      }
    },
    {
      ...createPolicyTemplate({ platform: 'ios', appKey: 'demo', engine: 'budget' }, 'blank'),
      metricFamily: 'relative_compare',
      relativeCompare: {
        metrics: ['ctr'],
        underperform_ratio: '0.2',
        min_peer_count: '3',
        min_failed_metrics: '2'
      }
    }
  );
  assert.deepEqual(mergedRelativeRule.targets.global_targets, {});
  assert.equal('country_targets' in mergedRelativeRule.targets, false);
  assert.deepEqual(mergedRelativeRule.relative_compare.metrics, ['ctr']);

  const businessSummary = buildRecommendationPolicyTableSummary({
    rule_json: {
      metric_family: 'relative_compare',
      traffic_scope: 'media_sources',
      media_sources: ['Apple Search Ads', 'Meta'],
      relative_compare: {
        metrics: ['ctr', 'roas'],
        underperform_ratio: 0.2,
        min_peer_count: 3
      }
    },
    effective_support: {
      automation_level: 'partial',
      notes: ['当前按 campaign 做同类对比']
    }
  });
  assert.equal(businessSummary.objective, '按同类对比表现判断是否调控');
  assert.match(businessSummary.scope, /Apple Search Ads/);
  assert.equal(businessSummary.supportLabel, '部分支持');
  assert.equal(businessSummary.supportNote, '当前按 campaign 做同类对比');

  assert.equal(
    getRecommendationPolicyErrorMessage('invalid_media_sources'),
    '已选择指定媒体源，但媒体源列表为空，请至少添加一个媒体源。'
  );
  assert.equal(
    getRecommendationPolicyErrorMessage('app_platform_not_supported'),
    '当前应用不支持这个平台，请重新选择应用或平台。'
  );
  assert.equal(getRecommendationPolicyErrorMessage('asa_requires_ios'), 'ASA 规则只支持 iOS，请改为 iOS 后再保存。');

  const mockedPolicyRouter = createRecommendationPoliciesRouter({
    getAppByKey: async () =>
      ({
        id: 1,
        app_key: 'demo',
        display_name: 'Demo',
        ios_display_name: null,
        android_display_name: null,
        pull_app_id: 'demo-ios-id',
        ios_pull_app_id: 'demo-ios-id',
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
      error: 'invalid_platform',
      message: '当前平台无效，请重新选择平台。'
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

    const invalidAsaPlatformResponse = await fetch(`${baseUrl}/api/recommendation-policies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appKey: 'demo',
        platform: 'android',
        engine: 'asa',
        ruleJson: {
          metric_family: 'ecpi',
          decision_mode: 'deterministic',
          traffic_scope: 'all'
        }
      })
    });
    assert.equal(invalidAsaPlatformResponse.status, 400);
    assert.deepEqual(await invalidAsaPlatformResponse.json(), {
      ok: false,
      error: 'asa_requires_ios',
      message: 'ASA 规则只支持 iOS，请改为 iOS 后再保存。'
    });
  });

  const unsupportedPlatformRouter = createRecommendationPoliciesRouter({
    getAppByKey: async () =>
      ({
        id: 2,
        app_key: 'ios-only',
        display_name: 'iOS Only',
        ios_display_name: 'iOS Only',
        android_display_name: null,
        pull_app_id: '123',
        ios_pull_app_id: '123',
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

  await withHttpApi(unsupportedPlatformRouter, async (baseUrl) => {
    const unsupportedResponse = await fetch(`${baseUrl}/api/recommendation-policies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        appKey: 'ios-only',
        platform: 'android',
        engine: 'budget',
        ruleJson: {
          metric_family: 'ecpi',
          decision_mode: 'deterministic',
          traffic_scope: 'all'
        }
      })
    });
    assert.equal(unsupportedResponse.status, 400);
    assert.deepEqual(await unsupportedResponse.json(), {
      ok: false,
      error: 'app_platform_not_supported',
      message: '当前应用不支持这个平台，请重新选择应用或平台。'
    });
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
      error: 'app_not_found',
      message: '未找到对应应用，请先检查应用是否已在应用设置里创建。'
    });
  });

  console.log('review_regression_smoke_passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
