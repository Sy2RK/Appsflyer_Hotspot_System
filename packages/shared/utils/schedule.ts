export interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function normalizeHour(value: number): number {
  return value === 24 ? 0 : value;
}

export function getTzParts(date: Date, timeZone: string): TzParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(date);
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');

  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: normalizeHour(pick('hour')),
    minute: pick('minute')
  };
}

export function hasReachedDailyHour(targetHour: number, timeZone: string, now = new Date()): boolean {
  return getTzParts(now, timeZone).hour >= targetHour;
}

export function hasReachedDailyTime(
  targetHour: number,
  targetMinute: number,
  timeZone: string,
  now = new Date()
): boolean {
  const parts = getTzParts(now, timeZone);
  return parts.hour > targetHour || (parts.hour === targetHour && parts.minute >= targetMinute);
}

export function msUntilNextDailyHour(targetHour: number, timeZone: string, now = new Date()): number {
  return msUntilNextDailyTime(targetHour, 0, timeZone, now);
}

export function msUntilNextDailyTime(
  targetHour: number,
  targetMinute: number,
  timeZone: string,
  now = new Date()
): number {
  const start = new Date(now.getTime() + 60 * 1000);
  start.setUTCSeconds(0, 0);

  for (let minuteOffset = 0; minuteOffset < 60 * 48; minuteOffset += 1) {
    const candidate = new Date(start.getTime() + minuteOffset * 60 * 1000);
    const parts = getTzParts(candidate, timeZone);
    if (parts.hour === targetHour && parts.minute === targetMinute) {
      return Math.max(candidate.getTime() - now.getTime(), 1000);
    }
  }

  return 60 * 60 * 1000;
}

export function nextDailyHourLocalString(targetHour: number, timeZone: string, now = new Date()): string {
  return nextDailyTimeLocalString(targetHour, 0, timeZone, now);
}

export function nextDailyTimeLocalString(
  targetHour: number,
  targetMinute: number,
  timeZone: string,
  now = new Date()
): string {
  const start = new Date(now.getTime() + 60 * 1000);
  start.setUTCSeconds(0, 0);

  for (let minuteOffset = 0; minuteOffset < 60 * 48; minuteOffset += 1) {
    const candidate = new Date(start.getTime() + minuteOffset * 60 * 1000);
    const parts = getTzParts(candidate, timeZone);
    if (parts.hour === targetHour && parts.minute === targetMinute) {
      return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} (${timeZone})`;
    }
  }

  const parts = getTzParts(now, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')} (${timeZone})`;
}
