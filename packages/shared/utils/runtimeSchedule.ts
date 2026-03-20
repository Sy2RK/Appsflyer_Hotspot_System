import { env } from '../config/env.js';
import { ensureRuntimeScheduleConfig, upsertRuntimeScheduleConfig } from './repositories.js';

export interface RuntimeScheduleSnapshot {
  singleton_key: string;
  pull_time: string;
  push_time: string;
  bitable_time: string;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface DailyTimeTarget {
  time: string;
  hour: number;
  minute: number;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function formatDailyTime(hour: number, minute = 0): string {
  return `${String(Math.max(0, Math.min(23, hour))).padStart(2, '0')}:${String(Math.max(0, Math.min(59, minute))).padStart(2, '0')}`;
}

export function isValidDailyTime(value: string): boolean {
  return TIME_PATTERN.test(String(value || '').trim());
}

export function parseDailyTime(value: string): DailyTimeTarget {
  const normalized = String(value || '').trim();
  const match = TIME_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(`invalid_daily_time:${normalized}`);
  }
  return {
    time: normalized,
    hour: Number(match[1]),
    minute: Number(match[2])
  };
}

export function addMinutesToDailyTime(value: string, minutes: number): string {
  const { hour, minute } = parseDailyTime(value);
  const totalMinutes = ((hour * 60 + minute + minutes) % (24 * 60) + 24 * 60) % (24 * 60);
  return formatDailyTime(Math.floor(totalMinutes / 60), totalMinutes % 60);
}

export function getDefaultPullTime(): string {
  return formatDailyTime(env.pullerReportHour, 0);
}

export function getDefaultPushTime(): string {
  return formatDailyTime(env.dailyBriefReportHour, 0);
}

function normalizeDailyTime(value: string, fallback: string): string {
  return isValidDailyTime(value) ? value : fallback;
}

export async function getRuntimeScheduleSnapshot(): Promise<RuntimeScheduleSnapshot> {
  const record = await ensureRuntimeScheduleConfig(getDefaultPullTime(), getDefaultPushTime());
  const pullTime = normalizeDailyTime(record.pull_time, getDefaultPullTime());
  const pushTime = normalizeDailyTime(record.push_time, getDefaultPushTime());

  return {
    singleton_key: record.singleton_key,
    pull_time: pullTime,
    push_time: pushTime,
    bitable_time: addMinutesToDailyTime(pushTime, 5),
    timezone: env.timezone,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export async function saveRuntimeSchedule(input: {
  pull_time: string;
  push_time: string;
}): Promise<RuntimeScheduleSnapshot> {
  const pullTime = String(input.pull_time || '').trim();
  const pushTime = String(input.push_time || '').trim();

  if (!isValidDailyTime(pullTime)) {
    throw new Error('invalid_pull_time');
  }
  if (!isValidDailyTime(pushTime)) {
    throw new Error('invalid_push_time');
  }

  await upsertRuntimeScheduleConfig({
    pull_time: pullTime,
    push_time: pushTime
  });

  return getRuntimeScheduleSnapshot();
}

export async function getPullScheduleTarget(): Promise<DailyTimeTarget> {
  return parseDailyTime((await getRuntimeScheduleSnapshot()).pull_time);
}

export async function getPushScheduleTarget(): Promise<DailyTimeTarget> {
  return parseDailyTime((await getRuntimeScheduleSnapshot()).push_time);
}

export async function getBitableScheduleTarget(): Promise<DailyTimeTarget> {
  return parseDailyTime((await getRuntimeScheduleSnapshot()).bitable_time);
}
