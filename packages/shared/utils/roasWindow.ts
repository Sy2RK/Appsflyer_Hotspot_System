import type { RecommendationPolicyRuleJson, RoasDataStatus } from '../types/models.js';
import { shiftDateString } from './businessDate.js';

const DEFAULT_EXCLUDE_RECENT_DAYS = 7;
const DEFAULT_DECISION_WINDOW_DAYS = 14;

export interface MatureRoasWindow {
  from: string;
  to: string;
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
  coverageMissing: boolean;
}): RoasDataStatus {
  if (input.coverageMissing) {
    return 'pending';
  }
  if (!input.hasWindowRows || !input.hasSpend) {
    return 'unavailable';
  }
  return 'complete';
}
