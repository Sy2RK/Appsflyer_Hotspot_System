import { Router } from 'express';
import {
  getAppByKey,
  listRules,
  setRuleEnabled,
  upsertRule
} from '@shared/utils/repositories.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { parseRuleDsl } from '@shared/utils/ruleParser.js';
import { logger } from '../../common/logger/logger.js';

const router = Router();

router.get('/api/rules', async (req, res) => {
  const appKey = typeof req.query.appKey === 'string' ? req.query.appKey : undefined;
  const rules = await listRules(appKey);
  res.json({ ok: true, data: rules });
});

router.post('/api/rules', async (req, res) => {
  const body = req.body as Record<string, unknown>;

  const appKey = typeof body.app_key === 'string' ? body.app_key : '';
  const name = typeof body.name === 'string' ? body.name : '';
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  const id = typeof body.id === 'number' ? body.id : undefined;
  const ruleJson = parseRuleDsl(body.rule_json);

  if (!appKey || !name || !ruleJson) {
    return res.status(400).json({ ok: false, error: 'invalid_rule_payload' });
  }

  const app = await getAppByKey(appKey);
  if (!app) {
    return res.status(404).json({ ok: false, error: 'app_not_found' });
  }

  const saved = await upsertRule({
    id,
    app_key: appKey,
    name,
    enabled,
    rule_json: ruleJson as unknown as Record<string, unknown>
  });

  await writeOperationLog(
    {
      source: 'api.rules',
      action: id ? 'update_rule' : 'create_rule',
      target_type: 'rule',
      target_key: `${saved.app_key}:${saved.id}`,
      status: 'success',
      summary: `${id ? '更新' : '创建'}规则 ${saved.name}`,
      detail_json: {
        app_key: saved.app_key,
        enabled: saved.enabled,
        name: saved.name
      }
    },
    logger
  );

  return res.json({ ok: true, data: saved });
});

router.post('/api/rules/:id/enable', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.status(400).json({ ok: false, error: 'invalid_rule_id' });
  }

  const rule = await setRuleEnabled(id, true);
  if (!rule) {
    return res.status(404).json({ ok: false, error: 'rule_not_found' });
  }

  await writeOperationLog(
    {
      source: 'api.rules',
      action: 'enable_rule',
      target_type: 'rule',
      target_key: `${rule.app_key}:${rule.id}`,
      status: 'success',
      summary: `启用规则 ${rule.name}`,
      detail_json: {
        app_key: rule.app_key,
        rule_id: rule.id
      }
    },
    logger
  );

  return res.json({ ok: true, data: rule });
});

router.post('/api/rules/:id/disable', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.status(400).json({ ok: false, error: 'invalid_rule_id' });
  }

  const rule = await setRuleEnabled(id, false);
  if (!rule) {
    return res.status(404).json({ ok: false, error: 'rule_not_found' });
  }

  await writeOperationLog(
    {
      source: 'api.rules',
      action: 'disable_rule',
      target_type: 'rule',
      target_key: `${rule.app_key}:${rule.id}`,
      status: 'success',
      summary: `停用规则 ${rule.name}`,
      detail_json: {
        app_key: rule.app_key,
        rule_id: rule.id
      }
    },
    logger
  );

  return res.json({ ok: true, data: rule });
});

export default router;
