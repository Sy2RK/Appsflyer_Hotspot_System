import { ParsedWindow } from '../types/rules.js';

export function parseWindow(windowExpr: string): ParsedWindow {
  const match = /^last_(\d+)h$/.exec(windowExpr);
  if (!match) {
    throw new Error(`Unsupported window expression: ${windowExpr}`);
  }
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`Invalid hours in window expression: ${windowExpr}`);
  }
  return {
    hours,
    label: windowExpr
  };
}

export function floorToHour(date: Date): Date {
  const copy = new Date(date);
  copy.setMinutes(0, 0, 0);
  return copy;
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function toCHDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}
