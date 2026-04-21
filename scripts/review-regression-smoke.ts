import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { createAiRouter } from '../apps/api/src/modules/ai/ai.routes.js';
import { createHealthRouter } from '../apps/api/src/modules/health/health.routes.js';
import { createGuruMcpApp } from '../apps/mcp-server/src/server.js';
import { createRecommendationPoliciesRouter } from '../apps/api/src/modules/recommendationPolicies/recommendationPolicies.routes.js';
import {
  createPolicyTemplate,
  sanitizeRecommendationPolicyDraft,
  mergeRecommendationPolicyRule,
  buildRecommendationPolicyTableSummary,
  getRecommendationPolicyErrorMessage
} from '../apps/api/src/modules/ui/public/recommendationPolicyWizard.js';
import {
  aggregateBudgetCountryWindowFacts,
  finalizeBudgetDecisionPlan,
  summarizeBudgetValueCoverage
} from '../packages/shared/utils/budgetAdvisor.js';
import {
  classifyAppsflyerHttpFailure,
  classifyAppsflyerTransportFailure
} from '../packages/shared/utils/appsflyerRequest.js';
import { resolveManualBitableExportHttpResult, type BitableExportRunResult } from '../packages/shared/utils/bitableExport.js';
import { shouldUpsertFeedbackRow } from '../packages/shared/utils/recommendationFeedback.js';
import {
  buildAsaContextWindow,
  buildAsaDecisionWindow,
  buildAsaRoasWindow,
  buildAsaRelativeCompareDecision
} from '../packages/shared/utils/asaKeywords.js';
import {
  buildAiChatToolDefinitionsForModel,
  buildAiContextPrompt,
  normalizeGuruToolName,
  runAiChat
} from '../packages/shared/utils/aiChat.js';
import { env } from '../packages/shared/config/env.js';
import { GURU_MCP_TOOL_NAMES, resolveGuruMcpToolForContextPack } from '../packages/shared/utils/guruMcp.js';
import {
  buildMatureRoasWindow,
  isRoasDataDisplayableStatus,
  isRoasDataUsableStatus,
  resolveRoasDataStatus
} from '../packages/shared/utils/roasWindow.js';
import {
  didKeywordEngineCycleComplete,
  resolveKeywordEngineBackfillDays
} from '../packages/shared/utils/keywordEngineWorkerPolicy.js';
import { summarizeAsaKeywordCycleStatus } from '../packages/shared/utils/asaKeywordWorkerPolicy.js';
import {
  buildKeywordValueCohortWindows,
  buildKeywordValueRows,
  mergeKeywordValueRevenueRows
} from '../packages/shared/utils/keywordEngine.js';
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
    source_type: 'delivery_actions_non_asa',
    label: '非 ASA 执行表',
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
    source_type: 'delivery_actions_non_asa',
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

