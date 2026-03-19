import crypto from 'crypto';
import { env } from '../packages/shared/config/env.js';
import { listApps } from '../packages/shared/utils/repositories.js';
import { pgClose } from '../packages/shared/utils/postgres.js';

type CsvRecord = Record<string, string>;

interface AppTarget {
  appKey: string;
  displayName: string;
  platform: string;
  appId: string;
}

interface SourceStats {
  revenue: number;
  cost: number;
  rows: number;
}

interface ProbeResult {
  appKey: string;
  displayName: string;
  platform: string;
  appId: string;
  httpCode: number;
  status: 'ok' | 'failed';
  rows: number;
  rowsWithRevenue: number;
  rowsWithCost: number;
  rowsWithRoasInputs: number;
  mediaSourcesWithRoasInputs: number;
  campaignsWithRoasInputs: number;
  keywordsWithRoasInputs: number;
  sampleMediaSources: string[];
  sampleKeywords: string[];
  error?: string;
}

const REVENUE_FIELDS = ['event_revenue_usd', 'event_revenue', 'af_revenue'];
const COST_FIELDS = ['cost_value', 'cost'];
const MEDIA_SOURCE_FIELDS = ['media_source', 'partner'];
const CAMPAIGN_FIELDS = ['campaign'];
const KEYWORD_FIELDS = ['keywords', 'keyword'];

