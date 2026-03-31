import { Router } from 'express';
import { verifyPushAuthorization } from '../../common/auth/pushAuth.js';
import { logger } from '../../common/logger/logger.js';
import { normalizeEvent } from '../../common/utils/normalizeEvent.js';
import { requestMetrics } from '../../common/utils/request.js';
import { chInsertJSON, chQuery } from '../../common/clickhouse/client.js';
import { claimIngestDedupKeys, releaseIngestDedupKeys } from '@shared/utils/repositories.js';

const router = Router();

router.get('/appsflyer/api/v1/event/:appKey/:dataset/callback', (req, res) => {
  const { appKey, dataset } = req.params;
  res.status(200).json({ ok: true, appKey, dataset });
});

router.post('/appsflyer/api/v1/event/:appKey/:dataset/callback', async (req, res) => {
  const { appKey, dataset } = req.params;
  const requestId = req.requestId;
  requestMetrics.totalPushRequests += 1;

  try {
    const authResult = await verifyPushAuthorization({
      appKey,
      dataset,
      authorization: req.header('authorization')
    });

    if (!authResult.ok) {
      requestMetrics.pushErrors += 1;
      logger.warn('push_auth_failed', {
        request_id: requestId,
        app_key: appKey,
        dataset,
        reason: authResult.reason
      });
      return res.status(401).json({ ok: false, error: authResult.reason });
    }

    if (!req.body || typeof req.body !== 'object') {
      requestMetrics.pushErrors += 1;
      return res.status(400).json({ ok: false, error: 'invalid_json_payload' });
    }

    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const normalizedRows: Record<string, unknown>[] = [];
    const claimCandidates: Array<{ event_uid: string; app_key: string }> = [];
    const seenInRequest = new Set<string>();

    for (const payloadItem of payloads) {
      if (!payloadItem || typeof payloadItem !== 'object') {
        continue;
      }

      const normalized = normalizeEvent({
        appKey,
        dataset,
        payload: payloadItem as Record<string, unknown>,
        ingestTime: new Date()
      });

      const duplicate = await chQuery<{ c: string }>(
        `SELECT toString(count()) AS c
           FROM raw_events
          WHERE app_key = {app_key:String}
            AND event_uid = {event_uid:String}
          LIMIT 1`,
        {
          app_key: normalized.app_key,
          event_uid: normalized.event_uid
        }
      );

      if (Number(duplicate[0]?.c ?? '0') > 0) {
        continue;
      }
      if (seenInRequest.has(normalized.event_uid)) {
        continue;
      }
      seenInRequest.add(normalized.event_uid);
      claimCandidates.push({
        event_uid: normalized.event_uid,
        app_key: normalized.app_key
      });

      normalizedRows.push({
        event_date: normalized.event_time.toISOString().slice(0, 10),
        event_time: normalized.event_time.toISOString().slice(0, 19).replace('T', ' '),
        install_time: normalized.install_time.toISOString().slice(0, 19).replace('T', ' '),
        ingest_time: normalized.ingest_time.toISOString().slice(0, 19).replace('T', ' '),
        app_key: normalized.app_key,
        dataset: normalized.dataset,
        event_name: normalized.event_name,
        event_type: normalized.event_type,
        attribution: normalized.attribution,
        media_source: normalized.media_source ?? 'unknown',
        campaign: normalized.campaign ?? 'unknown',
        adset: normalized.adset ?? 'unknown',
        ad: normalized.ad ?? 'unknown',
        country: normalized.country ?? 'unknown',
        platform: normalized.platform ?? 'unknown',
        af_id: normalized.af_id ?? '',
        device_id: normalized.device_id ?? '',
        revenue: normalized.revenue ?? 0,
        currency: normalized.currency ?? 'unknown',
        event_value_json: normalized.event_value_json ?? '',
        event_uid: normalized.event_uid,
        raw_json: normalized.raw_json
      });
    }

    const claimedEventUids = Array.from(await claimIngestDedupKeys(claimCandidates));
    const claimedSet = new Set(claimedEventUids);
    const rowsToInsert = normalizedRows.filter((row) => claimedSet.has(String(row.event_uid ?? '')));

    const start = Date.now();
    try {
      await chInsertJSON('raw_events', rowsToInsert);
      requestMetrics.clickhouseInsertLatencyMs.push(Date.now() - start);
    } catch (error) {
      await releaseIngestDedupKeys(claimedEventUids);
      throw error;
    }

    logger.info('push_ingested', {
      request_id: requestId,
      app_key: appKey,
      dataset,
      rows: rowsToInsert.length
    });

    return res.status(204).send();
  } catch (error) {
    requestMetrics.pushErrors += 1;
    logger.error('push_ingest_failed', {
      request_id: requestId,
      app_key: appKey,
      dataset,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

export default router;
