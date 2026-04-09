import type { AiBuiltContextPack, AiContextPackSpec } from './aiContextPacks.js';

export const GURU_MCP_TOOL_NAMES = {
  appsList: 'apps.list',
  metricsGetTrend: 'metrics.get_trend',
  roasGetSummary: 'roas.get_summary',
  budgetGetSummary: 'budget.get_summary',
  asaKeywordsGetSummary: 'asa_keywords.get_summary'
} as const;

export type GuruMcpToolName = (typeof GURU_MCP_TOOL_NAMES)[keyof typeof GURU_MCP_TOOL_NAMES];

export interface GuruMcpStructuredResult extends Record<string, unknown> {
  title: string;
  summary_markdown: string;
  structured: Record<string, unknown>;
  row_count: number;
  truncated: boolean;
  applied_filters: Record<string, unknown>;
  warnings?: string[];
}

export interface GuruMcpAppsListApp {
  app_key: string;
  display_name: string;
  ios_display_name: string;
  android_display_name: string;
  dataset: string;
  timezone: string;
  has_ios_app_id: boolean;
  has_android_app_id: boolean;
}

export interface GuruMcpAppsListResult extends GuruMcpStructuredResult {
  structured: {
    apps: GuruMcpAppsListApp[];
  };
}

export function toGuruMcpStructuredResult(pack: AiBuiltContextPack, warnings: string[] = []): GuruMcpStructuredResult {
  return {
    title: pack.title,
    summary_markdown: pack.summaryMarkdown,
    structured: pack.structured,
    row_count: pack.rowCount,
    truncated: pack.truncated,
    applied_filters: pack.appliedFilters,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

export function resolveGuruMcpToolForContextPack(spec: AiContextPackSpec): {
  name: GuruMcpToolName;
  arguments: Record<string, unknown>;
} {
  if (spec.type === 'metrics_trend') {
    return {
      name: GURU_MCP_TOOL_NAMES.metricsGetTrend,
      arguments: {
        appKey: spec.appKey,
        platform: spec.platform,
        from: spec.from,
        to: spec.to,
        templateId: spec.templateId,
        source: spec.source,
        metric: spec.metric,
        eventName: spec.eventName
      }
    };
  }
  if (spec.type === 'budget_summary') {
    return {
      name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
      arguments: {
        appKey: spec.appKey,
        platform: spec.platform,
        from: spec.from,
        to: spec.to,
        templateId: spec.templateId,
        status: spec.status,
        executionStatus: spec.executionStatus,
        isAdopted: spec.isAdopted,
        hasManualReview: spec.hasManualReview
      }
    };
  }
  if (spec.type === 'roas_summary') {
    return {
      name: GURU_MCP_TOOL_NAMES.roasGetSummary,
      arguments: {
        appKey: spec.appKey,
        platform: spec.platform,
        reportDate: spec.reportDate,
        templateId: spec.templateId
      }
    };
  }
  if (spec.type === 'asa_keyword_summary') {
    return {
      name: GURU_MCP_TOOL_NAMES.asaKeywordsGetSummary,
      arguments: {
        appKey: spec.appKey,
        platform: spec.platform,
        from: spec.from,
        to: spec.to,
        templateId: spec.templateId,
        stage: spec.stage,
        keyword: spec.keyword,
        campaign: spec.campaign
      }
    };
  }
  throw new Error(`unsupported_context_pack_type:${String((spec as { type?: unknown }).type || 'unknown')}`);
}