function argValue(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((entry) => entry.startsWith(prefix));
  if (hit) {
    return hit.slice(prefix.length);
  }
  return fallback;
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];

    if (char === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && csv[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((cell) => cell.trim().length > 0)) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsv(csv: string): CsvRecord[] {
  const rows = parseCsvRows(csv);
  if (rows.length <= 1) {
    return [];
  }

  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((cols) => {
    const record: CsvRecord = {};
    headers.forEach((header, index) => {
      record[header] = (cols[index] ?? '').trim();
    });
    return record;
  });
}

function toNumber(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const cleaned = value.replace(/[,$\s]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNonEmpty(record: CsvRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = (record[key] ?? '').trim();
    if (value) {
      return value;
    }
  }
  return fallback;
}

function firstNumeric(record: CsvRecord, keys: string[]): number {
  for (const key of keys) {
    const parsed = toNumber(record[key]);
    if (parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function stableSignature(records: CsvRecord[]): string {
  const normalized = records
    .map((record) => ({
      media_source: firstNonEmpty(record, MEDIA_SOURCE_FIELDS, 'unknown'),
      campaign: firstNonEmpty(record, CAMPAIGN_FIELDS, 'unknown'),
      keyword: firstNonEmpty(record, KEYWORD_FIELDS, ''),
      revenue_usd: firstNumeric(record, REVENUE_FIELDS),
      cost_value: firstNumeric(record, COST_FIELDS)
    }))
    .sort((a, b) =>
      `${a.media_source}|${a.campaign}|${a.keyword}`.localeCompare(
        `${b.media_source}|${b.campaign}|${b.keyword}`
      )
    );

  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function buildTargets(): AppTarget[] {
  return [];
}

async function resolveTargets(): Promise<AppTarget[]> {
  const apps = await listApps();
  const targets: AppTarget[] = [];

  for (const app of apps) {
    if (app.ios_pull_app_id) {
      targets.push({
        appKey: app.app_key,
        displayName: app.ios_display_name || app.display_name,
        platform: 'ios',
        appId: app.ios_pull_app_id
      });
    } else if (app.pull_app_id) {
      targets.push({
        appKey: app.app_key,
        displayName: app.display_name,
        platform: 'ios',
        appId: app.pull_app_id
      });
    }

    if (app.android_pull_app_id) {
      targets.push({
        appKey: app.app_key,
        displayName: app.android_display_name || app.display_name,
        platform: 'android',
        appId: app.android_pull_app_id
      });
    }
  }

  return targets;
}

async function fetchRawData(appId: string, from: string, to: string): Promise<{ code: number; body: string }> {
  const url = env.rawDataEndpointTemplate
    .replace('{app_id}', encodeURIComponent(appId))
    .concat(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.rawDataToken}`
    },
    redirect: 'follow'
  });

  const body = await response.text();
  return { code: response.status, body };
}

function analyzeRows(target: AppTarget, code: number, body: string): ProbeResult {
  if (code !== 200) {
    return {
      appKey: target.appKey,
      displayName: target.displayName,
      platform: target.platform,
      appId: target.appId,
      httpCode: code,
      status: 'failed',
      rows: 0,
      rowsWithRevenue: 0,
      rowsWithCost: 0,
      rowsWithRoasInputs: 0,
      mediaSourcesWithRoasInputs: 0,
      campaignsWithRoasInputs: 0,
      keywordsWithRoasInputs: 0,
      sampleMediaSources: [],
      sampleKeywords: [],
      error: body.slice(0, 200)
    };
  }

  const records = parseCsv(body);
  const mediaStats = new Map<string, SourceStats>();
  const campaignStats = new Map<string, SourceStats>();
  const keywordStats = new Map<string, SourceStats>();

  let rowsWithRevenue = 0;
  let rowsWithCost = 0;
  let rowsWithRoasInputs = 0;

  for (const record of records) {
    const revenue = firstNumeric(record, REVENUE_FIELDS);
    const cost = firstNumeric(record, COST_FIELDS);
    const mediaSource = firstNonEmpty(record, MEDIA_SOURCE_FIELDS, 'unknown');
    const campaign = firstNonEmpty(record, CAMPAIGN_FIELDS, 'unknown');
    const keyword = firstNonEmpty(record, KEYWORD_FIELDS, '');

    if (revenue > 0) {
      rowsWithRevenue += 1;
    }
    if (cost > 0) {
      rowsWithCost += 1;
    }
    if (revenue > 0 && cost > 0) {
      rowsWithRoasInputs += 1;
    }

    const touch = (map: Map<string, SourceStats>, key: string) => {
      const current = map.get(key) ?? { revenue: 0, cost: 0, rows: 0 };
      current.revenue += revenue;
      current.cost += cost;
      current.rows += 1;
      map.set(key, current);
    };

    touch(mediaStats, mediaSource);
    touch(campaignStats, campaign);
    if (keyword) {
      touch(keywordStats, keyword);
    }
  }

  const readyKeys = (map: Map<string, SourceStats>) =>
    [...map.entries()]
      .filter(([, stats]) => stats.revenue > 0 && stats.cost > 0)
      .map(([key]) => key);

  const readyMediaSources = readyKeys(mediaStats);
  const readyKeywords = readyKeys(keywordStats);

  return {
    appKey: target.appKey,
    displayName: target.displayName,
    platform: target.platform,
    appId: target.appId,
    httpCode: code,
    status: 'ok',
    rows: records.length,
    rowsWithRevenue,
    rowsWithCost,
    rowsWithRoasInputs,
    mediaSourcesWithRoasInputs: readyMediaSources.length,
    campaignsWithRoasInputs: readyKeys(campaignStats).length,
    keywordsWithRoasInputs: readyKeywords.length,
    sampleMediaSources: readyMediaSources.slice(0, 8),
    sampleKeywords: readyKeywords.slice(0, 8)
  };
}

async function main(): Promise<void> {
  if (!env.rawDataToken) {
    throw new Error(
      'Missing Raw Data token. Set BI_APPSFLYER_RAWDATA_TOKEN, bi_appsflyer_rawdata_token or APPSFLYER_RAWDATA_TOKEN.'
    );
  }

  const from = argValue('from', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10))!;
  const to = argValue('to', from)!;
  const appKeyFilter = argValue('appKey');
  const platformFilter = argValue('platform');

  const targets = (await resolveTargets()).filter((target) => {
    if (appKeyFilter && target.appKey !== appKeyFilter) {
      return false;
    }
    if (platformFilter && target.platform !== platformFilter) {
      return false;
    }
    return true;
  });

  const results: ProbeResult[] = [];
  for (const target of targets) {
    try {
      const { code, body } = await fetchRawData(target.appId, from, to);
      results.push(analyzeRows(target, code, body));
    } catch (error) {
      results.push({
        appKey: target.appKey,
        displayName: target.displayName,
        platform: target.platform,
        appId: target.appId,
        httpCode: 0,
        status: 'failed',
        rows: 0,
        rowsWithRevenue: 0,
        rowsWithCost: 0,
        rowsWithRoasInputs: 0,
        mediaSourcesWithRoasInputs: 0,
        campaignsWithRoasInputs: 0,
        keywordsWithRoasInputs: 0,
        sampleMediaSources: [],
        sampleKeywords: [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const summary = {
    from,
    to,
    token_length: env.rawDataToken.length,
    endpoint_template: env.rawDataEndpointTemplate,
    targets: results.length,
    app_platform_ready: results.filter((result) => result.rowsWithRoasInputs > 0).length
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClose();
  });
