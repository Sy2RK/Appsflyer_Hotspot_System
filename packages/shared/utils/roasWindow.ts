import type { RecommendationPolicyRuleJson, RoasDataStatus } from '../types/models.js';
import { shiftDateString } from './businessDate.js';
import { env } from '../config/env.js';

const DEFAULT_EXCLUDE_RECENT_DAYS = 7;
const DEFAULT_DECISION_WINDOW_DAYS = 14;

function getRoasCostCoverageThreshold(): number {
  return env.roasCostCoverageThreshold;
}

export interface MatureRoasWindow {
  from: string;
  to: string;
}

export function resolveRoasCoverageRatio(input: { coveredCost?: number | null; missingCost?: number | null }): number {
  const coveredCost = Math.max(0, Number(input.coveredCost || 0));
  const missingCost = Math.max(0, Number(input.missingCost || 0));
  const totalCost = coveredCost + missingCost;
  if (totalCost <= 0) {
    return 0;
  }
  return coveredCost / totalCost;
}

export function isRoasDataUsableStatus(status: RoasDataStatus | null | undefined): boolean {
  return status === 'complete' || status === 'partial';
}

export function buildMatureRoasWindow(
  reportDate: string,
  policy: RecommendationPolicyRuleJson | null,
  fallback: { excludeRecentDays?: number; decisionWindowDays?: number } = {}
): MatureRoasWindow {
  const window = policy?.maturity_window;
  const excludeRecentDays = Math.max(
    DEFAULT_EXCLUDE_RECENT_DAYS,
    Math.floor(
      Number(
        window?.exclude_recent_days ??
          fallback.excludeRecentDays ??
          DEFAULT_EXCLUDE_RECENT_DAYS
      ) || 0
    )
  );
  const decisionWindowDays = Math.max(
    1,
    Math.floor(
      Number(
        window?.decision_window_days ??
          fallback.decisionWindowDays ??
          DEFAULT_DECISION_WINDOW_DAYS
      ) || 0
    )
  );
  const to = shiftDateString(reportDate, -excludeRecentDays);
  const from = shiftDateString(to, -(decisionWindowDays - 1));
  return { from, to };
}

export function resolveRoasDataStatus(input: {
  hasWindowRows: boolean;
  hasSpend: boolean;
  coveredCost?: number | null;
  missingCost?: number | null;
}): RoasDataStatus {
  if (!input.hasWindowRows || !input.hasSpend) {
    return 'unavailable';
  }
  const missingCost = Math.max(0, Number(input.missingCost || 0));
  if (missingCost > 0) {
    const coverageRatio = resolveRoasCoverageRatio({
      coveredCost: input.coveredCost,
      missingCost
    });
    if (coverageRatio < getRoasCostCoverageThreshold()) {
      return 'pending';
    }
    return 'partial';
  }
  return 'complete';
}
