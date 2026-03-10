import { KeywordExtractRuleRecord, KeywordLifecycleStage } from '../types/models.js';

export interface KeywordExtractResult {
  keyword: string;
  matchType: string;
  matchedRuleId: number | null;
}

export interface KeywordLifecycleInput {
  daysActive: number;
  lastCpi: number;
  lastInstalls: number;
  lastClicks: number;
  last7Installs: number;
  last7Clicks: number;
  last7Cost: number;
  last7Cvr: number;
  last3Installs: number;
  prev3Installs: number;
  appBaselineCpi: number;
  appBaselineCvr: number;
}

export interface KeywordLifecycleOutput {
  stage: KeywordLifecycleStage;
  stageScore: number;
  reasonCode: string;
}

function cleanKeyword(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) {
    return 'unknown_keyword';
  }
  return text.slice(0, 120);
}

function cleanOptional(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 120) : '';
}

export function inferMatchType(input: string): string {
  const lower = input.toLowerCase();
  if (lower.includes('exact')) return 'exact';
  if (lower.includes('phrase')) return 'phrase';
  if (lower.includes('broad')) return 'broad';
  return 'unknown';
}

export function extractKeywordFromCampaign(
  campaign: string,
  rules: KeywordExtractRuleRecord[]
): KeywordExtractResult {
  const safeCampaign = cleanKeyword(campaign || 'unknown_campaign');
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    if (!rule.enabled) {
      continue;
    }

    try {
      const regex = new RegExp(rule.regex_pattern, 'i');
      const match = regex.exec(safeCampaign);
      if (!match) {
        continue;
      }

      const keyword = cleanKeyword(match[rule.keyword_group_index] ?? '');
      const matchType =
        cleanOptional(match[rule.match_type_group_index ?? -1] ?? '') || inferMatchType(safeCampaign);

      return {
        keyword,
        matchType: matchType || inferMatchType(safeCampaign),
        matchedRuleId: rule.id
      };
    } catch {
      continue;
    }
  }

  return {
    keyword: safeCampaign,
    matchType: inferMatchType(safeCampaign),
    matchedRuleId: null
  };
}

function safeDiv(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) {
    return 0;
  }
  return a / b;
}

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

export function evaluateKeywordLifecycle(input: KeywordLifecycleInput): KeywordLifecycleOutput {
  const growth3 = safeDiv(input.last3Installs - input.prev3Installs, Math.max(input.prev3Installs, 1));
  const baselineCpi = input.appBaselineCpi > 0 ? input.appBaselineCpi : Math.max(input.lastCpi, 1);
  const baselineCvr = input.appBaselineCvr > 0 ? input.appBaselineCvr : Math.max(input.last7Cvr, 0.0001);

  if (input.daysActive <= 3) {
    return {
      stage: 'new',
      stageScore: clamp(35 + input.daysActive * 6, 20, 55),
      reasonCode: 'age_le_3d'
    };
  }

  if (input.last7Clicks < 30) {
    return {
      stage: 'learning',
      stageScore: clamp(45 + input.last7Clicks * 0.25, 35, 65),
      reasonCode: 'clicks_low_learning'
    };
  }

  if (
    input.last7Cost >= 20 &&
    input.last7Installs <= 2 &&
    (input.lastCpi > baselineCpi * 1.5 || input.last7Cvr < baselineCvr * 0.6)
  ) {
    return {
      stage: 'pause_candidate',
      stageScore: clamp(20 - input.last7Installs * 2, 5, 25),
      reasonCode: 'cost_high_output_low'
    };
  }

  if (growth3 >= 0.2 && input.lastCpi <= baselineCpi * 0.9 && input.last7Clicks >= 50) {
    return {
      stage: 'scaling',
      stageScore: clamp(78 + growth3 * 25, 70, 95),
      reasonCode: 'growth_up_efficiency_good'
    };
  }

  if (growth3 <= -0.25 || input.lastCpi > baselineCpi * 1.2) {
    return {
      stage: 'declining',
      stageScore: clamp(48 - Math.abs(growth3) * 20, 20, 55),
      reasonCode: 'trend_down_or_cpi_high'
    };
  }

  return {
    stage: 'stable',
    stageScore: clamp(68 + (0.2 - Math.abs(growth3)) * 20, 55, 85),
    reasonCode: 'within_normal_band'
  };
}
