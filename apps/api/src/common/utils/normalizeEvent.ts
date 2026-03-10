import { md5Hex } from '@shared/utils/hash.js';
import { stableStringify } from '@shared/utils/stableStringify.js';
import { AttributionType, EventType, NormalizedEvent } from '@shared/types/models.js';

function firstString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function parseEventTime(payload: Record<string, unknown>): Date {
  const candidates = [
    payload.event_time,
    payload.install_time,
    payload.attributed_touch_time,
    payload.timestamp,
    payload.eventTime
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }

  return new Date();
}

function parseRevenue(payload: Record<string, unknown>): number {
  const candidates = [
    payload.event_revenue,
    payload.event_revenue_usd,
    payload.af_revenue,
    payload.revenue,
    payload.af_price
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const parsed = Number(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

function parseEventType(payload: Record<string, unknown>): EventType {
  const retargetingSignals = [
    payload.is_retargeting,
    payload.retargeting_conversion_type,
    payload.is_primary_attribution
  ];

  for (const signal of retargetingSignals) {
    const normalized = String(signal ?? '').toLowerCase();
    if (['true', '1', 'retargeting', 're-engagement', 're-attribution'].includes(normalized)) {
      return 'retargeting';
    }
  }

  const installType = String(payload.install_type ?? payload.event_type ?? '').toLowerCase();
  if (installType.includes('install') || installType.includes('ua')) {
    return 'ua';
  }

  return 'unknown';
}

function parseAttribution(payload: Record<string, unknown>): AttributionType {
  const mediaSource = firstString(payload, ['media_source', 'pid', 'af_media_source']);
  const isOrganic = String(payload.is_organic ?? '').toLowerCase();
  if (isOrganic === 'true' || isOrganic === '1') {
    return 'organic';
  }
  if (!mediaSource || mediaSource.toLowerCase() === 'organic') {
    return 'organic';
  }
  if (mediaSource) {
    return 'non_organic';
  }
  return 'unknown';
}

function getEventValue(payload: Record<string, unknown>): string {
  const rawValue = payload.event_value ?? payload.af_event_value;
  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue);
      return stableStringify(parsed);
    } catch {
      return rawValue;
    }
  }

  if (rawValue === undefined || rawValue === null) {
    return '';
  }

  return stableStringify(rawValue);
}

function resolveUniqueId(payload: Record<string, unknown>): string | undefined {
  return firstString(payload, [
    'event_uuid',
    'af_event_id',
    'event_id',
    'transaction_id',
    'af_transaction_id'
  ]);
}

export function normalizeEvent(input: {
  appKey: string;
  dataset: string;
  payload: Record<string, unknown>;
  ingestTime?: Date;
}): NormalizedEvent {
  const { appKey, dataset, payload } = input;
  const ingestTime = input.ingestTime ?? new Date();

  const eventTime = parseEventTime(payload);
  const eventName = firstString(payload, ['event_name', 'af_event_name']) ?? 'unknown';
  const eventType = parseEventType(payload);
  const attribution = parseAttribution(payload);
  const mediaSource = firstString(payload, ['media_source', 'af_media_source', 'pid']) ?? 'unknown';
  const campaign = firstString(payload, ['campaign', 'af_campaign']) ?? 'unknown';
  const adset = firstString(payload, ['adset', 'af_adset']) ?? 'unknown';
  const ad = firstString(payload, ['ad', 'af_ad']) ?? 'unknown';
  const country = firstString(payload, ['country_code', 'country']) ?? 'unknown';
  const platform = firstString(payload, ['platform', 'os', 'device_platform']) ?? 'unknown';
  const afId = firstString(payload, ['appsflyer_id', 'af_id']) ?? '';
  const deviceId =
    firstString(payload, ['advertising_id', 'idfa', 'gaid', 'android_id', 'customer_user_id']) ?? '';
  const revenue = parseRevenue(payload);
  const currency = firstString(payload, ['currency', 'event_revenue_currency']) ?? 'unknown';
  const eventValueJson = getEventValue(payload);
  const rawJson = JSON.stringify(payload);

  const uniqueId = resolveUniqueId(payload);
  const eventUid =
    uniqueId
      ? md5Hex([appKey, dataset, uniqueId].join('|'))
      :
    md5Hex(
      [
        appKey,
        dataset,
        eventTime.toISOString(),
        eventName,
        afId || deviceId || '',
        mediaSource || '',
        campaign || '',
        revenue || 0,
        stableStringify(eventValueJson)
      ].join('|')
    );

  return {
    app_key: appKey,
    dataset,
    event_time: eventTime,
    ingest_time: ingestTime,
    event_name: eventName,
    event_type: eventType,
    attribution,
    media_source: mediaSource,
    campaign,
    adset,
    ad,
    country,
    platform,
    af_id: afId,
    device_id: deviceId,
    revenue,
    currency,
    event_value_json: eventValueJson,
    raw_json: rawJson,
    event_uid: eventUid
  };
}
