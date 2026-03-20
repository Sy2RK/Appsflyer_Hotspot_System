import { env } from '../config/env.js';
import { getTzParts } from './schedule.js';

export function formatDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function shiftDateString(dateString: string, days: number): string {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function getDateStringInTimezone(now = new Date(), timeZone = env.timezone): string {
  const parts = getTzParts(now, timeZone);
  return formatDateString(parts.year, parts.month, parts.day);
}

export function getPreviousDateString(daysBack = 1, now = new Date(), timeZone = env.timezone): string {
  return shiftDateString(getDateStringInTimezone(now, timeZone), -Math.max(0, Math.floor(daysBack)));
}

export function buildPreviousDateList(backfillDays: number, now = new Date(), timeZone = env.timezone): string[] {
  const days = Math.max(1, Math.floor(backfillDays));
  const result: string[] = [];
  for (let i = 1; i <= days; i += 1) {
    result.push(getPreviousDateString(i, now, timeZone));
  }
  return result;
}
