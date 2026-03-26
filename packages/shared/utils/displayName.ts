interface DisplayNameShape {
  app_key: string;
  display_name?: string | null;
  ios_display_name?: string | null;
  android_display_name?: string | null;
}

function cleanValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePlatform(platform: string | null | undefined): string {
  const value = cleanValue(platform).toLowerCase();
  if (value === 'ios' || value === 'android') {
    return value;
  }
  return 'unknown';
}

export function resolveDisplayName(appKey: string, displayName?: string | null): string {
  const raw = cleanValue(displayName);
  if (raw) {
    return raw;
  }
  return appKey.replace(/-/g, ' ').trim();
}

export function resolvePlatformDisplayName(
  appKey: string,
  fallbackDisplayName: string,
  rawValue: string | null | undefined,
  platformSuffix: 'iOS' | 'Android'
): string {
  const value = cleanValue(rawValue);
  if (value) {
    return value;
  }
  const base = fallbackDisplayName || resolveDisplayName(appKey);
  return `${base} ${platformSuffix}`.trim();
}

export function resolveProductViewName(
  app: DisplayNameShape | null | undefined,
  platform: string | null | undefined
): string {
  const appKey = cleanValue(app?.app_key);
  const normalizedPlatform = normalizePlatform(platform);

  const base = resolveDisplayName(appKey, app?.display_name);
  if (normalizedPlatform === 'ios') {
    return resolvePlatformDisplayName(appKey, base, app?.ios_display_name, 'iOS');
  }
  if (normalizedPlatform === 'android') {
    return resolvePlatformDisplayName(appKey, base, app?.android_display_name, 'Android');
  }
  return base;
}
