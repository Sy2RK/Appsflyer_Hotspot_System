import {
  getScheduledWorkerRun,
  hasCompletedScheduledWorkerRun,
  markScheduledWorkerRunCompleted,
  markScheduledWorkerRunFailed,
  tryStartScheduledWorkerRunAttempt,
  type ScheduledWorkerRunRecord
} from './repositories.js';

export interface ScheduledWorkerRunPolicy {
  max_attempts: number;
  retry_cooldown_ms: number;
}

export type ScheduledWorkerRunBlockReason = 'completed' | 'cooldown' | 'max_attempts';

export interface ScheduledWorkerRunDecision {
  allowed: boolean;
  reason: ScheduledWorkerRunBlockReason | null;
  attempt_count: number;
  remaining_attempts: number;
  next_allowed_at: string | null;
}

export function evaluateScheduledWorkerRunDecision(
  record: ScheduledWorkerRunRecord | null,
  policy: ScheduledWorkerRunPolicy,
  now = new Date()
): ScheduledWorkerRunDecision {
  if (!record) {
    return {
      allowed: true,
      reason: null,
      attempt_count: 0,
      remaining_attempts: Math.max(0, Math.floor(policy.max_attempts)),
      next_allowed_at: null
    };
  }

  const remainingAttempts = Math.max(0, Math.floor(policy.max_attempts) - Math.max(0, Number(record.attempt_count || 0)));
  if (record.completed_at || record.status === 'completed') {
    return {
      allowed: false,
      reason: 'completed',
      attempt_count: Math.max(0, Number(record.attempt_count || 0)),
      remaining_attempts: remainingAttempts,
      next_allowed_at: null
    };
  }

  if (Number(record.attempt_count || 0) >= Math.max(1, Math.floor(policy.max_attempts))) {
    return {
      allowed: false,
      reason: 'max_attempts',
      attempt_count: Math.max(0, Number(record.attempt_count || 0)),
      remaining_attempts: 0,
      next_allowed_at: record.next_allowed_at || null
    };
  }

  const nextAllowedAt = String(record.next_allowed_at || '').trim();
  if (nextAllowedAt) {
    const nextAllowedAtMs = new Date(nextAllowedAt).getTime();
    if (Number.isFinite(nextAllowedAtMs) && nextAllowedAtMs > now.getTime()) {
      return {
        allowed: false,
        reason: 'cooldown',
        attempt_count: Math.max(0, Number(record.attempt_count || 0)),
        remaining_attempts: remainingAttempts,
        next_allowed_at: nextAllowedAt
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    attempt_count: Math.max(0, Number(record.attempt_count || 0)),
    remaining_attempts: remainingAttempts,
    next_allowed_at: null
  };
}

export async function getScheduledWorkerRunDecision(
  workerName: string,
  runMarker: string,
  policy: ScheduledWorkerRunPolicy,
  now = new Date()
): Promise<ScheduledWorkerRunDecision> {
  const record = await getScheduledWorkerRun(workerName, runMarker);
  return evaluateScheduledWorkerRunDecision(record, policy, now);
}

export async function hasScheduledWorkerCompletedAnyRun(workerName: string): Promise<boolean> {
  return hasCompletedScheduledWorkerRun(workerName);
}

export async function tryClaimScheduledWorkerRunAttempt(
  workerName: string,
  runMarker: string,
  policy: ScheduledWorkerRunPolicy,
  now = new Date()
): Promise<ScheduledWorkerRunDecision> {
  const claimed = await tryStartScheduledWorkerRunAttempt(
    workerName,
    runMarker,
    policy.max_attempts,
    policy.retry_cooldown_ms
  );
  if (claimed) {
    return {
      allowed: true,
      reason: null,
      attempt_count: Math.max(0, Number(claimed.attempt_count || 0)),
      remaining_attempts: Math.max(
        0,
        Math.floor(policy.max_attempts) - Math.max(0, Number(claimed.attempt_count || 0))
      ),
      next_allowed_at: String(claimed.next_allowed_at || '').trim() || null
    };
  }
  const record = await getScheduledWorkerRun(workerName, runMarker);
  return evaluateScheduledWorkerRunDecision(record, policy, now);
}

export async function completeScheduledWorkerRun(workerName: string, runMarker: string): Promise<void> {
  await markScheduledWorkerRunCompleted(workerName, runMarker);
}

export async function failScheduledWorkerRun(
  workerName: string,
  runMarker: string,
  lastError?: string | null
): Promise<void> {
  await markScheduledWorkerRunFailed(workerName, runMarker, lastError);
}
