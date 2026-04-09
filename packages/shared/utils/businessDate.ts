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

export function getDateTimeStringInTimezone(now = new Date(), timeZone = env.timezone): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(now);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';

  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
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
