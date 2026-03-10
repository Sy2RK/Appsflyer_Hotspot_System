import { getAppByKeyAndDataset } from '@shared/utils/repositories.js';
import { AppConfigRecord } from '@shared/types/models.js';

export interface PushAuthResult {
  ok: boolean;
  app?: AppConfigRecord;
  reason?: string;
}

function normalizeAuthHeader(authorization: string | undefined): string {
  if (!authorization) {
    return '';
  }
  return authorization.replace(/^Bearer\s+/i, '').trim();
}

export async function verifyPushAuthorization(params: {
  appKey: string;
  dataset: string;
  authorization?: string;
}): Promise<PushAuthResult> {
  const app = await getAppByKeyAndDataset(params.appKey, params.dataset);
  if (!app) {
    return {
      ok: false,
      reason: 'app_key_or_dataset_not_found'
    };
  }

  const incomingToken = normalizeAuthHeader(params.authorization);
  const configuredToken = normalizeAuthHeader(app.push_auth_token);

  if (!incomingToken || incomingToken !== configuredToken) {
    return {
      ok: false,
      reason: 'authorization_invalid'
    };
  }

  return {
    ok: true,
    app
  };
}
