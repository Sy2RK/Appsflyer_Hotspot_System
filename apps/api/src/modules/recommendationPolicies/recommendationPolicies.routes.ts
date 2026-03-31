import { Router } from 'express';
import {
  listRecommendationPolicyConfigs,
  upsertRecommendationPolicyConfig
} from '@shared/utils/repositories.js';
import {
  normalizeRecommendationPolicyRule,
  RecommendationPolicyValidationError,
  summarizeRecommendationPolicySupport,
  validateRecommendationPolicyRule
} from '@shared/utils/recommendationPolicies.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { logger } from '../../common/logger/logger.js';

const router = Router();

router.get('/api/recommendation-policies', async (req, res, next) => {
  try {
    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    const engineRaw = typeof req.query.engine === 'string' ? req.query.engine.trim().toLowerCase() : '';
    const enabledRaw = typeof req.query.enabled === 'string' ? req.query.enabled.trim().toLowerCase() : '';
    const engine = engineRaw === 'budget' || engineRaw === 'asa' ? engineRaw : undefined;
    const enabled =
      enabledRaw === 'true' || enabledRaw === '1'
        ? true
        : enabledRaw === 'false' || enabledRaw === '0'
          ? false
          : undefined;

    const rows = await listRecommendationPolicyConfigs({
      appKey: appKey || undefined,
      platform: platform || undefined,
      engine,
      enabled
    });
    return res.json({
      ok: true,
      data: rows.map((row) => ({
        ...row,
        effective_support: summarizeRecommendationPolicySupport(row.engine, normalizeRecommendationPolicyRule(row.rule_json))
      }))
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/recommendation-policies', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const appKey = typeof body.appKey === 'string' ? body.appKey.trim() : '';
    const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
    const engine = body.engine === 'asa' ? 'asa' : body.engine === 'budget' ? 'budget' : '';
    if (!appKey || !platform || !engine) {
      return res.status(400).json({ ok: false, error: 'appKey_platform_engine_required' });
    }
    if (!['ios', 'android', 'unknown'].includes(platform)) {
      return res.status(400).json({ ok: false, error: 'invalid_platform' });
    }

    const validation = validateRecommendationPolicyRule(body.ruleJson);
    const rule = validation.rule;
    const row = await upsertRecommendationPolicyConfig({
      app_key: appKey,
      platform,
      engine,
      enabled: body.enabled !== false,
      rule_json: rule as unknown as Record<string, unknown>,
      manual_prompt_markdown:
        typeof body.manualPromptMarkdown === 'string' ? body.manualPromptMarkdown : String(body.manualPromptMarkdown || '')
    });

    await writeOperationLog(
      {
        source: 'api.recommendation_policies',
        action: 'upsert_recommendation_policy',
        target_type: 'recommendation_policy',
        target_key: `${appKey}|${platform}|${engine}`,
        status: 'success',
        summary: `更新应用级建议策略：${appKey} / ${platform} / ${engine}`,
        detail_json: {
          metric_family: rule.metric_family,
          traffic_scope: rule.traffic_scope,
          decision_mode: rule.decision_mode,
          enabled: row.enabled
        }
      },
      logger
    );

    return res.json({
      ok: true,
      data: {
        ...row,
        effective_support: summarizeRecommendationPolicySupport(row.engine, rule)
      }
    });
  } catch (error) {
    if (error instanceof RecommendationPolicyValidationError) {
      return res.status(400).json({ ok: false, error: error.code, message: error.message });
    }
    return next(error);
  }
});

export default router;
