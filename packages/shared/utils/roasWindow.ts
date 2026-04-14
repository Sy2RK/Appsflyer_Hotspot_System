import type {
  RecommendationPolicyRuleJson,
  RoasDataStatus,
  RoasPrimarySource,
  RoasWarningCode
} from '../types/models.js';
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

const ROAS_DEVIATION_RATIO_THRESHOLD = 0.2;
const ROAS_DEVIATION_ABSOLUTE_THRESHOLD = 0.15;

export function resolveRoasCoverageRatio(input: { coveredCost?: number | null; missingCost?: number | null }): number {
  const coveredCost = Math.max(0, Number(input.coveredCost || 0));
  const missingCost = Math.max(0, Number(input.missingCost || 0));
  const totalCost = coveredCost + missingCost;
  if (totalCost <= 0) {
    return 0;
  }
  return coveredCost / totalCost;
}

export function normalizeAfCohortRoasRate(value: number | null | undefined): number {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw < 0) {
    return 0;
  }
  return raw / 100;
}

function hasRoasValue(value: number | null | undefined): boolean {
  return value != null && Number.isFinite(Number(value)) && Number(value) >= 0;
}

export function calculateRoasDeviationRatio(
  afCohortRoas: number | null | undefined,
  localDerivedRoas: number | null | undefined
): number | null {
  const af = Number(afCohortRoas);
  const local = Number(localDerivedRoas);
  if (!hasRoasValue(afCohortRoas) || !hasRoasValue(localDerivedRoas)) {
    return null;
  }
  const denominator = Math.max(Math.abs(af), Math.abs(local), 0.01);
  return Math.abs(af - local) / denominator;
}

export function hasRoasDeviationMismatch(
  afCohortRoas: number | null | undefined,
  localDerivedRoas: number | null | undefined
): boolean {
  const af = Number(afCohortRoas);
  const local = Number(localDerivedRoas);
  if (!hasRoasValue(afCohortRoas) || !hasRoasValue(localDerivedRoas)) {
    return false;
  }
  const deviationRatio = calculateRoasDeviationRatio(af, local);
  const absoluteDiff = Math.abs(af - local);
  return Boolean(
    (deviationRatio != null && deviationRatio > ROAS_DEVIATION_RATIO_THRESHOLD) ||
      absoluteDiff > ROAS_DEVIATION_ABSOLUTE_THRESHOLD
  );
}

export function resolveRoasPrimarySource(input: {
  afCohortRoas?: number | null;
  localDerivedRoas?: number | null;
}): RoasPrimarySource {
  if (hasRoasValue(input.afCohortRoas)) {
    return 'af_cohort';
  }
  return 'local_fallback';
}

export function resolveRoasWarningCode(input: {
  afCohortRoas?: number | null;
  localDerivedRoas?: number | null;
  forceGrainUnavailable?: boolean;
}): RoasWarningCode {
  const hasAf = hasRoasValue(input.afCohortRoas);
  const hasLocal = hasRoasValue(input.localDerivedRoas);

  if (input.forceGrainUnavailable && hasLocal) {
    return 'af_grain_unavailable';
  }
  if (!hasAf && hasLocal) {
    return 'af_missing';
  }
  if (hasAf && hasLocal && hasRoasDeviationMismatch(input.afCohortRoas, input.localDerivedRoas)) {
    return 'af_vs_local_mismatch';
  }
  return 'none';
}

export function shouldHoldForRoasProtection(input: {
  primarySource: RoasPrimarySource;
  warningCode: RoasWarningCode;
}): boolean {
  if (input.primarySource !== 'af_cohort') {
    return true;
  }
  return input.warningCode === 'af_vs_local_mismatch';
}

export function isRoasDataUsableStatus(status: RoasDataStatus | null | undefined): boolean {
  return status === 'complete' || status === 'partial';
}

export function isRoasDataDisplayableStatus(status: RoasDataStatus | null | undefined): boolean {
  return status === 'complete' || status === 'partial' || status === 'partial_low';
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
    const threshold = getRoasCostCoverageThreshold();
    const partialLowThreshold = threshold * 0.5; // 80% * 0.5 = 40%
    const pendingThreshold = threshold * 0.25;   // 80% * 0.25 = 20%

    if (coverageRatio >= threshold) {
      return 'partial';
    }
    if (coverageRatio >= partialLowThreshold) {
      return 'partial_low';
    }
    if (coverageRatio >= pendingThreshold) {
      return 'pending';
    }
    return 'unavailable';
  }
  return 'complete';
}
