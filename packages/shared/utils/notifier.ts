import { env } from '../config/env.js';

export interface NotificationPayload {
  title: string;
  text: string;
  extra?: Record<string, unknown>;
  feishuPostPayload?: unknown;
  feishuCardPayload?: unknown;
}

export interface AlertChannelConfig {
  notify_webhook_url?: string | null;
  notify_feishu_app_id?: string | null;
  notify_feishu_app_secret?: string | null;
  notify_feishu_chat_id?: string | null;
}

export interface NotificationResult {
  ok: boolean;
  status?: number;
  error?: string;
  render_mode?: 'interactive' | 'post' | 'text' | 'text_fallback';
}

function resolveFeishuConfig(override?: AlertChannelConfig): {
  appId: string;
  appSecret: string;
  chatId: string;
} | null {
  const pickNonEmpty = (...values: Array<string | null | undefined>): string => {
    for (const raw of values) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value) {
        return value;
      }
    }
    return '';
  };

  const appId = pickNonEmpty(override?.notify_feishu_app_id, env.feishuAppId);
  const appSecret = pickNonEmpty(override?.notify_feishu_app_secret, env.feishuAppSecret);
  const chatId = pickNonEmpty(override?.notify_feishu_chat_id, env.feishuChatId);

  if (!appId || !appSecret || !chatId) {
    return null;
  }

  return { appId, appSecret, chatId };
}

async function getFeishuTenantAccessToken(
  override?: AlertChannelConfig
): Promise<{ ok: true; accessToken: string } | { ok: false; status?: number; error: string }> {
  const feishu = resolveFeishuConfig(override);
  if (!feishu) {
    return { ok: false, error: 'No Feishu bot config' };
  }

  try {
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_id: feishu.appId,
        app_secret: feishu.appSecret
      })
    });

    if (!tokenRes.ok) {
      return { ok: false, status: tokenRes.status, error: 'Feishu token request failed' };
    }

    const tokenBody = (await tokenRes.json()) as { tenant_access_token?: string; code?: number; msg?: string };
    if (!tokenBody.tenant_access_token) {
      return {
        ok: false,
        error: `Feishu token missing, code=${String(tokenBody.code ?? '')}, msg=${String(tokenBody.msg ?? '')}`
      };
    }

    return { ok: true, accessToken: tokenBody.tenant_access_token };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function sendFeishuMessage(
  payload: { msg_type: 'text' | 'post' | 'interactive'; content: string },
  override?: AlertChannelConfig
): Promise<NotificationResult> {
  const feishu = resolveFeishuConfig(override);
  if (!feishu) {
    return { ok: false, error: 'No Feishu bot config' };
  }

  const token = await getFeishuTenantAccessToken(override);
  if (!token.ok) {
    return { ok: false, status: token.status, error: token.error };
  }

  try {
    const messageRes = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token.accessToken}`
      },
      body: JSON.stringify({
        receive_id: feishu.chatId,
        ...payload
      })
    });

    return {
      ok: messageRes.ok,
      status: messageRes.status,
      render_mode:
        payload.msg_type === 'interactive' ? 'interactive' : payload.msg_type === 'post' ? 'post' : 'text'
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function sendFeishuBotNotification(
  payload: NotificationPayload,
  override?: AlertChannelConfig
): Promise<NotificationResult> {
  return sendFeishuMessage(
    {
      msg_type: 'text',
      content: JSON.stringify({
        text: `${payload.title}\n${payload.text}`
      })
    },
    override
  );
}

export async function sendFeishuPostNotification(
  payload: NotificationPayload,
  override?: AlertChannelConfig
): Promise<NotificationResult> {
  if (!payload.feishuPostPayload) {
    return { ok: false, error: 'Missing Feishu post payload' };
  }

  return sendFeishuMessage(
    {
      msg_type: 'post',
      content: JSON.stringify(payload.feishuPostPayload)
    },
    override
  );
}

export async function sendFeishuInteractiveCardNotification(
  payload: NotificationPayload,
  override?: AlertChannelConfig
): Promise<NotificationResult> {
  if (!payload.feishuCardPayload) {
    return { ok: false, error: 'Missing Feishu interactive card payload' };
  }

  return sendFeishuMessage(
    {
      msg_type: 'interactive',
      content: JSON.stringify(payload.feishuCardPayload)
    },
    override
  );
}

export async function sendWebhookNotification(
  payload: NotificationPayload,
  overrideUrl?: string | null
): Promise<NotificationResult> {
  const url = (typeof overrideUrl === 'string' ? overrideUrl.trim() : '') || env.alertWebhookUrl.trim();
  if (!url) {
    return { ok: false, error: 'No webhook URL configured' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: {
          text: `${payload.title}\n${payload.text}`
        },
        ...payload.extra
      })
    });

    return { ok: res.ok, status: res.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function sendAlertNotification(
  payload: NotificationPayload,
  channel?: AlertChannelConfig
): Promise<NotificationResult> {
  const feishuResult = await sendFeishuBotNotification(payload, channel);
  if (feishuResult.ok) {
    return feishuResult;
  }

  return sendWebhookNotification(payload, channel?.notify_webhook_url);
}
