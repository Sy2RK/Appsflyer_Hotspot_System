export interface AsaKeywordCycleStatusInput {
  failed_slice_count: number;
  retryable_failed_slice_count?: number;
}

export function didAsaKeywordCycleComplete(result: AsaKeywordCycleStatusInput): boolean {
  const retryableFailedCount =
    typeof result.retryable_failed_slice_count === 'number'
      ? result.retryable_failed_slice_count
      : result.failed_slice_count;
  return retryableFailedCount === 0;
}

export function summarizeAsaKeywordCycleStatus(result: AsaKeywordCycleStatusInput): 'success' | 'failed' {
  return didAsaKeywordCycleComplete(result) ? 'success' : 'failed';
}