async function withHttpApp<T>(
  app: express.Express,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
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

async function initializeMcpSession(baseUrl: string): Promise<{ sessionId: string; protocolVersion: string }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${env.mcp.internalToken}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'review-regression-smoke',
          version: '1.0.0'
        }
      }
    })
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { result?: { protocolVersion?: string } };
  const sessionId = response.headers.get('mcp-session-id');
  assert.equal(typeof sessionId, 'string');
  assert.ok(sessionId);
  const protocolVersion = payload.result?.protocolVersion ?? LATEST_PROTOCOL_VERSION;
  const initialized = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${env.mcp.internalToken}`,
      'mcp-session-id': sessionId as string,
      'mcp-protocol-version': protocolVersion
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    })
  });
  assert.equal(initialized.status, 202);
  return {
    sessionId: sessionId as string,
    protocolVersion
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
  const defaultAsaDecisionWindow = buildAsaDecisionWindow('2026-04-02', null);
  assert.deepEqual(defaultAsaDecisionWindow, {
    from: '2026-03-13',
    to: '2026-03-26'
  });
  const asaContextWindow = buildAsaContextWindow('2026-03-31', validatedPolicy);
  assert.deepEqual(asaContextWindow, {
    from: '2026-03-11',
    to: '2026-03-31'
  });
  const asaRoasWindow = buildAsaRoasWindow('2026-03-31', {
    ...validatedPolicy,
    maturity_window: {
      ...validatedPolicy.maturity_window,
      exclude_recent_days: 0,
      decision_window_days: 5
    }
  });
  assert.deepEqual(asaRoasWindow, {
    from: '2026-03-20',
    to: '2026-03-24'
  });
  const matureBudgetRoasWindow = buildMatureRoasWindow('2026-04-02', null);
  assert.deepEqual(matureBudgetRoasWindow, {
    from: '2026-03-13',
    to: '2026-03-26'
  });
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: true,
      hasSpend: true,
      coveredCost: 80,
      missingCost: 20
    }),
    'partial'
  );
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: true,
      hasSpend: true,
      coveredCost: 79,
      missingCost: 21
    }),
    'partial_low'
  );
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: true,
      hasSpend: true,
      coveredCost: 40,
      missingCost: 60
    }),
    'partial_low'
  );
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: true,
      hasSpend: true,
      coveredCost: 39,
      missingCost: 61
    }),
    'pending'
  );
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: true,
      hasSpend: true,
      coveredCost: 20,
      missingCost: 80
    }),
    'pending'
  );
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: false,
      hasSpend: false,
      coveredCost: 0,
      missingCost: 0
    }),
    'unavailable'
  );
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: true,
      hasSpend: true,
      coveredCost: 100,
      missingCost: 0
    }),
    'complete'
  );
  assert.equal(isRoasDataUsableStatus('partial_low'), false);
  assert.equal(isRoasDataDisplayableStatus('partial_low'), true);
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

  const partialValueCoverage = summarizeBudgetValueCoverage([
    {
      total_cost: 40,
      purchase_count: 2,
      revenue_d7: 60,
      d7_roas: 1.5,
      revenue_source_missing: 0
    },
    {
      total_cost: 20,
      purchase_count: 0,
      revenue_d7: 0,
      d7_roas: 0,
      revenue_source_missing: 1
    }
  ]);
  assert.equal(partialValueCoverage.coverageMissing, true);
  assert.equal(partialValueCoverage.currentRoas, 1.5);
  assert.equal(partialValueCoverage.currentCpp, 20);
  assert.equal(partialValueCoverage.coveredRows.length, 1);
  assert.equal(partialValueCoverage.coveredCost, 40);
  assert.equal(partialValueCoverage.missingCost, 20);
  assert.equal(partialValueCoverage.coverageRatio, 40 / 60);
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: true,
      hasSpend: true,
      coveredCost: partialValueCoverage.coveredCost,
      missingCost: partialValueCoverage.missingCost
    }),
    'partial_low'
  );

  const thresholdValueCoverage = summarizeBudgetValueCoverage([
    {
      total_cost: 80,
      purchase_count: 4,
      revenue_d7: 100,
      d7_roas: 1.25,
      revenue_source_missing: 0
    },
    {
      total_cost: 20,
      purchase_count: 0,
      revenue_d7: 0,
      d7_roas: 0,
      revenue_source_missing: 1
    }
  ]);
  assert.equal(thresholdValueCoverage.currentRoas, 1.25);
  assert.equal(thresholdValueCoverage.currentCpp, 20);
  assert.equal(thresholdValueCoverage.coveredCost, 80);
  assert.equal(thresholdValueCoverage.missingCost, 20);
  assert.equal(thresholdValueCoverage.coverageRatio, 0.8);
  assert.equal(
    resolveRoasDataStatus({
      hasWindowRows: true,
      hasSpend: true,
      coveredCost: thresholdValueCoverage.coveredCost,
      missingCost: thresholdValueCoverage.missingCost
    }),
    'partial'
  );

  const completeValueCoverage = summarizeBudgetValueCoverage([
    {
      total_cost: 40,
      purchase_count: 2,
      revenue_d7: 60,
      d7_roas: 1.5,
      revenue_source_missing: 0
    }
  ]);
  assert.equal(completeValueCoverage.coverageMissing, false);
  assert.equal(completeValueCoverage.currentRoas, 1.5);
  assert.equal(completeValueCoverage.currentCpp, 20);
  assert.equal(completeValueCoverage.coverageRatio, 1);

  const revenueBasedCoverage = summarizeBudgetValueCoverage([
    {
      total_cost: 100,
      purchase_count: 4,
      revenue_d7: 200,
      d7_roas: 99,
      revenue_source_missing: 0
    },
    {
      total_cost: 50,
      purchase_count: 2,
      revenue_d7: 25,
      d7_roas: 77,
      revenue_source_missing: 0
    }
  ]);
  assert.equal(revenueBasedCoverage.currentRoas, 1.5);
  assert.equal(revenueBasedCoverage.currentCpp, 25);

  const zeroAfRoasCoverage = summarizeBudgetValueCoverage([
    {
      total_cost: 100,
      purchase_count: 0,
      revenue_d7: 0,
      d7_roas: 0,
      revenue_source_missing: 0,
      af_cohort_roas: 0,
      af_cohort_roas_missing: 0
    },
    {
      total_cost: 100,
      purchase_count: 2,
      revenue_d7: 200,
      d7_roas: 2,
      revenue_source_missing: 0,
      af_cohort_roas: 2,
      af_cohort_roas_missing: 0
    }
  ]);
  assert.equal(zeroAfRoasCoverage.afCohortRoas, 1);
  assert.equal(zeroAfRoasCoverage.localDerivedRoas, 1);
  assert.equal(zeroAfRoasCoverage.currentRoas, 1);
  assert.equal(zeroAfRoasCoverage.roasPrimarySource, 'af_cohort');
  assert.equal(zeroAfRoasCoverage.roasWarningCode, 'none');

  assert.equal(resolveKeywordEngineBackfillDays(false, 30, 3), 30);
  assert.equal(resolveKeywordEngineBackfillDays(true, 30, 3), 3);
  assert.equal(didKeywordEngineCycleComplete({ failed_count: 0 }), true);
  assert.equal(didKeywordEngineCycleComplete({ failed_count: 1 }), false);
  assert.equal(
    summarizeAsaKeywordCycleStatus({
      failed_slice_count: 1,
      retryable_failed_slice_count: 0,
      terminal_failed_slice_count: 1
    }),
    'success'
  );
  assert.equal(
    summarizeAsaKeywordCycleStatus({
      failed_slice_count: 1,
      retryable_failed_slice_count: 1,
      terminal_failed_slice_count: 0
    }),
    'failed'
  );

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
        revenue_d7: 80,
        af_cohort_roas: 1.7,
        revenue_source_complete: true,
        af_cohort_roas_complete: true
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

  const cohortWindows = buildKeywordValueCohortWindows('2026-03-01', '2026-04-08', '2026-04-08');
  assert.deepEqual(cohortWindows, [
    { from: '2026-03-01', to: '2026-03-31' },
    { from: '2026-04-01', to: '2026-04-01' }
  ]);
  assert.deepEqual(buildKeywordValueCohortWindows('2026-04-02', '2026-04-08', '2026-04-08'), []);

  const mergedValueRevenueRows = mergeKeywordValueRevenueRows([
    [
      {
        install_date: '2026-03-20',
        app_key: 'demo',
        platform: 'android',
        media_source: 'GoogleAdwords_Int',
        country: 'US',
        campaign: 'camera exact',
        raw_event_count: 5,
        purchase_count: 3,
        revenue_d7: 90,
        af_cohort_roas: 0,
        revenue_source_complete: false,
        af_cohort_roas_complete: false
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
        purchase_count: 0,
        revenue_d7: 0,
        af_cohort_roas: 1.8,
        revenue_source_complete: false,
        af_cohort_roas_complete: true
      }
    ]
  ]);
  const mergedExactCountry = mergedValueRevenueRows.find((row) => row.country === 'US');
  assert.equal(mergedValueRevenueRows.length, 1);
  assert.equal(mergedExactCountry?.purchase_count, 3);
  assert.equal(mergedExactCountry?.revenue_d7, 90);
  assert.equal(mergedExactCountry?.af_cohort_roas, 1.8);
  assert.equal(mergedExactCountry?.revenue_source_complete, false);
  assert.equal(mergedExactCountry?.af_cohort_roas_complete, true);

  const keywordValueRowsUnknownCountry = buildKeywordValueRows(
    'demo',
    [
      {
        report_date: '2026-03-20',
        app_key: 'demo',
        platform: 'android',
        campaign: 'camera exact',
        media_source: 'googleadwords_int',
        country: 'unknown',
        impressions: '1000',
        installs: '10',
        clicks: '100',
        total_cost: '50',
        average_ecpi: '5',
        source_report: 'daily_report_v5'
      }
    ],
    mergedValueRevenueRows,
    123,
    new Map()
  );
  assert.equal(keywordValueRowsUnknownCountry.length, 1);
  assert.equal(keywordValueRowsUnknownCountry[0].revenue_source_missing, 1);
  assert.equal(keywordValueRowsUnknownCountry[0].purchase_count, 3);
  assert.equal(keywordValueRowsUnknownCountry[0].revenue_d7, 90);
  assert.equal(keywordValueRowsUnknownCountry[0].d7_roas, 0);

  const keywordValueRowsMixedCountry = buildKeywordValueRows(
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
      },
      {
        report_date: '2026-03-20',
        app_key: 'demo',
        platform: 'android',
        campaign: 'camera exact',
        media_source: 'googleadwords_int',
        country: 'unknown',
        impressions: '200',
        installs: '2',
        clicks: '20',
        total_cost: '10',
        average_ecpi: '5',
        source_report: 'daily_report_v5'
      }
    ],
    mergedValueRevenueRows,
    123,
    new Map()
  );
  const mixedUsRow = keywordValueRowsMixedCountry.find((row) => row.country === 'US');
  const mixedUnknownRow = keywordValueRowsMixedCountry.find((row) => row.country === 'unknown');
  assert.equal(mixedUsRow?.purchase_count, 3);
  assert.equal(mixedUnknownRow?.purchase_count, 0);
  assert.equal(mixedUnknownRow?.revenue_source_missing, 1);

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
  assert.deepEqual(
    buildAiChatToolDefinitionsForModel('openai_gpt54').map((item) => item.function.name),
    ['apps_list', 'metrics_get_trend', 'roas_get_summary', 'budget_get_summary', 'asa_keywords_get_summary']
  );
  assert.deepEqual(
    buildAiChatToolDefinitionsForModel('openrouter_kimi_k25').map((item) => item.function.name),
    ['apps_list', 'metrics_get_trend', 'roas_get_summary', 'budget_get_summary', 'asa_keywords_get_summary']
  );
  assert.deepEqual(
    buildAiChatToolDefinitionsForModel('qwen').map((item) => item.function.name),
    Object.values(GURU_MCP_TOOL_NAMES)
  );
  assert.equal(normalizeGuruToolName('budget_get_summary'), GURU_MCP_TOOL_NAMES.budgetGetSummary);
  assert.equal(normalizeGuruToolName('roas_get_summary'), GURU_MCP_TOOL_NAMES.roasGetSummary);
  assert.equal(normalizeGuruToolName('metrics.get_trend'), GURU_MCP_TOOL_NAMES.metricsGetTrend);

  const toolCallsCaptured: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const completionToolNamesCaptured: string[][] = [];
  let toolStepIndex = 0;
  const toolCallResult = await runAiChat(
    {
      message: '最近预算面板里哪个媒体源最值得先处理？',
      history: [],
      contextPacks: [],
      images: [],
      modelId: 'openai_gpt54',
      pageContext: {
        activeSection: 'section-budget',
        pageLabel: '预算建议',
        defaults: {
          appKey: 'demo_app',
          platform: 'ios',
          from: '2026-03-01',
          to: '2026-03-14'
        },
        currentFilters: {
          status: 'pending'
        },
        recommendedSpecs: [
          {
            type: 'budget_summary',
            templateId: 'platform_media_source',
            appKey: 'demo_app',
            platform: 'ios',
            from: '2026-03-01',
            to: '2026-03-14',
            status: 'pending'
          }
        ],
        coreSpecs: []
      }
    },
    {
      buildAiContextPacksViaMcp: async () => ({ packs: [], packSpecs: [], warnings: [] }),
      callGuruMcpTool: async (toolName, args) => {
        toolCallsCaptured.push({
          toolName,
          args
        });
        return {
          title: '预算建议 · 平台 / 媒体源',
          summary_markdown: '### 预算建议包\n- Top 聚合：Meta / ios（4 条）',
          structured: {},
          row_count: 1,
          truncated: false,
          applied_filters: args
        };
      },
      requestCompletion: async (input) => {
        completionToolNamesCaptured.push(Array.isArray(input.tools) ? input.tools.map((item) => item.function.name) : []);
        toolStepIndex += 1;
        if (toolStepIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'tool-1',
                name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
                rawArguments: JSON.stringify({
                  templateId: 'platform_media_source',
                  status: 'pending'
                }),
                arguments: {
                  templateId: 'platform_media_source',
                  status: 'pending'
                }
              }
            ],
            usage: null,
            raw: {},
            rawMessage: {
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
                    arguments: JSON.stringify({
                      templateId: 'platform_media_source',
                      status: 'pending'
                    })
                  }
                }
              ]
            }
          };
        }
        return {
          content: '结论：Meta 需要优先处理。\n关键证据：当前 pending 建议主要集中在 Meta。',
          toolCalls: [],
          usage: null,
          raw: {},
          rawMessage: {}
        };
      }
    } as never
  );
  assert.equal(toolCallResult.agent_action, 'answer');
  assert.equal(toolCallsCaptured.length, 1);
  assert.equal(toolCallsCaptured[0]?.toolName, GURU_MCP_TOOL_NAMES.budgetGetSummary);
  assert.equal(toolCallsCaptured[0]?.args.appKey, 'demo_app');
  assert.deepEqual(completionToolNamesCaptured[0], Object.values(GURU_MCP_TOOL_NAMES));
  assert.equal(toolCallResult.page_trace.length, 0);
  assert.equal(toolCallResult.tool_trace[0]?.title, '预算建议 · 平台 / 媒体源');

  const inferredDateToolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let inferredDateStepIndex = 0;
  await runAiChat(
    {
      message: '现在帮我查一下4.2的Novix安装量',
      history: [],
      contextPacks: [],
      images: [],
      modelId: 'openrouter_kimi_k25',
      pageContext: {
        activeSection: 'section-metrics',
        pageLabel: '指标趋势',
        defaults: {
          appKey: 'ai-seek',
          platform: 'ios',
          from: '2026-03-25',
          to: '2026-04-07'
        },
        recommendedSpecs: [
          {
            type: 'metrics_trend',
            templateId: 'media_source',
            appKey: 'ai-seek',
            platform: 'ios',
            from: '2026-03-25',
            to: '2026-04-07',
            source: 'pull',
            metric: 'installs'
          }
        ],
        coreSpecs: []
      }
    },
    {
      buildAiContextPacksViaMcp: async () => ({ packs: [], packSpecs: [], warnings: [] }),
      callGuruMcpTool: async (toolName, args) => {
        inferredDateToolCalls.push({
          toolName,
          args
        });
        return {
          title: '指标时序 · 媒体源',
          summary_markdown: '### 指标时序包\n- 时间范围：2026-04-02 ~ 2026-04-02',
          structured: {},
          row_count: 1,
          truncated: false,
          applied_filters: args
        };
      },
      requestCompletion: async () => {
        inferredDateStepIndex += 1;
        if (inferredDateStepIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'tool-date-1',
                name: GURU_MCP_TOOL_NAMES.metricsGetTrend,
                rawArguments: JSON.stringify({
                  appKey: 'ai-seek',
                  templateId: 'media_source',
                  source: 'pull',
                  metric: 'installs',
                  from: '2025-04-02',
                  to: '2025-04-02'
                }),
                arguments: {
                  appKey: 'ai-seek',
                  templateId: 'media_source',
                  source: 'pull',
                  metric: 'installs',
                  from: '2025-04-02',
                  to: '2025-04-02'
                }
              }
            ],
            usage: null,
            raw: {},
            rawMessage: {
              tool_calls: [
                {
                  id: 'tool-date-1',
                  type: 'function',
                  function: {
                    name: 'metrics_get_trend',
                    arguments: JSON.stringify({
                      appKey: 'ai-seek',
                      templateId: 'media_source',
                      source: 'pull',
                      metric: 'installs',
                      from: '2025-04-02',
                      to: '2025-04-02'
                    })
                  }
                }
              ]
            }
          };
        }
        return {
          content: '结论：4 月 2 日安装量已查询。',
          toolCalls: [],
          usage: null,
          raw: {},
          rawMessage: {}
        };
      }
    } as never
  );
  assert.equal(inferredDateToolCalls.length, 1);
  assert.equal(inferredDateToolCalls[0]?.toolName, GURU_MCP_TOOL_NAMES.metricsGetTrend);
  assert.equal(inferredDateToolCalls[0]?.args.from, '2026-04-02');
  assert.equal(inferredDateToolCalls[0]?.args.to, '2026-04-02');

  const roasToolCallsCaptured: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let roasSystemPrompt = '';
  let roasStepIndex = 0;
  const roasResult = await runAiChat(
    {
      message: '帮我看看昨天的ROAS数据喵>w<',
      history: [],
      contextPacks: [],
      images: [],
      modelId: 'openai_gpt54',
      pageContext: {
        activeSection: 'section-overview',
        pageLabel: '概览',
        defaults: {
          appKey: 'demo_app',
          platform: 'ios',
          from: '2026-04-08',
          to: '2026-04-08'
        },
        currentFilters: {},
        recommendedSpecs: [],
        coreSpecs: []
      }
    },
    {
      buildAiContextPacksViaMcp: async () => ({ packs: [], packSpecs: [], warnings: [] }),
      callGuruMcpTool: async (toolName, args) => {
        roasToolCallsCaptured.push({
          toolName,
          args
        });
        return {
          title: '指标时序 · 媒体源',
          summary_markdown: '### 指标时序包\n- 收入已自动切换为 push 口径查询。',
          structured: {},
          row_count: 1,
          truncated: false,
          applied_filters: args
        };
      },
      requestCompletion: async (input) => {
        if (!roasSystemPrompt && typeof input.messages[0]?.content === 'string') {
          roasSystemPrompt = input.messages[0].content;
        }
        roasStepIndex += 1;
        if (roasStepIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'tool-roas-revenue',
                name: GURU_MCP_TOOL_NAMES.metricsGetTrend,
                rawArguments: JSON.stringify({
                  templateId: 'media_source',
                  metric: 'revenue',
                  source: 'pull'
                }),
                arguments: {
                  templateId: 'media_source',
                  metric: 'revenue',
                  source: 'pull'
                }
              }
            ],
            usage: null,
            raw: {},
            rawMessage: {
              tool_calls: [
                {
                  id: 'tool-roas-revenue',
                  type: 'function',
                  function: {
                    name: GURU_MCP_TOOL_NAMES.metricsGetTrend,
                    arguments: JSON.stringify({
                      templateId: 'media_source',
                      metric: 'revenue',
                      source: 'pull'
                    })
                  }
                }
              ]
            }
          };
        }
        return {
          content: '结论：昨日收入已按 push 口径查询，可以继续结合 cost 估算 ROAS。',
          toolCalls: [],
          usage: null,
          raw: {},
          rawMessage: {}
        };
      }
    } as never
  );
  assert.equal(roasResult.agent_action, 'answer');
  assert.equal(roasToolCallsCaptured[0]?.toolName, GURU_MCP_TOOL_NAMES.metricsGetTrend);
  assert.equal(roasToolCallsCaptured[0]?.args.source, 'push');
  assert.equal(roasToolCallsCaptured[0]?.args.metric, 'revenue');
  assert.equal(roasToolCallsCaptured[0]?.args.from, '2026-04-08');
  assert.equal(roasToolCallsCaptured[0]?.args.to, '2026-04-08');
  assert.match(roasSystemPrompt, /不要把 ROAS 当成可直接查询的 metric/);
  assert.match(roasSystemPrompt, /优先使用 roas.get_summary/);
  assert.match(roasSystemPrompt, /数据缺失或未回传/);

  const matureRoasToolCallsCaptured: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let matureRoasStepIndex = 0;
  let matureRoasSystemPrompt = '';
  const matureRoasResult = await runAiChat(
    {
      message: '按简报口径帮我看昨天的 ROAS',
      history: [],
      contextPacks: [],
      images: [],
      modelId: 'openai_gpt54',
      pageContext: {
        activeSection: 'section-dashboard',
        pageLabel: '投放总览',
        defaults: {
          appKey: 'demo_app',
          platform: 'ios',
          from: '2026-04-08',
          to: '2026-04-08'
        },
        currentFilters: {},
        recommendedSpecs: [],
        coreSpecs: []
      }
    },
    {
      buildAiContextPacksViaMcp: async () => ({ packs: [], packSpecs: [], warnings: [] }),
      callGuruMcpTool: async (toolName, args) => {
        matureRoasToolCallsCaptured.push({ toolName, args });
        return {
          title: '成熟窗口 ROAS',
          summary_markdown:
            '### 成熟窗口 ROAS\n- 报告日期：2026-04-08\n- 时间窗口：2026-04-01 至 2026-04-07\n- 当前 ROAS：123.00%',
          structured: {
            reportDate: '2026-04-08',
            summary: {
              roasWindow: {
                from: '2026-04-01',
                to: '2026-04-07'
              },
              currentRoas: 1.23
            }
          },
          row_count: 1,
          truncated: false,
          applied_filters: args
        };
      },
      requestCompletion: async (input) => {
        if (!matureRoasSystemPrompt && typeof input.messages[0]?.content === 'string') {
          matureRoasSystemPrompt = input.messages[0].content;
        }
        matureRoasStepIndex += 1;
        if (matureRoasStepIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'tool-mature-roas',
                name: GURU_MCP_TOOL_NAMES.roasGetSummary,
                rawArguments: JSON.stringify({}),
                arguments: {}
              }
            ],
            usage: null,
            raw: {},
            rawMessage: {
              tool_calls: [
                {
                  id: 'tool-mature-roas',
                  type: 'function',
                  function: {
                    name: GURU_MCP_TOOL_NAMES.roasGetSummary,
                    arguments: JSON.stringify({})
                  }
                }
              ]
            }
          };
        }
        return {
          content: '结论：按 2026-04-08 报告日期、成熟窗口 2026-04-01 至 2026-04-07，ROAS 为 123.00%。',
          toolCalls: [],
          usage: null,
          raw: {},
          rawMessage: {}
        };
      }
    } as never
  );
  assert.equal(matureRoasResult.agent_action, 'answer');
  assert.equal(matureRoasToolCallsCaptured[0]?.toolName, GURU_MCP_TOOL_NAMES.roasGetSummary);
  assert.equal(matureRoasToolCallsCaptured[0]?.args.appKey, 'demo_app');
  assert.equal(matureRoasToolCallsCaptured[0]?.args.scope, 'budget');
  assert.equal(matureRoasToolCallsCaptured[0]?.args.platform, 'ios');
  assert.equal(matureRoasToolCallsCaptured[0]?.args.reportDate, '2026-04-08');
  assert.equal(matureRoasToolCallsCaptured[0]?.args.templateId, 'mature_window');
  assert.match(matureRoasSystemPrompt, /必须明确写出“报告日期”和“成熟窗口 from 至 to”/);

  const asaRoasToolCallsCaptured: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let asaRoasStepIndex = 0;
  const asaRoasResult = await runAiChat(
    {
      message: '按 ASA 简报口径帮我看昨天的 ROAS',
      history: [],
      contextPacks: [],
      images: [],
      modelId: 'openai_gpt54',
      pageContext: {
        activeSection: 'section-asa-keywords',
        pageLabel: 'ASA 关键词管理',
        defaults: {
          appKey: 'demo_app',
          platform: 'ios',
          from: '2026-04-08',
          to: '2026-04-08'
        },
        currentFilters: {},
        recommendedSpecs: [],
        coreSpecs: []
      }
    },
    {
      buildAiContextPacksViaMcp: async () => ({ packs: [], packSpecs: [], warnings: [] }),
      callGuruMcpTool: async (toolName, args) => {
        asaRoasToolCallsCaptured.push({ toolName, args });
        return {
          title: '成熟窗口 ROAS',
          summary_markdown:
            '### 成熟窗口 ROAS\n- 报告日期：2026-04-08\n- 时间窗口：2026-04-01 至 2026-04-07\n- 当前 ROAS：111.00%',
          structured: {},
          row_count: 1,
          truncated: false,
          applied_filters: args
        };
      },
      requestCompletion: async () => {
        asaRoasStepIndex += 1;
        if (asaRoasStepIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'tool-asa-roas',
                name: GURU_MCP_TOOL_NAMES.roasGetSummary,
                rawArguments: JSON.stringify({}),
                arguments: {}
              }
            ],
            usage: null,
            raw: {},
            rawMessage: {
              tool_calls: [
                {
                  id: 'tool-asa-roas',
                  type: 'function',
                  function: {
                    name: GURU_MCP_TOOL_NAMES.roasGetSummary,
                    arguments: JSON.stringify({})
                  }
                }
              ]
            }
          };
        }
        return {
          content: '结论：按 ASA 简报口径，昨天的成熟窗口 ROAS 为 111.00%。',
          toolCalls: [],
          usage: null,
          raw: {},
          rawMessage: {}
        };
      }
    } as never
  );
  assert.equal(asaRoasResult.agent_action, 'answer');
  assert.equal(asaRoasToolCallsCaptured[0]?.toolName, GURU_MCP_TOOL_NAMES.roasGetSummary);
  assert.equal(asaRoasToolCallsCaptured[0]?.args.scope, 'asa');

  const clarificationResult = await runAiChat(
    {
      message: '帮我看看最近表现',
      history: [],
      contextPacks: [],
      images: [],
      modelId: 'openai_gpt54'
    },
    {
      buildAiContextPacksViaMcp: async () => ({ packs: [], packSpecs: [], warnings: [] }),
      callGuruMcpTool: async () => {
        throw new Error('should_not_call_tool');
      },
      requestCompletion: async () => ({
        content: 'CLARIFY: 请告诉我你想看哪个应用，或者当前页面应用是哪一个？',
        toolCalls: [],
        usage: null,
        raw: {},
        rawMessage: {}
      })
    } as never
  );
  assert.equal(clarificationResult.agent_action, 'clarification');
  assert.equal(clarificationResult.reply, '请告诉我你想看哪个应用，或者当前页面应用是哪一个？');
  assert.equal(clarificationResult.clarification_count, 1);

  let failedToolStepIndex = 0;
  const degradedResult = await runAiChat(
    {
      message: '帮我分析一下当前预算建议的情况',
      history: [],
      contextPacks: [],
      images: [],
      modelId: 'openai_gpt54',
      pageContext: {
        activeSection: 'section-budget',
        pageLabel: '预算建议',
        defaults: {
          appKey: 'demo_app',
          platform: 'ios',
          from: '2026-03-01',
          to: '2026-03-14'
        },
        currentFilters: {},
        recommendedSpecs: [
          {
            type: 'budget_summary',
            templateId: 'platform_media_source',
            appKey: 'demo_app',
            platform: 'ios',
            from: '2026-03-01',
            to: '2026-03-14'
          }
        ],
        coreSpecs: []
      }
    },
    {
      buildAiContextPacksViaMcp: async () => ({ packs: [], packSpecs: [], warnings: [] }),
      callGuruMcpTool: async () => {
        throw new Error('mcp_down');
      },
      requestCompletion: async () => {
        failedToolStepIndex += 1;
        if (failedToolStepIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'tool-fail',
                name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
                rawArguments: '{}',
                arguments: {}
              }
            ],
            usage: null,
            raw: {},
            rawMessage: {
              tool_calls: [
                {
                  id: 'tool-fail',
                  type: 'function',
                  function: {
                    name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
                    arguments: '{}'
                  }
                }
              ]
            }
          };
        }
        return {
          content: '结论：当前预算数据暂时不可用，我先给你保守判断。\n关键证据：自动查询失败，请稍后重试。',
          toolCalls: [],
          usage: null,
          raw: {},
          rawMessage: {}
        };
      }
    } as never
  );
  assert.equal(degradedResult.agent_action, 'answer');
  assert.ok(degradedResult.warnings.some((item) => item.includes('查询失败，请稍后重试')));

  let manualCacheToolCalls = 0;
  let manualPackStepIndex = 0;
  const manualPackAlignedResult = await runAiChat(
    {
      message: '结合我手动附带的数据包，看看预算建议',
      history: [],
      contextPacks: [
        {
          type: 'metrics_trend',
          templateId: 'country',
          appKey: 'demo_app',
          platform: 'ios',
          from: '2026-03-01',
          to: '2026-03-14',
          source: 'pull',
          metric: 'installs'
        },
        {
          type: 'budget_summary',
          templateId: 'platform_media_source',
          appKey: 'demo_app',
          platform: 'ios',
          from: '2026-03-01',
          to: '2026-03-14'
        }
      ],
      images: [],
      modelId: 'openai_gpt54'
    },
    {
      buildAiContextPacksViaMcp: async (_specs) => ({
        packs: [
          {
            type: 'budget_summary',
            templateId: 'platform_media_source',
            title: '预算建议 · 平台 / 媒体源',
            summaryMarkdown: '### 预算建议包\n- Meta / ios 共有 4 条',
            structured: {
              groups: []
            },
            rowCount: 1,
            truncated: false,
            appliedFilters: {
              appKey: 'demo_app',
              platform: 'ios',
              from: '2026-03-01',
              to: '2026-03-14',
              templateId: 'platform_media_source'
            }
          }
        ],
        packSpecs: [
          {
            type: 'budget_summary',
            templateId: 'platform_media_source',
            appKey: 'demo_app',
            platform: 'ios',
            from: '2026-03-01',
            to: '2026-03-14'
          }
        ],
        warnings: ['「metrics_trend · country」 获取失败，已跳过这次附加。']
      }),
      callGuruMcpTool: async () => {
        manualCacheToolCalls += 1;
        throw new Error('should_not_requery_manual_pack');
      },
      requestCompletion: async () => {
        manualPackStepIndex += 1;
        if (manualPackStepIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'tool-manual-cache',
                name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
                rawArguments: JSON.stringify({
                  appKey: 'demo_app',
                  platform: 'ios',
                  from: '2026-03-01',
                  to: '2026-03-14',
                  templateId: 'platform_media_source'
                }),
                arguments: {
                  appKey: 'demo_app',
                  platform: 'ios',
                  from: '2026-03-01',
                  to: '2026-03-14',
                  templateId: 'platform_media_source'
                }
              }
            ],
            usage: null,
            raw: {},
            rawMessage: {
              tool_calls: [
                {
                  id: 'tool-manual-cache',
                  type: 'function',
                  function: {
                    name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
                    arguments: JSON.stringify({
                      appKey: 'demo_app',
                      platform: 'ios',
                      from: '2026-03-01',
                      to: '2026-03-14',
                      templateId: 'platform_media_source'
                    })
                  }
                }
              ]
            }
          };
        }
        return {
          content: '结论：Meta 需要优先处理。\n关键证据：已复用你手动附带的预算建议数据包。',
          toolCalls: [],
          usage: null,
          raw: {},
          rawMessage: {}
        };
      }
    } as never
  );
  assert.equal(manualCacheToolCalls, 0);
  assert.equal(manualPackAlignedResult.tool_trace[0]?.title, '预算建议 · 平台 / 媒体源');
  assert.ok(manualPackAlignedResult.warnings.some((item) => item.includes('已跳过这次附加')));

  let loadedContextToolCalls = 0;
  let loadedContextStepIndex = 0;
  const loadedContextResult = await runAiChat(
    {
      message: '帮我看下当前页面这组预算建议',
      history: [],
      contextPacks: [],
      images: [],
      modelId: 'openai_gpt54',
      pageContext: {
        activeSection: 'section-budget',
        pageLabel: '预算建议',
        defaults: {
          appKey: 'demo_app',
          platform: 'ios',
          from: '2026-03-01',
          to: '2026-03-14'
        },
        currentFilters: {},
        loaded_contexts: [
          {
            kind: 'budget_summary',
            title: '当前预算建议结果',
            summary_markdown: '- 当前列表：12 条\n- 待处理：4 条',
            applied_filters: {
              appKey: 'demo_app',
              platform: 'ios',
              from: '2026-03-01',
              to: '2026-03-14'
            },
            tool_hint: {
              type: 'budget_summary',
              templateId: 'platform_media_source',
              appKey: 'demo_app',
              platform: 'ios',
              from: '2026-03-01',
              to: '2026-03-14'
            }
          }
        ],
        recommendedSpecs: [
          {
            type: 'budget_summary',
            templateId: 'platform_media_source',
            appKey: 'demo_app',
            platform: 'ios',
            from: '2026-03-01',
            to: '2026-03-14'
          }
        ],
        coreSpecs: []
      }
    },
    {
      buildAiContextPacksViaMcp: async () => ({ packs: [], packSpecs: [], warnings: [] }),
      callGuruMcpTool: async () => {
        loadedContextToolCalls += 1;
        throw new Error('should_not_requery_loaded_context');
      },
      requestCompletion: async () => {
        loadedContextStepIndex += 1;
        if (loadedContextStepIndex === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'tool-loaded-context',
                name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
                rawArguments: JSON.stringify({
                  templateId: 'platform_media_source'
                }),
                arguments: {
                  templateId: 'platform_media_source'
                }
              }
            ],
            usage: null,
            raw: {},
            rawMessage: {
              tool_calls: [
                {
                  id: 'tool-loaded-context',
                  type: 'function',
                  function: {
                    name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
                    arguments: JSON.stringify({
                      templateId: 'platform_media_source'
                    })
                  }
                }
              ]
            }
          };
        }
        return {
          content: '结论：先看当前页面已经加载的预算建议结果即可。',
          toolCalls: [],
          usage: null,
          raw: {},
          rawMessage: {}
        };
      }
    } as never
  );
  assert.equal(loadedContextToolCalls, 0);
  assert.equal(loadedContextResult.page_trace[0]?.title, '当前预算建议结果');
  assert.equal(loadedContextResult.tool_trace.length, 0);

  assert.deepEqual(
    resolveGuruMcpToolForContextPack({
      type: 'budget_summary',
      templateId: 'platform_media_source',
      appKey: 'demo',
      platform: 'ios',
      from: '2026-03-01',
      to: '2026-03-07'
    }),
    {
      name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
      arguments: {
        appKey: 'demo',
        platform: 'ios',
        from: '2026-03-01',
        to: '2026-03-07',
        templateId: 'platform_media_source',
        status: undefined,
        executionStatus: undefined,
        isAdopted: undefined,
        hasManualReview: undefined
      }
    }
  );
  assert.deepEqual(
    resolveGuruMcpToolForContextPack({
      type: 'roas_summary',
      templateId: 'mature_window',
      appKey: 'demo',
      platform: 'ios',
      reportDate: '2026-04-08'
    }),
    {
      name: GURU_MCP_TOOL_NAMES.roasGetSummary,
      arguments: {
        appKey: 'demo',
        platform: 'ios',
        reportDate: '2026-04-08',
        scope: undefined,
        templateId: 'mature_window'
      }
    }
  );

  await withHttpApp(createGuruMcpApp(), async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'unauthorized',
            version: '1.0.0'
          }
        }
      })
    });
    assert.equal(unauthorized.status, 401);

    const session = await initializeMcpSession(baseUrl);
    const toolsResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${env.mcp.internalToken}`,
        'mcp-session-id': session.sessionId,
        'mcp-protocol-version': session.protocolVersion
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'list-tools',
        method: 'tools/list',
        params: {}
      })
    });
    assert.equal(toolsResponse.status, 200);
    const toolsPayload = (await toolsResponse.json()) as {
      result?: {
        tools?: Array<{ name?: string }>;
      };
    };
    const toolNames = (toolsPayload.result?.tools ?? []).map((tool) => String(tool.name || ''));
    assert.deepEqual(toolNames.sort(), Object.values(GURU_MCP_TOOL_NAMES).sort());

    const terminated = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${env.mcp.internalToken}`,
        'mcp-session-id': session.sessionId,
        'mcp-protocol-version': session.protocolVersion
      }
    });
    assert.equal(terminated.status, 204);
  });

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

  const capturedAiModelIds: string[] = [];
  const capturedPageContexts: Array<Record<string, unknown> | undefined> = [];
  const capturedPreviewContextPacks: Array<Record<string, unknown>[]> = [];
  const aiRouter = createAiRouter({
    buildAiContextPacks: async (specs) => {
      capturedPreviewContextPacks.push(specs as Record<string, unknown>[]);
      return {
        packs: [],
        warnings: []
      };
    },
    runAiChat: async (input) => {
      capturedAiModelIds.push(String(input.modelId || ''));
      capturedPageContexts.push(input.pageContext as Record<string, unknown> | undefined);
      return {
        model_id: (input.modelId || 'qwen') as 'qwen' | 'openrouter_kimi_k25' | 'openai_gpt54',
        model:
          input.modelId === 'openrouter_kimi_k25'
            ? 'moonshotai/kimi-k2.5'
            : input.modelId === 'openai_gpt54'
              ? 'gpt-5.4'
              : 'qwen3.6-plus',
        model_label:
          input.modelId === 'openrouter_kimi_k25'
            ? 'Kimi-K2.5 (OpenRouter)'
            : input.modelId === 'openai_gpt54'
              ? 'GPT-5.4 (OpenAI)'
              : 'Qwen 3.6-Plus',
        provider:
          input.modelId === 'openrouter_kimi_k25'
            ? 'openrouter'
            : input.modelId === 'openai_gpt54'
              ? 'openai'
              : 'dashscope',
        reply: 'ok',
        agent_action: 'answer',
        page_trace: [],
        tool_trace: [],
        clarification_count: 0,
        usage: null,
        warnings: [],
        attachments_used: {
          images: [],
          context_packs: []
        },
        raw: {}
      };
    },
    listAvailableAiChatModels: () => [
      {
        id: 'qwen',
        label: 'Qwen 3.6-Plus',
        provider: 'dashscope',
        provider_label: 'DashScope',
        model: 'qwen3.6-plus',
        supports_images: true,
        supports_thinking: true
      },
      {
        id: 'openrouter_kimi_k25',
        label: 'Kimi-K2.5 (OpenRouter)',
        provider: 'openrouter',
        provider_label: 'OpenRouter',
        model: 'moonshotai/kimi-k2.5',
        supports_images: true,
        supports_thinking: false
      },
      {
        id: 'openai_gpt54',
        label: 'GPT-5.4 (OpenAI)',
        provider: 'openai',
        provider_label: 'OpenAI',
        model: 'gpt-5.4',
        supports_images: true,
        supports_thinking: false
      }
    ],
    getDefaultAiChatModelId: () => 'qwen'
  } as never);

  await withHttpApi(aiRouter, async (baseUrl) => {
    const modelsResponse = await fetch(`${baseUrl}/api/ai/models`);
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      ok: true,
      data: {
        default_model_id: 'qwen',
        models: [
          {
            id: 'qwen',
            label: 'Qwen 3.6-Plus',
            provider: 'dashscope',
            provider_label: 'DashScope',
            model: 'qwen3.6-plus',
            supports_images: true,
            supports_thinking: true
          },
          {
            id: 'openrouter_kimi_k25',
            label: 'Kimi-K2.5 (OpenRouter)',
            provider: 'openrouter',
            provider_label: 'OpenRouter',
            model: 'moonshotai/kimi-k2.5',
            supports_images: true,
            supports_thinking: false
          },
          {
            id: 'openai_gpt54',
            label: 'GPT-5.4 (OpenAI)',
            provider: 'openai',
            provider_label: 'OpenAI',
            model: 'gpt-5.4',
            supports_images: true,
            supports_thinking: false
          }
        ]
      }
    });

    const invalidModelForm = new FormData();
    invalidModelForm.set('message', 'hello');
    invalidModelForm.set('model_id', 'bad_model');
    const invalidModelResponse = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      body: invalidModelForm
    });
    assert.equal(invalidModelResponse.status, 400);
    assert.deepEqual(await invalidModelResponse.json(), {
      ok: false,
      error: 'invalid_model_id',
      message: '当前模型无效，请重新选择 Guru Ads Agent 模型。'
    });

    const openrouterForm = new FormData();
    openrouterForm.set('message', 'hello');
    openrouterForm.set('model_id', 'openrouter_kimi_k25');
    const openrouterResponse = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      body: openrouterForm
    });
    assert.equal(openrouterResponse.status, 200);
    assert.deepEqual(await openrouterResponse.json(), {
      ok: true,
      data: {
        model_id: 'openrouter_kimi_k25',
        model: 'moonshotai/kimi-k2.5',
        model_label: 'Kimi-K2.5 (OpenRouter)',
        provider: 'openrouter',
        reply: 'ok',
        agent_action: 'answer',
        page_trace: [],
        tool_trace: [],
        clarification_count: 0,
        usage: null,
        warnings: [],
        attachments_used: {
          images: [],
          context_packs: []
        },
        raw: {}
      }
    });

    const openaiForm = new FormData();
    openaiForm.set('message', 'hello');
    openaiForm.set('model_id', 'openai_gpt54');
    const openaiResponse = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      body: openaiForm
    });
    assert.equal(openaiResponse.status, 200);
    assert.deepEqual(await openaiResponse.json(), {
      ok: true,
      data: {
        model_id: 'openai_gpt54',
        model: 'gpt-5.4',
        model_label: 'GPT-5.4 (OpenAI)',
        provider: 'openai',
        reply: 'ok',
        agent_action: 'answer',
        page_trace: [],
        tool_trace: [],
        clarification_count: 0,
        usage: null,
        warnings: [],
        attachments_used: {
          images: [],
          context_packs: []
        },
        raw: {}
      }
    });

    const openrouterImageForm = new FormData();
    openrouterImageForm.set('message', 'hello');
    openrouterImageForm.set('model_id', 'openrouter_kimi_k25');
    openrouterImageForm.set(
      'page_context_json',
      JSON.stringify({
        activeSection: 'section-budget',
        pageLabel: '预算建议',
        defaults: {
          appKey: 'demo_app',
          platform: 'ios'
        },
        loaded_contexts: [
          {
            kind: 'budget_summary',
            title: '当前预算建议结果',
            summary_markdown: '- 当前列表：12 条\n- 待处理：4 条',
            applied_filters: {
              appKey: 'demo_app',
              platform: 'ios'
            },
            tool_hint: {
              type: 'budget_summary',
              templateId: 'platform_media_source',
              appKey: 'demo_app',
              platform: 'ios'
            }
          }
        ]
      })
    );
    openrouterImageForm.append(
      'images',
      new File([new Uint8Array([1, 2, 3])], 'demo.png', { type: 'image/png' })
    );
    const openrouterImageResponse = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      body: openrouterImageForm
    });
    assert.equal(openrouterImageResponse.status, 200);
    assert.deepEqual(await openrouterImageResponse.json(), {
      ok: true,
      data: {
        model_id: 'openrouter_kimi_k25',
        model: 'moonshotai/kimi-k2.5',
        model_label: 'Kimi-K2.5 (OpenRouter)',
        provider: 'openrouter',
        reply: 'ok',
        agent_action: 'answer',
        page_trace: [],
        tool_trace: [],
        clarification_count: 0,
        usage: null,
        warnings: [],
        attachments_used: {
          images: [],
          context_packs: []
        },
        raw: {}
      }
    });
    assert.deepEqual(capturedAiModelIds, ['openrouter_kimi_k25', 'openai_gpt54', 'openrouter_kimi_k25']);
    assert.equal(capturedPageContexts[2]?.activeSection, 'section-budget');
    assert.equal(Array.isArray(capturedPageContexts[2]?.loaded_contexts), true);
    assert.equal(capturedPageContexts[2]?.loaded_contexts?.[0]?.title, '当前预算建议结果');

    const previewResponse = await fetch(`${baseUrl}/api/ai/context-packs/preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        contextPacks: [
          {
            type: 'roas_summary',
            templateId: 'mature_window',
            appKey: 'demo_app',
            platform: 'ios',
            scope: 'budget',
            reportDate: '2026-04-08'
          }
        ]
      })
    });
    assert.equal(previewResponse.status, 200);
    assert.equal(capturedPreviewContextPacks.length, 1);
    assert.deepEqual(capturedPreviewContextPacks[0], [
      {
        type: 'roas_summary',
        templateId: 'mature_window',
        appKey: 'demo_app',
        platform: 'ios',
        scope: 'budget',
        reportDate: '2026-04-08',
        from: undefined,
        to: undefined,
        sourceSection: undefined,
        source: undefined,
        metric: undefined,
        eventName: undefined,
        status: undefined,
        executionStatus: undefined,
        isAdopted: undefined,
        hasManualReview: undefined,
        stage: undefined,
        keyword: undefined,
        campaign: undefined
      }
    ]);
  });

  const qwenOnlyAiRouter = createAiRouter({
    buildAiContextPacks: async () => ({
      packs: [],
      warnings: []
    }),
    runAiChat: (async () => {
      throw new Error('run_ai_chat_should_not_be_called');
    }) as never,
    listAvailableAiChatModels: () => [
      {
        id: 'qwen',
        label: 'Qwen 3.6-Plus',
        provider: 'dashscope',
        provider_label: 'DashScope',
        model: 'qwen3.6-plus',
        supports_images: true,
        supports_thinking: true
      }
    ],
    getDefaultAiChatModelId: () => 'qwen'
  } as never);

  await withHttpApi(qwenOnlyAiRouter, async (baseUrl) => {
    const modelsResponse = await fetch(`${baseUrl}/api/ai/models`);
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      ok: true,
      data: {
        default_model_id: 'qwen',
        models: [
          {
            id: 'qwen',
            label: 'Qwen 3.6-Plus',
            provider: 'dashscope',
            provider_label: 'DashScope',
            model: 'qwen3.6-plus',
            supports_images: true,
            supports_thinking: true
          }
        ]
      }
    });

    const unavailableForm = new FormData();
    unavailableForm.set('message', 'hello');
    unavailableForm.set('model_id', 'openrouter_kimi_k25');
    const unavailableResponse = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      body: unavailableForm
    });
    assert.equal(unavailableResponse.status, 400);
    assert.deepEqual(await unavailableResponse.json(), {
      ok: false,
      error: 'ai_model_unavailable',
      message: '当前选择的模型暂不可用，请切回其他模型后重试。'
    });
  });

  const timeoutAiRouter = createAiRouter({
    buildAiContextPacks: async () => ({
      packs: [],
      warnings: []
    }),
    runAiChat: (async () => {
      throw new Error('mcp_request_timeout');
    }) as never,
    listAvailableAiChatModels: () => [
      {
        id: 'qwen',
        label: 'Qwen 3.6-Plus',
        provider: 'dashscope',
        provider_label: 'DashScope',
        model: 'qwen3.6-plus',
        supports_images: true,
        supports_thinking: true
      }
    ],
    getDefaultAiChatModelId: () => 'qwen'
  } as never);

  await withHttpApi(timeoutAiRouter, async (baseUrl) => {
    const timeoutForm = new FormData();
    timeoutForm.set('message', 'hello');
    const timeoutResponse = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      body: timeoutForm
    });
    assert.equal(timeoutResponse.status, 504);
    assert.deepEqual(await timeoutResponse.json(), {
      ok: false,
      error: 'ai_chat_timeout',
      message: 'Guru Ads Agent 响应超时，请重试，或减少上下文后再发送。'
    });
  });

  const healthRouter = createHealthRouter({
    requestMetrics: {
      clickhouseInsertLatencyMs: [],
      totalPushRequests: 0,
      pushErrors: 0
    } as never,
    probePostgres: async () => ({
      ok: false,
      status: 'timeout',
      durationMs: 3000
    }),
    probeClickhouse: async () => ({
      ok: false,
      status: 'dependency_unavailable',
      durationMs: 12
    })
  });

  await withHttpApi(healthRouter, async (baseUrl) => {
    const readyResponse = await fetch(`${baseUrl}/ready`);
    assert.equal(readyResponse.status, 503);
    const readyJson = await readyResponse.json();
    assert.equal(readyJson.ok, false);
    assert.deepEqual(readyJson.checks, {
      postgres: {
        ok: false,
        status: 'timeout',
        duration_ms: 3000
      },
      clickhouse: {
        ok: false,
        status: 'dependency_unavailable',
        duration_ms: 12
      }
    });
    assert.equal(typeof readyJson.now, 'string');
    assert.equal('error' in readyJson.checks.postgres, false);
    assert.equal('error' in readyJson.checks.clickhouse, false);
  });

  const uiAppScript = readFileSync('apps/api/src/modules/ui/public/app.js', 'utf8');
  assert.match(uiAppScript, /function toSqlDateTime\(date\)\s*\{\s*const y = date\.getFullYear\(\)/);
  assert.match(uiAppScript, /function toSqlDate\(date\)\s*\{\s*return toLocalDate\(date\);\s*\}/);
  assert.doesNotMatch(uiAppScript, /function toSqlDateTime\(date\)\s*\{\s*return date\.toISOString\(\)/);
  assert.doesNotMatch(uiAppScript, /function toSqlDate\(date\)\s*\{\s*return date\.toISOString\(\)/);
  assert.match(uiAppScript, /function buildAsaTrendMetricDisplaySource\(source = \{\}\)\s*\{[\s\S]*af_cohort_roas_missing/);
  assert.match(uiAppScript, /function resolveAsaTrendRoasStatus\(source = \{\}\)\s*\{\s*return buildAsaTrendMetricDisplaySource\(source\)\.roasStatus;/);
  assert.match(uiAppScript, /function resolveAsaTrendCppStatus\(source = \{\}\)/);
  assert.match(uiAppScript, /const trendMetric = buildAsaTrendMetricDisplaySource\(item\);[\s\S]*trendMetric\.d7Roas/);
  assert.match(uiAppScript, /投放项名称（飞书主字段）[\s\S]*七天后数据（系统自动回填）/);
  assert.match(uiAppScript, /关键词（飞书主字段）[\s\S]*广告系列[\s\S]*广告组[\s\S]*七天后数据（系统自动回填）/);
  assert.match(uiAppScript, /「非 ASA 执行表」与「ASA 关键词执行表」[\s\S]*历史日期自动留档/);
  assert.doesNotMatch(uiAppScript, /创建或复用一张固定的「投放执行表」/);

  const uiIndexHtml = readFileSync('apps/api/src/modules/ui/public/index.html', 'utf8');
  assert.match(uiIndexHtml, /「非 ASA 执行表」与「ASA 关键词执行表」.*历史日期自动留档/);
  assert.doesNotMatch(uiIndexHtml, /创建或复用一张固定的「投放执行表」/);

  const bitableExportScript = readFileSync('packages/shared/utils/bitableExport.ts', 'utf8');
  assert.match(bitableExportScript, /function formatRoasPercent\(value: unknown\): string/);
  assert.match(bitableExportScript, /目标 ROAS \$\{formatRoasPercent\(targetRoas\)\}/);
  assert.match(bitableExportScript, /成熟窗口 ROAS \$\{formatRoasPercent\(currentRoas\)\}/);
  assert.match(bitableExportScript, /ROAS \$\{formatRoasPercent\(row\.current_d7_roas\)\}/);
  assert.match(bitableExportScript, /const ITEM_NAME_FIELD_LABEL = '投放项名称'/);
  assert.match(
    bitableExportScript,
    /\{ key: 'display_item_name', label: ITEM_NAME_FIELD_LABEL, value_type: 'text', default_selected: true \}/
  );
  assert.match(
    bitableExportScript,
    /\{ key: 'item_name', label: KEYWORD_FIELD_LABEL, value_type: 'text', default_selected: true \}/
  );
  assert.match(
    bitableExportScript,
    /\{ key: 'display_product_name', label: '产品名', value_type: 'text', default_selected: true \}/
  );
  assert.match(bitableExportScript, /const ACTIVE_SOURCE_TYPES = \[NON_ASA_SOURCE_TYPE, ASA_SOURCE_TYPE\] as const;/);
  assert.match(bitableExportScript, /label: '非 ASA 执行表'/);
  assert.match(bitableExportScript, /label: 'ASA 关键词执行表'/);
  assert.match(bitableExportScript, /function formatBudgetItemDisplayName\(row: Record<string, unknown>\): string/);
  assert.match(bitableExportScript, /function formatAsaItemDisplayName\(row: Record<string, unknown>\): string/);
  assert.match(bitableExportScript, /await ensureAsaKeywordRoasSchema\(\);\s*const result = await pgQuery<Record<string, unknown>>\(\s*`SELECT[\s\S]*FROM asa_keyword_recommendations ar/);
  assert.match(
    bitableExportScript,
    /function shouldCompactActionTableSchema\(reportDate: string, tableIsNew: boolean\): boolean \{\s*return tableIsNew \|\| reportDate >= getPreviousDateString\(1\);\s*\}/
  );
  assert.match(
    bitableExportScript,
    /const existingTableRecords = await listBitableRecords\(appToken, table\.table_id\);[\s\S]*const liveFeedback = await buildManualFeedbackMap\([\s\S]*existingTableRecords[\s\S]*const fieldSync = await ensureTableFields\(/
  );
  assert.match(
    bitableExportScript,
    /const fieldSync = await ensureTableFields\(\s*appToken,\s*sourceType,\s*table\.table_id,\s*selectedFields,\s*\{\s*cleanupExtraFields: compactSchema,\s*allowDestructiveFieldRebuild: existingTableRecordIds\.length === 0\s*\}/
  );
  assert.match(
    bitableExportScript,
    /if \(compactSchema && existingTableRecordIds\.length === 0\) \{\s*await reorderActionFields\(appToken,\s*sourceType,\s*table\.table_id,\s*selectedFields,\s*logger\);\s*\}/
  );
  assert.doesNotMatch(bitableExportScript, /\{ key: 'platform', label: '平台', value_type: 'text', default_selected: true \}/);
  assert.doesNotMatch(
    bitableExportScript,
    /\{ key: 'cost_reference', label: '成本参考', value_type: 'number', default_selected: true \}/
  );

  const asaKeywordsScript = readFileSync('packages/shared/utils/asaKeywords.ts', 'utf8');
  assert.match(asaKeywordsScript, /revenue_source_complete: kpi === 'revenue'/);
  assert.match(asaKeywordsScript, /af_cohort_roas: kpi === 'roas' \? normalizeAfCohortRoasRate/);
  assert.match(asaKeywordsScript, /if\(covered_roas_cost_sum > 0, covered_revenue_d7_sum \/ covered_roas_cost_sum, 0\) AS d7_roas/);
  assert.match(asaKeywordsScript, /return eligibleRows\.reduce\(\(sum, row\) => sum \+ Number\(row\.revenue_d7 \|\| 0\), 0\) \/ totalCost;/);
  assert.match(asaKeywordsScript, /【产品概览】/);
  assert.match(asaKeywordsScript, /仅覆盖已配置 iOS 端的产品/);
  assert.match(asaKeywordsScript, /成熟窗口 D7 ROAS/);
  assert.match(asaKeywordsScript, /ASA 专属多维表格/);
  assert.match(asaKeywordsScript, /AF 官方成熟窗口 D7 ROAS 缺失，当前不展示回退值/);
  assert.match(asaKeywordsScript, /内部成熟回收 D7 ROAS .*仅用于保守判断/);
  assert.match(asaKeywordsScript, /product_overview_rows:/);
  assert.match(asaKeywordsScript, /throw new Error\('asa_brief_ios_only'\)/);
  assert.doesNotMatch(asaKeywordsScript, /【关键词概览】/);
  assert.doesNotMatch(asaKeywordsScript, /🛠️ \*\*建议操作\*\*/);

  const appsRoutesScript = readFileSync('apps/api/src/modules/apps.routes.ts', 'utf8');
  assert.match(appsRoutesScript, /Android 未配置 Pull App ID，Android 结果不会进入系统/);
  assert.match(appsRoutesScript, /platform_status:/);

  const asaKeywordRoutesScript = readFileSync('apps/api/src/modules/asaKeywords/asaKeywords.routes.ts', 'utf8');
  assert.match(asaKeywordRoutesScript, /asa_brief_ios_only/);

  const uiIndexScript = readFileSync('apps/api/src/modules/ui/public/index.html', 'utf8');
  assert.match(uiIndexScript, /全部 iOS 产品/);
  assert.match(
    uiIndexScript,
    /<select id="asaBriefPlatformSelect" name="platform">\s*<option value="">全部 iOS 产品<\/option>\s*<option value="ios">iOS<\/option>\s*<\/select>/
  );

  const dailyBriefScript = readFileSync('packages/shared/utils/dailyBrief.ts', 'utf8');
  assert.match(dailyBriefScript, /function formatRoasPercent\(value: number \| null \| undefined\): string/);
  assert.match(dailyBriefScript, /成熟窗口 ROAS \$\{formatRoasPercent\(row\.current_roas\)\} ｜ 目标 \$\{formatRoasPercent\(row\.target_roas\)\}/);
  assert.match(dailyBriefScript, /【异常提醒】/);
  assert.match(dailyBriefScript, /【重点关注产品】/);
  assert.match(dailyBriefScript, /anomaly_reminder:/);
  assert.match(dailyBriefScript, /focus_products:/);
  assert.match(dailyBriefScript, /非 ASA \/ ASA 专属多维表格/);
  assert.doesNotMatch(dailyBriefScript, /【核心概览】/);
  assert.doesNotMatch(dailyBriefScript, /【今日判断】/);
  assert.doesNotMatch(dailyBriefScript, /【预算动作/);
  assert.doesNotMatch(dailyBriefScript, /【建议操作】/);

  const roasSummaryToolScript = readFileSync('packages/shared/utils/roasSummaryTool.ts', 'utf8');
  assert.match(roasSummaryToolScript, /return value != null && Number\.isFinite\(value\) \? `\$\{\(Math\.max\(0, value\) \* 100\)\.toFixed\(2\)\}%` : '—';/);

  const aiContextPacksScript = readFileSync('packages/shared/utils/aiContextPacks.ts', 'utf8');
  assert.match(aiContextPacksScript, /function formatOptionalRoasPercent\(value: unknown\): string/);
  assert.match(aiContextPacksScript, /D7 ROAS \$\{formatOptionalRoasPercent\(summary\.avg_roas\)\}/);
  assert.doesNotMatch(aiContextPacksScript, /avg\(current_d7_roas\)/);
  assert.doesNotMatch(aiContextPacksScript, /avg_roas:\s*'0\.00'/);
  assert.doesNotMatch(aiContextPacksScript, /formatRoasPercent\(summary\.avg_roas \|\| 0\)/);

  const aiChatScript = readFileSync('packages/shared/utils/aiChat.ts', 'utf8');
  assert.match(aiChatScript, /function formatOptionalRoasPercent\(value: unknown\): string/);
  assert.match(aiChatScript, /D7 ROAS \$\{formatOptionalRoasPercent\(summary\.avg_roas\)\}/);
  assert.doesNotMatch(aiChatScript, /avg\(current_d7_roas\)/);
  assert.doesNotMatch(aiChatScript, /avg_roas:\s*'0\.00'/);
  assert.doesNotMatch(aiChatScript, /formatRoasPercent\(summary\.avg_roas \|\| 0\)/);

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

  const budgetWorkerScript = readFileSync('workers/budget-advisor/src/index.ts', 'utf8');
  assert.match(budgetWorkerScript, /const hasAppFailures = result\.failed_count > 0;/);
  assert.match(budgetWorkerScript, /await failScheduledWorkerRun\(BUDGET_ADVISOR_WORKER_NAME, runMarker, appFailureSummary\);/);

  const budgetAdvisorScript = readFileSync('packages/shared/utils/budgetAdvisor.ts', 'utf8');
  assert.match(budgetAdvisorScript, /expireStalePendingBudgetRecommendationsForDate/);
  assert.match(budgetAdvisorScript, /const preparedRecommendations: UpsertBudgetRecommendationInput\[\] = \[\];/);
  assert.doesNotMatch(budgetAdvisorScript, /await expirePendingBudgetRecommendationsForDate\(app\.app_key, date\);/);

  const repositoriesScript = readFileSync('packages/shared/utils/repositories.ts', 'utf8');
  assert.match(repositoriesScript, /export async function expireStalePendingBudgetRecommendationsForDate/);
  assert.match(repositoriesScript, /ref\.source_type IN \('delivery_actions_non_asa', 'delivery_actions'\)/);
  assert.match(repositoriesScript, /roas_covered_cost DOUBLE PRECISION NOT NULL DEFAULT 0/);

  assert.match(bitableExportScript, /function legacyFeedbackFallbackSourceType/);
  assert.match(bitableExportScript, /listRecommendationExecutionFeedbacksByRecommendations\(fallbackSourceType, keys\)/);

  const recommendationFeedbackScript = readFileSync('packages/shared/utils/recommendationFeedback.ts', 'utf8');
  assert.match(recommendationFeedbackScript, /const LEGACY_SOURCE_TYPE: BitableExportSourceType = 'delivery_actions';/);
  assert.match(recommendationFeedbackScript, /getLatestBudgetFeedbackSkillVersion/);
  assert.match(recommendationFeedbackScript, /ref\.source_type IN \('\$\{BUDGET_FEEDBACK_SOURCE_TYPE\}', '\$\{LEGACY_SOURCE_TYPE\}'\)/);

  assert.match(asaKeywordsScript, /return Boolean\(String\(app\?\.ios_pull_app_id \|\| ''\)\.trim\(\)\);/);
  assert.doesNotMatch(asaKeywordsScript, /app\.pull_app_id\)\s*\{/);
  assert.match(asaKeywordsScript, /roas_covered_cost: coveredRoasCost/);
  assert.match(asaKeywordsScript, /current\.roas_covered_cost \+= Number\(row\.roas_covered_cost \|\| 0\);/);
  assert.match(asaKeywordsScript, /queryAllAsaKeywordDashboardRowsForBrief/);

  console.log('review_regression_smoke_passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
