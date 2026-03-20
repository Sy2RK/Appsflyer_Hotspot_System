import { Router } from 'express';
import {
  queryBudgetRecommendations,
  setBudgetRecommendationStatus
} from '@shared/utils/repositories.js';
import { runBudgetAdvisorCycle, BudgetAdvisorProgressSnapshot } from '@shared/utils/budgetAdvisor.js';
import { logger } from '../../common/logger/logger.js';
import { env } from '@shared/config/env.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

const router = Router();
let recomputeRunning = false;
type BudgetRecomputeStatus = BudgetAdvisorProgressSnapshot & {
  running: boolean;
  finished_at: string | null;
  error: string | null;
};

let recomputeStatus: BudgetRecomputeStatus = {
  running: false,
  started_at: '',
  finished_at: null,
  error: null,
  lookback_days: env.budgetAdvisorLookbackDays,
  total_apps: 0,
  processed_apps: 0,
  current_app: null,
  generated_total: 0,
  total_candidates: 0,
  success_count: 0,
  failed_count: 0,
  skipped_count: 0
};

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parsePage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

router.get('/api/budget/recommendations', async (req, res, next) => {
  try {
    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    const statusRaw = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
    const page = parsePage(req.query.page);

    if (from && !isDate(from)) {
      return res.status(400).json({ ok: false, error: 'invalid_from_date' });
    }
    if (to && !isDate(to)) {
      return res.status(400).json({ ok: false, error: 'invalid_to_date' });
    }
    if (from && to && from > to) {
      return res.status(400).json({ ok: false, error: 'from_gt_to' });
    }
    const status =
      statusRaw === 'pending' || statusRaw === 'applied' || statusRaw === 'rejected' || statusRaw === 'expired'
        ? statusRaw
        : undefined;

    const result = await queryBudgetRecommendations({
      appKey: appKey || undefined,
      platform: platform || undefined,
      status,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize: 20
    });

    return res.json({
      ok: true,
      data: result.rows,
      meta: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/budget/recommendations/:id/reject', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const updated = await setBudgetRecommendationStatus(id, 'rejected');
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'recommendation_not_found' });
    }
    await writeOperationLog(
      {
        source: 'api.budget',
        action: 'reject_budget_recommendation',
        target_type: 'budget_recommendation',
        target_key: String(updated.id),
        status: 'success',
        summary: `拒绝预算建议 #${updated.id}`,
        detail_json: {
          app_key: updated.app_key,
          keyword: updated.keyword,
          status: updated.status
        }
      },
      logger
    );
    return res.json({ ok: true, data: updated });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/budget/recommendations/:id/mark-applied', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const updated = await setBudgetRecommendationStatus(id, 'applied');
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'recommendation_not_found' });
    }
    await writeOperationLog(
      {
        source: 'api.budget',
        action: 'apply_budget_recommendation',
        target_type: 'budget_recommendation',
        target_key: String(updated.id),
        status: 'success',
        summary: `标记预算建议已执行 #${updated.id}`,
        detail_json: {
          app_key: updated.app_key,
          keyword: updated.keyword,
          status: updated.status
        }
      },
      logger
    );
    return res.json({ ok: true, data: updated });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/budget/recommendations/recompute', async (req, res, next) => {
  try {
    if (recomputeRunning) {
      return res.status(409).json({ ok: false, error: 'budget_recompute_running' });
    }
    recomputeRunning = true;
    recomputeStatus = {
      running: true,
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      lookback_days: env.budgetAdvisorLookbackDays,
      total_apps: 0,
      processed_apps: 0,
      current_app: null,
      generated_total: 0,
      total_candidates: 0,
      success_count: 0,
      failed_count: 0,
      skipped_count: 0
    };
    const result = await runBudgetAdvisorCycle(env.budgetAdvisorLookbackDays, logger, (snapshot) => {
      recomputeStatus = {
        ...recomputeStatus,
        ...snapshot,
        running: true,
        finished_at: null,
        error: null
      };
    });
    recomputeStatus = {
      ...recomputeStatus,
      running: false,
      finished_at: new Date().toISOString(),
      current_app: null,
      error: null,
      generated_total: result.generated_total,
      success_count: result.success_count,
      failed_count: result.failed_count,
      skipped_count: result.skipped_count
    };
    await writeOperationLog(
      {
        source: 'api.budget',
        action: 'manual_budget_recompute',
        target_type: 'budget_cycle',
        target_key: String(env.budgetAdvisorLookbackDays),
        status: 'success',
        summary: `手动生成预算建议，回看 ${env.budgetAdvisorLookbackDays} 天`,
        detail_json: result
      },
      logger
    );
    return res.json({ ok: true, data: result });
  } catch (error) {
    logger.error('budget_recompute_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    recomputeStatus = {
      ...recomputeStatus,
      running: false,
      finished_at: new Date().toISOString(),
      current_app: null,
      error: error instanceof Error ? error.message : String(error)
    };
    await writeOperationLog(
      {
        source: 'api.budget',
        action: 'manual_budget_recompute',
        target_type: 'budget_cycle',
        target_key: String(env.budgetAdvisorLookbackDays),
        status: 'failed',
        summary: `手动生成预算建议失败，回看 ${env.budgetAdvisorLookbackDays} 天`,
        detail_json: {
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
    return next(error);
  } finally {
    recomputeRunning = false;
  }
});

router.get('/api/budget/recommendations/recompute/status', async (_req, res) => {
  return res.json({ ok: true, data: recomputeStatus });
});

export default router;
