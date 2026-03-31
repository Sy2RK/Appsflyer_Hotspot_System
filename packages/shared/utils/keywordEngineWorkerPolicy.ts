export function didKeywordEngineCycleComplete(result: { failed_count: number }): boolean {
  return result.failed_count === 0;
}

export function resolveKeywordEngineBackfillDays(
  hasCompletedRun: boolean,
  initialBackfillDays: number,
  rollingBackfillDays: number
): number {
  return hasCompletedRun ? rollingBackfillDays : initialBackfillDays;
}
