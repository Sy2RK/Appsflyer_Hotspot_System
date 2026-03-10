import { Router } from 'express';
import { listApps, upsertAppConfig } from '@shared/utils/repositories.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { logger } from '../common/logger/logger.js';

const router = Router();

function resolveDisplayName(appKey: string, displayName?: string | null): string {
  const raw = typeof displayName === 'string' ? displayName.trim() : '';
  if (raw) {
    return raw;
  }
  return appKey.replace(/-/g, ' ').trim();
}

function resolvePlatformDisplayName(
  appKey: string,
  fallbackDisplayName: string,
  rawValue: string | null | undefined,
  platformSuffix: 'iOS' | 'Android'
): string {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (value) {
    return value;
  }
  const base = fallbackDisplayName || resolveDisplayName(appKey);
  return `${base} ${platformSuffix}`.trim();
}

router.get('/api/apps', async (_req, res) => {
  const apps = await listApps();
  res.json({
    ok: true,
    data: apps.map((app) => ({
      app_key: app.app_key,
      display_name: resolveDisplayName(app.app_key, app.display_name),
      ios_display_name: resolvePlatformDisplayName(
        app.app_key,
        resolveDisplayName(app.app_key, app.display_name),
        app.ios_display_name,
        'iOS'
      ),
      android_display_name: resolvePlatformDisplayName(
        app.app_key,
        resolveDisplayName(app.app_key, app.display_name),
        app.android_display_name,
        'Android'
      ),
      pull_app_id: app.pull_app_id,
      ios_pull_app_id: app.ios_pull_app_id,
      android_pull_app_id: app.android_pull_app_id,
      dataset: app.dataset,
      timezone: app.timezone,
      notify_webhook_url: app.notify_webhook_url,
      notify_feishu_app_id: app.notify_feishu_app_id,
      notify_feishu_chat_id: app.notify_feishu_chat_id,
      has_feishu_secret: Boolean(app.notify_feishu_app_secret),
      created_at: app.created_at,
      updated_at: app.updated_at
    }))
  });
});

router.post('/api/apps', async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const app_key = typeof body.app_key === 'string' ? body.app_key.trim() : '';
  const pull_app_id = typeof body.pull_app_id === 'string' ? body.pull_app_id.trim() : '';
  const ios_pull_app_id = typeof body.ios_pull_app_id === 'string' ? body.ios_pull_app_id.trim() : '';
  const android_pull_app_id =
    typeof body.android_pull_app_id === 'string' ? body.android_pull_app_id.trim() : '';
  const display_name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  const ios_display_name = typeof body.ios_display_name === 'string' ? body.ios_display_name.trim() : '';
  const android_display_name =
    typeof body.android_display_name === 'string' ? body.android_display_name.trim() : '';
  const notify_feishu_app_secret =
    typeof body.notify_feishu_app_secret === 'string' ? body.notify_feishu_app_secret.trim() : '';
  const clearNotifyFeishuAppSecret = body.clear_notify_feishu_app_secret === true;
  const dataset =
    typeof body.dataset === 'string' && body.dataset.trim()
      ? body.dataset.trim()
      : 'ods_events_device_detail';
  const timezone =
    typeof body.timezone === 'string' && body.timezone.trim()
      ? body.timezone.trim()
      : 'Asia/Shanghai';

  if (!app_key || (!pull_app_id && !ios_pull_app_id && !android_pull_app_id)) {
    return res.status(400).json({
      ok: false,
      error: 'app_key_and_at_least_one_app_id_required'
    });
  }
  if (ios_pull_app_id && android_pull_app_id && ios_pull_app_id === android_pull_app_id) {
    return res.status(400).json({
      ok: false,
      error: 'ios_android_app_id_must_differ'
    });
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(app_key)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_app_key_format'
    });
  }

  const saved = await upsertAppConfig({
    app_key,
    display_name,
    ios_display_name,
    android_display_name,
    pull_app_id: pull_app_id || ios_pull_app_id || android_pull_app_id,
    ios_pull_app_id,
    android_pull_app_id,
    dataset,
    timezone,
    push_auth_token: typeof body.push_auth_token === 'string' ? body.push_auth_token.trim() : undefined,
    notify_webhook_url:
      typeof body.notify_webhook_url === 'string' ? body.notify_webhook_url.trim() : undefined,
    notify_feishu_app_id:
      typeof body.notify_feishu_app_id === 'string' ? body.notify_feishu_app_id.trim() : undefined,
    notify_feishu_app_secret: notify_feishu_app_secret || undefined,
    notify_feishu_chat_id:
      typeof body.notify_feishu_chat_id === 'string' ? body.notify_feishu_chat_id.trim() : undefined,
    replace_notify_feishu_app_secret:
      clearNotifyFeishuAppSecret || (hasOwn('notify_feishu_app_secret') && notify_feishu_app_secret.length > 0)
  });

  await writeOperationLog(
    {
      source: 'api.apps',
      action: 'upsert_app',
      target_type: 'app',
      target_key: saved.app_key,
      status: 'success',
      summary: `保存应用配置 ${saved.app_key}`,
      detail_json: {
        dataset: saved.dataset,
        timezone: saved.timezone,
        ios_pull_app_id: saved.ios_pull_app_id,
        android_pull_app_id: saved.android_pull_app_id
      }
    },
    logger
  );

  return res.json({
    ok: true,
    data: {
      app_key: saved.app_key,
      display_name: resolveDisplayName(saved.app_key, saved.display_name),
      ios_display_name: resolvePlatformDisplayName(
        saved.app_key,
        resolveDisplayName(saved.app_key, saved.display_name),
        saved.ios_display_name,
        'iOS'
      ),
      android_display_name: resolvePlatformDisplayName(
        saved.app_key,
        resolveDisplayName(saved.app_key, saved.display_name),
        saved.android_display_name,
        'Android'
      ),
      pull_app_id: saved.pull_app_id,
      ios_pull_app_id: saved.ios_pull_app_id,
      android_pull_app_id: saved.android_pull_app_id,
      dataset: saved.dataset,
      timezone: saved.timezone,
      notify_webhook_url: saved.notify_webhook_url,
      notify_feishu_app_id: saved.notify_feishu_app_id,
      notify_feishu_chat_id: saved.notify_feishu_chat_id,
      has_feishu_secret: Boolean(saved.notify_feishu_app_secret),
      created_at: saved.created_at,
      updated_at: saved.updated_at
    }
  });
});

export default router;
