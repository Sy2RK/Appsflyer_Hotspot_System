import { env } from '../config/env.js';
import { chQuery } from './clickhouse.js';
import {
  buildAiContextPacksViaMcp,
  callGuruMcpTool,
  isMcpTimeoutErrorMessage,
  toGuruMcpUserMessage
} from './mcpClient.js';
import { pgQuery } from './postgres.js';
import {
  GURU_MCP_TOOL_NAMES,
  resolveGuruMcpToolForContextPack,
  type GuruMcpAppsListResult,
  type GuruMcpStructuredResult,
  type GuruMcpToolName
} from './guruMcp.js';

export type AiContextPackType = 'metrics_trend' | 'budget_summary' | 'asa_keyword_summary';
export type AiContextPackTemplateId =
  | 'media_source'
  | 'country'
  | 'campaign'
  | 'platform_media_source'
  | 'action_status'
  | 'keyword'
  | 'stage'
  | 'campaign_adset';

export interface AiChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  meta?: AiChatHistoryMeta;
}

export interface AiChatToolTrace {
  tool: GuruMcpToolName;
  title: string;
  brief: string;
}

export interface AiChatHistoryMeta {
  agent_action?: 'answer' | 'clarification';
  clarification_round?: number;
  tool_trace?: AiChatToolTrace[];
}

export interface AiChatPageContext {
  activeSection?: string;
  pageLabel?: string;
  defaults?: {
    appKey?: string;
    platform?: string;
    from?: string;
    to?: string;
  };
  currentFilters?: Record<string, string | number | boolean | null>;
  recommendedSpecs?: AiContextPackSpec[];
  coreSpecs?: AiContextPackSpec[];
}

export interface AiChatImageInput {
  name: string;
  mimeType: string;
  size: number;
  base64Data: string;
}

export interface AiContextPackSpec {
  type: AiContextPackType;
  templateId: AiContextPackTemplateId;
  appKey: string;
  platform?: string;
  from?: string;
  to?: string;
  sourceSection?: string;
  source?: 'push' | 'pull';
  metric?: string;
  eventName?: string;
  status?: string;
  executionStatus?: string;
  isAdopted?: boolean;
  hasManualReview?: boolean;
  stage?: string;
  keyword?: string;
  campaign?: string;
}

export interface AiBuiltContextPack {
  type: AiContextPackType;
  templateId: AiContextPackTemplateId;
  title: string;
  summaryMarkdown: string;
  structured: Record<string, unknown>;
  rowCount: number;
  truncated: boolean;
  appliedFilters: Record<string, unknown>;
}

export interface AiChatResult {
  model_id: AiChatModelId;
  model: string;
  model_label: string;
  provider: string;
  reply: string;
  agent_action: 'answer' | 'clarification';
  tool_trace: AiChatToolTrace[];
  clarification_count: number;
  usage: Record<string, unknown> | null;
  warnings: string[];
  attachments_used: {
    images: Array<{ name: string; mimeType: string; size: number }>;
    context_packs: Array<{
      type: AiContextPackType;
      templateId: AiContextPackTemplateId;
      title: string;
      rowCount: number;
      truncated: boolean;
    }>;
  };
  raw: Record<string, unknown>;
}

export type AiChatModelId = 'qwen' | 'openrouter_kimi_k25' | 'openai_gpt54';
type AiChatProviderId = 'dashscope' | 'openrouter' | 'openai';

export interface AiChatModelOption {
  id: AiChatModelId;
  label: string;
  provider: AiChatProviderId;
  provider_label: string;
  model: string;
  supports_images: boolean;
  supports_thinking: boolean;
}

interface AiChatProviderConfig {
  id: AiChatModelId;
  label: string;
  provider: AiChatProviderId;
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsImages: boolean;
  supportsThinking: boolean;
  timeoutMs: number;
  maxTokens: number;
  extraHeaders?: Record<string, string>;
}

interface AiChatToolDefinition {
  type: 'function';
  function: {
    name: GuruMcpToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface AiChatToolCall {
  id: string;
  name: GuruMcpToolName;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

interface AiChatCompletionStepResult {
  content: string;
  toolCalls: AiChatToolCall[];
  usage: Record<string, unknown> | null;
  raw: Record<string, unknown>;
  rawMessage: Record<string, unknown>;
}

interface AiChatToolExecutionResult {
  trace: AiChatToolTrace;
  content: string;
  warnings: string[];
  success: boolean;
}

interface AiChatRuntimeDeps {
  buildAiContextPacksViaMcp: typeof buildAiContextPacksViaMcp;
  callGuruMcpTool: typeof callGuruMcpTool;
  requestCompletion: typeof requestAiChatCompletion;
}

const MAX_HISTORY_MESSAGES = 96;
const MAX_HISTORY_CHARS_PER_MESSAGE = 32000;
const MAX_HISTORY_TOTAL_CHARS = 120000;
const MAX_TOOL_CALL_ROUNDS = 3;
const MAX_TOOL_CALL_TYPES = 2;
const MAX_CLARIFICATION_ROUNDS = 2;
const MAX_BUCKET_ROWS = 40;
const MAX_GROUP_ROWS = 10;
const MAX_CONTEXT_PACK_PROMPT_CHARS = 24000;
const MAX_CONTEXT_PACK_SUMMARY_CHARS = 7000;
const MIN_CONTEXT_PACK_SUMMARY_CHARS = 240;
const MAX_PAGE_CONTEXT_PROMPT_CHARS = 8000;
const AI_CHAT_TIMEOUT_ERROR = 'ai_chat_timeout';

const PULL_METRICS = new Set(['installs', 'clicks', 'total_cost']);
const PUSH_METRICS = new Set(['revenue', 'event_count', 'purchase_count']);
const METRICS_DIMS: Record<string, 'media_source' | 'country' | 'campaign'> = {
  media_source: 'media_source',
  country: 'country',
  campaign: 'campaign'
};
const BUDGET_TEMPLATES = new Set<AiContextPackTemplateId>(['platform_media_source', 'action_status', 'keyword']);
const ASA_TEMPLATES = new Set<AiContextPackTemplateId>(['stage', 'campaign_adset', 'keyword']);
const AI_CHAT_MODEL_LABELS: Record<AiChatModelId, string> = {
  qwen: 'Qwen 3.6-Plus',
  openrouter_kimi_k25: 'Kimi-K2.5 (OpenRouter)',
  openai_gpt54: 'GPT-5.4 (OpenAI)'
};
const AI_CHAT_PROVIDER_LABELS: Record<AiChatProviderId, string> = {
  dashscope: 'DashScope',
  openrouter: 'OpenRouter',
  openai: 'OpenAI'
};

const AI_CHAT_TOOL_DEFINITIONS: AiChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: GURU_MCP_TOOL_NAMES.appsList,
      description:
        '列出当前系统里可查询的应用。当用户只说应用中文名、品牌名，或不确定 appKey 时，先调用这个工具辅助确认应用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: GURU_MCP_TOOL_NAMES.metricsGetTrend,
      description:
        '查询指标时序聚合。适用于趋势、波动、媒体源/国家/campaign 对比、安装/点击/花费/收入相关问题。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['appKey', 'templateId'],
        properties: {
          appKey: { type: 'string', description: '应用 appKey' },
          templateId: {
            type: 'string',
            enum: ['media_source', 'country', 'campaign'],
            description: '聚合维度'
          },
          platform: { type: 'string', description: 'ios / android / unknown，可为空' },
          from: { type: 'string', description: '开始日期，YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss' },
          to: { type: 'string', description: '结束日期，YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss' },
          source: {
            type: 'string',
            enum: ['push', 'pull'],
            description: 'pull=广告日报，push=实时回传'
          },
          metric: { type: 'string', description: '如 installs/clicks/total_cost/revenue/event_count/purchase_count' },
          eventName: { type: 'string', description: '当 metric=event_count 时可指定事件名' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: GURU_MCP_TOOL_NAMES.budgetGetSummary,
      description:
        '查询预算建议摘要。适用于预算建议、动作分布、状态分布、平台/媒体源表现、关键词预算问题。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['appKey', 'templateId'],
        properties: {
          appKey: { type: 'string', description: '应用 appKey' },
          templateId: {
            type: 'string',
            enum: ['platform_media_source', 'action_status', 'keyword'],
            description: '聚合维度'
          },
          platform: { type: 'string', description: 'ios / android / unknown，可为空' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
          status: { type: 'string', description: '建议状态，可为空' },
          executionStatus: { type: 'string', description: '执行状态，可为空' },
          isAdopted: { type: 'boolean', description: '是否已采纳，可为空' },
          hasManualReview: { type: 'boolean', description: '是否已有人工批复，可为空' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: GURU_MCP_TOOL_NAMES.asaKeywordsGetSummary,
      description:
        '查询 ASA 关键词摘要。适用于关键词阶段分布、广告组问题、ASA 关键词表现和建议动作相关问题。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['appKey', 'templateId'],
        properties: {
          appKey: { type: 'string', description: '应用 appKey' },
          templateId: {
            type: 'string',
            enum: ['stage', 'campaign_adset', 'keyword'],
            description: '聚合维度'
          },
          platform: { type: 'string', description: '通常为 ios，可为空' },
          from: { type: 'string', description: '开始日期 YYYY-MM-DD' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
          stage: { type: 'string', description: 'ASA 阶段，可为空' },
          keyword: { type: 'string', description: '关键词模糊过滤，可为空' },
          campaign: { type: 'string', description: 'campaign 名称过滤，可为空' }
        }
      }
    }
  }
];

const defaultAiChatRuntimeDeps: AiChatRuntimeDeps = {
  buildAiContextPacksViaMcp,
  callGuruMcpTool,
  requestCompletion: requestAiChatCompletion
};

export function isAiChatModelId(value: string): value is AiChatModelId {
  return value === 'qwen' || value === 'openrouter_kimi_k25' || value === 'openai_gpt54';
}

export function getAiChatModelLabel(modelId: AiChatModelId): string {
  return AI_CHAT_MODEL_LABELS[modelId];
}

function getAiChatProviderLabel(provider: AiChatProviderId): string {
  return AI_CHAT_PROVIDER_LABELS[provider];
}

function hasProviderCredentials(value: string): boolean {
  return String(value || '').trim().length > 0;
}

function isQwenAvailable(): boolean {
  return hasProviderCredentials(env.qwen.baseUrl) && hasProviderCredentials(env.qwen.apiKey) && hasProviderCredentials(env.qwen.model);
}

function isOpenRouterAvailable(): boolean {
  return (
    hasProviderCredentials(env.openrouter.baseUrl) &&
    hasProviderCredentials(env.openrouter.apiKey) &&
    hasProviderCredentials(env.openrouter.model)
  );
}

function isOpenAiAvailable(): boolean {
  return hasProviderCredentials(env.openai.baseUrl) && hasProviderCredentials(env.openai.apiKey) && hasProviderCredentials(env.openai.model);
}

export function listAvailableAiChatModels(): AiChatModelOption[] {
  const items: AiChatModelOption[] = [];
  if (isQwenAvailable()) {
    items.push({
      id: 'qwen',
      label: getAiChatModelLabel('qwen'),
      provider: 'dashscope',
      provider_label: getAiChatProviderLabel('dashscope'),
      model: env.qwen.model,
      supports_images: true,
      supports_thinking: env.qwen.thinkingEnabled
    });
  }
  if (isOpenRouterAvailable()) {
    items.push({
      id: 'openrouter_kimi_k25',
      label: getAiChatModelLabel('openrouter_kimi_k25'),
      provider: 'openrouter',
      provider_label: getAiChatProviderLabel('openrouter'),
      model: env.openrouter.model,
      supports_images: true,
      supports_thinking: false
    });
  }
  if (isOpenAiAvailable()) {
    items.push({
      id: 'openai_gpt54',
      label: getAiChatModelLabel('openai_gpt54'),
      provider: 'openai',
      provider_label: getAiChatProviderLabel('openai'),
      model: env.openai.model,
      supports_images: true,
      supports_thinking: false
    });
  }
  return items;
}

export function getDefaultAiChatModelId(): AiChatModelId | '' {
  if (isQwenAvailable()) {
    return 'qwen';
  }
  if (isOpenRouterAvailable()) {
    return 'openrouter_kimi_k25';
  }
  if (isOpenAiAvailable()) {
    return 'openai_gpt54';
  }
  return '';
}

function resolveAiChatProviderConfig(modelId: AiChatModelId): AiChatProviderConfig | null {
  if (modelId === 'qwen') {
    if (!isQwenAvailable()) {
      return null;
    }
    return {
      id: 'qwen',
      label: getAiChatModelLabel('qwen'),
      provider: 'dashscope',
      providerLabel: getAiChatProviderLabel('dashscope'),
      baseUrl: env.qwen.baseUrl,
      apiKey: env.qwen.apiKey,
      model: env.qwen.model,
      supportsImages: true,
      supportsThinking: env.qwen.thinkingEnabled,
      timeoutMs: env.qwen.timeoutMs,
      maxTokens: env.qwen.maxTokens
    };
  }
  if (modelId === 'openrouter_kimi_k25') {
    if (!isOpenRouterAvailable()) {
      return null;
    }
    const extraHeaders: Record<string, string> = {};
    if (hasProviderCredentials(env.openrouter.httpReferer)) {
      extraHeaders['HTTP-Referer'] = env.openrouter.httpReferer;
    }
    if (hasProviderCredentials(env.openrouter.appTitle)) {
      extraHeaders['X-Title'] = env.openrouter.appTitle;
    }
    return {
      id: 'openrouter_kimi_k25',
      label: getAiChatModelLabel('openrouter_kimi_k25'),
      provider: 'openrouter',
      providerLabel: getAiChatProviderLabel('openrouter'),
      baseUrl: env.openrouter.baseUrl,
      apiKey: env.openrouter.apiKey,
      model: env.openrouter.model,
      supportsImages: true,
      supportsThinking: false,
      timeoutMs: env.openrouter.timeoutMs,
      maxTokens: env.openrouter.maxTokens,
      extraHeaders
    };
  }
  if (!isOpenAiAvailable()) {
    return null;
  }
  return {
    id: 'openai_gpt54',
    label: getAiChatModelLabel('openai_gpt54'),
    provider: 'openai',
    providerLabel: getAiChatProviderLabel('openai'),
    baseUrl: env.openai.baseUrl,
    apiKey: env.openai.apiKey,
    model: env.openai.model,
    supportsImages: true,
    supportsThinking: false,
    timeoutMs: env.openai.timeoutMs,
    maxTokens: env.openai.maxTokens
  };
}

function resolveAiChatRequestTimeoutMs(modelConfig: AiChatProviderConfig): number {
  return Math.max(modelConfig.timeoutMs, 90000);
}

function resolveAiChatMaxOutputTokens(modelConfig: AiChatProviderConfig): number {
  return Math.max(900, modelConfig.maxTokens);
}

function hasText(value: unknown): boolean {
  return String(value ?? '').trim().length > 0;
}

function formatNum(value: unknown): string {
  return Number(value ?? 0).toFixed(2);
}

function normalizePlatform(platform?: string): string | undefined {
  const value = String(platform ?? '')
    .trim()
    .toLowerCase();
  return value ? value : undefined;
}

function normalizeDate(value: string | undefined, fallback: string): string {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback;
}

function normalizeDateTimeLike(value: string | undefined, fallback: string, isEndExclusive = false): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return fallback;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    if (isEndExclusive) {
      const date = new Date(`${raw}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + 1);
      return date.toISOString().slice(0, 19).replace('T', ' ');
    }
    return `${raw} 00:00:00`;
  }
  const normalized = raw.replace('T', ' ').slice(0, 19);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function sliceTail<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

function normalizeHistory(history: AiChatHistoryMessage[]): AiChatHistoryMessage[] {
  const trimmed = sliceTail(
    history
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && hasText(item.content))
      .map((item) => ({
        role: item.role,
        content: String(item.content).trim().slice(0, MAX_HISTORY_CHARS_PER_MESSAGE),
        meta: item.meta
          ? {
              agent_action:
                item.meta.agent_action === 'clarification'
                  ? ('clarification' as const)
                  : item.meta.agent_action === 'answer'
                    ? ('answer' as const)
                    : undefined,
              clarification_round:
                typeof item.meta.clarification_round === 'number' && Number.isFinite(item.meta.clarification_round)
                  ? item.meta.clarification_round
                  : undefined,
              tool_trace: Array.isArray(item.meta.tool_trace)
                ? item.meta.tool_trace
                    .filter((trace) => trace && typeof trace === 'object')
                    .map((trace) => ({
                      tool:
                        trace.tool === GURU_MCP_TOOL_NAMES.appsList ||
                        trace.tool === GURU_MCP_TOOL_NAMES.metricsGetTrend ||
                        trace.tool === GURU_MCP_TOOL_NAMES.budgetGetSummary ||
                        trace.tool === GURU_MCP_TOOL_NAMES.asaKeywordsGetSummary
                          ? trace.tool
                          : GURU_MCP_TOOL_NAMES.appsList,
                      title: String(trace.title || '').trim().slice(0, 120),
                      brief: String(trace.brief || '').trim().slice(0, 160)
                    }))
                    .filter((trace) => hasText(trace.title))
                : undefined
            }
          : undefined
      })),
    MAX_HISTORY_MESSAGES
  );

  let totalChars = 0;
  const kept: AiChatHistoryMessage[] = [];
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const item = trimmed[index];
    const nextChars = totalChars + item.content.length;
    if (kept.length > 0 && nextChars > MAX_HISTORY_TOTAL_CHARS) {
      break;
    }
    kept.push(item);
    totalChars = nextChars;
  }
  return kept.reverse();
}

function extractTextFromMessageContent(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        if (!item || typeof item !== 'object') {
          return '';
        }
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string') {
          return obj.text.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function formatMetricLabel(metric: string): string {
  switch (metric) {
    case 'revenue':
      return '收入';
    case 'event_count':
      return '事件次数';
    case 'purchase_count':
      return '购买次数';
    case 'installs':
      return '安装量';
    case 'clicks':
      return '点击量';
    case 'total_cost':
      return '花费';
    default:
      return metric;
  }
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return { text: '', truncated: false };
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  const clipped = normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return {
    text: `${clipped}…`,
    truncated: true
  };
}

function formatContextPackFilterValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function buildContextPackMetaLine(pack: AiBuiltContextPack): string {
  const metaParts = [`条目 ${pack.rowCount}`];
  if (pack.truncated) {
    metaParts.push('结果已按 Top N 截断');
  }
  const filterParts = Object.entries(pack.appliedFilters || {})
    .flatMap(([key, value]) => {
      const text = formatContextPackFilterValue(value);
      return text ? [`${key}=${text}`] : [];
    })
    .slice(0, 6);
  if (filterParts.length > 0) {
    metaParts.push(`筛选：${filterParts.join('；')}`);
  }
  return `元信息：${metaParts.join('；')}`;
}

function formatDimensionLabel(templateId: AiContextPackTemplateId): string {
  switch (templateId) {
    case 'media_source':
      return '媒体源';
    case 'country':
      return '国家';
    case 'campaign':
      return '活动';
    case 'platform_media_source':
      return '平台 / 媒体源';
    case 'action_status':
      return '动作 / 状态';
    case 'keyword':
      return '关键词';
    case 'stage':
      return '阶段';
    case 'campaign_adset':
      return '活动 / 广告组';
    default:
      return templateId;
  }
}

function buildMetricsEventFilter(metric: string, eventName?: string): { sql: string; params: Record<string, unknown> } {
  if (metric === 'revenue') {
    return { sql: `AND event_name = '__all__'`, params: {} };
  }
  if (metric === 'purchase_count') {
    return { sql: `AND event_name = 'purchase'`, params: {} };
  }
  if (metric === 'event_count' && hasText(eventName)) {
    return {
      sql: 'AND event_name = {eventName:String}',
      params: { eventName: String(eventName).trim() }
    };
  }
  return { sql: '', params: {} };
}

async function buildMetricsTrendPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  const source = spec.source === 'push' ? 'push' : 'pull';
  const platform = normalizePlatform(spec.platform);
  const dim = METRICS_DIMS[spec.templateId];
  if (!dim) {
    throw new Error('invalid_metrics_template');
  }

  const now = new Date();
  const defaultPullTo = now.toISOString().slice(0, 10);
  const defaultPullFrom = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const defaultPushTo = now.toISOString().slice(0, 19).replace('T', ' ');
  const defaultPushFrom = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  const metric = String(
    spec.metric ||
      (source === 'pull'
        ? 'installs'
        : 'revenue')
  )
    .trim()
    .toLowerCase();

  if (source === 'pull' && !PULL_METRICS.has(metric)) {
    throw new Error('invalid_pull_metric');
  }
  if (source === 'push' && !PUSH_METRICS.has(metric)) {
    throw new Error('invalid_push_metric');
  }

  const from = source === 'pull' ? normalizeDate(spec.from, defaultPullFrom) : normalizeDateTimeLike(spec.from, defaultPushFrom);
  const to = source === 'pull' ? normalizeDate(spec.to, defaultPullTo) : normalizeDateTimeLike(spec.to, defaultPushTo, true);

  const table = source === 'pull' ? 'metrics_daily FINAL' : 'metrics_hourly FINAL';
  const bucketExpr = source === 'pull' ? 'toString(date)' : 'toString(hour)';
  const rangeSql =
    source === 'pull'
      ? `date >= toDate({from:String}) AND date <= toDate({to:String})`
      : `hour >= toDateTime({from:String}) AND hour < toDateTime({to:String})`;
  const eventFilter = source === 'push' ? buildMetricsEventFilter(metric, spec.eventName) : { sql: '', params: {} };
  const baseParams: Record<string, unknown> = {
    appKey: spec.appKey,
    platform: platform ?? '',
    from,
    to,
    metric,
    ...eventFilter.params
  };

  const bucketRows = await chQuery<Record<string, unknown>>(
    `SELECT
        ${bucketExpr} AS bucket,
        sum(value) AS value
      FROM ${table}
      WHERE app_key = {appKey:String}
        AND metric = {metric:String}
        AND ({platform:String} = '' OR platform = {platform:String})
        AND ${rangeSql}
        ${eventFilter.sql}
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT 400`,
    baseParams
  );
  const topRows = await chQuery<Record<string, unknown>>(
    `SELECT
        ifNull(nullIf(${dim}, ''), 'unknown') AS label,
        sum(value) AS value
      FROM ${table}
      WHERE app_key = {appKey:String}
        AND metric = {metric:String}
        AND ({platform:String} = '' OR platform = {platform:String})
        AND ${rangeSql}
        ${eventFilter.sql}
      GROUP BY label
      ORDER BY value DESC
      LIMIT ${MAX_GROUP_ROWS}`,
    baseParams
  );

  const normalizedBuckets = bucketRows.map((row) => ({
    bucket: String(row.bucket || ''),
    value: Number(row.value || 0)
  }));
  const trimmedBuckets = sliceTail(normalizedBuckets, MAX_BUCKET_ROWS);
  const normalizedGroups = topRows.map((row) => ({
    label: String(row.label || 'unknown'),
    value: Number(row.value || 0)
  }));

  const total = normalizedBuckets.reduce((sum, row) => sum + row.value, 0);
  const latest = trimmedBuckets.at(-1) ?? { bucket: '-', value: 0 };
  const first = trimmedBuckets[0] ?? { bucket: '-', value: 0 };
  const peak = trimmedBuckets.reduce(
    (best, row) => (row.value > best.value ? row : best),
    trimmedBuckets[0] ?? { bucket: '-', value: 0 }
  );
  const deltaRatio = first.value > 0 ? ((latest.value - first.value) / first.value) * 100 : null;
  const truncated = normalizedBuckets.length > trimmedBuckets.length;

  const summaryMarkdown = [
    `### 指标时序包`,
    `- 应用：${spec.appKey}${platform ? ` / ${platform}` : ''}`,
    `- 来源：${source === 'pull' ? '广告日报（日级）' : '实时回传（小时级）'}；指标：${formatMetricLabel(metric)}；维度：${formatDimensionLabel(spec.templateId)}`,
    `- 时间范围：${from} ~ ${to}`,
    `- 总量：${formatNum(total)}；最新点：${latest.bucket} = ${formatNum(latest.value)}；峰值：${peak.bucket} = ${formatNum(peak.value)}`,
    deltaRatio === null ? '- 趋势变化：首点为 0，暂不计算变化率' : `- 趋势变化：相对首点 ${deltaRatio >= 0 ? '+' : ''}${formatNum(deltaRatio)}%`,
    normalizedGroups.length
      ? `- Top 维度：${normalizedGroups.map((row) => `${row.label} ${formatNum(row.value)}`).join('；')}`
      : '- Top 维度：当前筛选条件下暂无聚合结果'
  ].join('\n');

  return {
    type: 'metrics_trend',
    templateId: spec.templateId,
    title: `指标时序 · ${formatDimensionLabel(spec.templateId)}`,
    summaryMarkdown,
    structured: {
      source,
      metric,
      eventName: spec.eventName || null,
      appKey: spec.appKey,
      platform: platform || null,
      from,
      to,
      bucketTotals: trimmedBuckets,
      topDimensions: normalizedGroups,
      total,
      latest,
      peak,
      deltaRatio
    },
    rowCount: normalizedGroups.length + trimmedBuckets.length,
    truncated,
    appliedFilters: {
      appKey: spec.appKey,
      platform: platform || null,
      from,
      to,
      source,
      metric,
      eventName: spec.eventName || null
    }
  };
}

function buildBudgetWhere(spec: AiContextPackSpec): { whereSql: string; values: unknown[] } {
  const values: unknown[] = [];
  const clauses: string[] = [];

  values.push(spec.appKey);
  clauses.push(`br.app_key = $${values.length}`);

  const platform = normalizePlatform(spec.platform);
  if (platform) {
    values.push(platform);
    clauses.push(`br.platform = $${values.length}`);
  }
  if (hasText(spec.status)) {
    values.push(String(spec.status).trim());
    clauses.push(`br.status = $${values.length}`);
  }
  if (hasText(spec.from)) {
    values.push(String(spec.from).trim());
    clauses.push(`br.date >= $${values.length}::date`);
  }
  if (hasText(spec.to)) {
    values.push(String(spec.to).trim());
    clauses.push(`br.date <= $${values.length}::date`);
  }
  if (hasText(spec.executionStatus)) {
    values.push(String(spec.executionStatus).trim());
    clauses.push(`COALESCE(ref.execution_status, '') = $${values.length}`);
  }
  if (typeof spec.isAdopted === 'boolean') {
    values.push(spec.isAdopted);
    clauses.push(`COALESCE(ref.is_adopted, FALSE) = $${values.length}`);
  }
  if (typeof spec.hasManualReview === 'boolean') {
    clauses.push(
      spec.hasManualReview
        ? `NULLIF(BTRIM(COALESCE(ref.validation_result, '')), '') IS NOT NULL`
        : `NULLIF(BTRIM(COALESCE(ref.validation_result, '')), '') IS NULL`
    );
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values
  };
}

async function buildBudgetSummaryPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  if (!BUDGET_TEMPLATES.has(spec.templateId)) {
    throw new Error('invalid_budget_template');
  }

  const joinSql = `LEFT JOIN recommendation_execution_feedbacks ref
       ON ref.source_type = 'delivery_actions'
      AND ref.recommendation_type = 'budget'
      AND ref.recommendation_id = br.id`;
  const { whereSql, values } = buildBudgetWhere(spec);

  const summaryResult = await pgQuery<{
    total: string;
    avg_confidence: string | null;
    pending_count: string;
    applied_count: string;
    rejected_count: string;
    expired_count: string;
  }>(
    `SELECT
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(avg(br.confidence), 'FM999999990.00') AS avg_confidence,
        to_char(sum(CASE WHEN br.status = 'pending' THEN 1 ELSE 0 END), 'FM999999999999999') AS pending_count,
        to_char(sum(CASE WHEN br.status = 'applied' THEN 1 ELSE 0 END), 'FM999999999999999') AS applied_count,
        to_char(sum(CASE WHEN br.status = 'rejected' THEN 1 ELSE 0 END), 'FM999999999999999') AS rejected_count,
        to_char(sum(CASE WHEN br.status = 'expired' THEN 1 ELSE 0 END), 'FM999999999999999') AS expired_count
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}`,
    values
  );

  const actionRows = await pgQuery<{ action: string; total: string }>(
    `SELECT br.action, to_char(count(*), 'FM999999999999999') AS total
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}
      GROUP BY br.action
      ORDER BY count(*) DESC, br.action ASC
      LIMIT 6`,
    values
  );

  let groupSql = '';
  if (spec.templateId === 'platform_media_source') {
    groupSql = `SELECT
        br.platform AS key_a,
        br.media_source AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(avg(br.confidence), 'FM999999990.00') AS avg_confidence,
        to_char(avg(br.change_ratio), 'FM999999990.00') AS avg_change_ratio
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}
      GROUP BY br.platform, br.media_source
      ORDER BY count(*) DESC, avg(br.confidence) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  } else if (spec.templateId === 'action_status') {
    groupSql = `SELECT
        br.action AS key_a,
        br.status AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(avg(br.confidence), 'FM999999990.00') AS avg_confidence,
        to_char(avg(br.change_ratio), 'FM999999990.00') AS avg_change_ratio
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}
      GROUP BY br.action, br.status
      ORDER BY count(*) DESC, avg(br.confidence) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  } else {
    groupSql = `SELECT
        br.keyword AS key_a,
        '' AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(avg(br.confidence), 'FM999999990.00') AS avg_confidence,
        to_char(avg(br.change_ratio), 'FM999999990.00') AS avg_change_ratio
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}
      GROUP BY br.keyword
      ORDER BY count(*) DESC, avg(br.confidence) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  }

  const groupRowsResult = await pgQuery<{
    key_a: string;
    key_b: string;
    total: string;
    avg_confidence: string | null;
    avg_change_ratio: string | null;
  }>(groupSql, values);

  const summary = summaryResult.rows[0] ?? {
    total: '0',
    avg_confidence: '0.00',
    pending_count: '0',
    applied_count: '0',
    rejected_count: '0',
    expired_count: '0'
  };
  const groups = groupRowsResult.rows.map((row) => ({
    label: row.key_b ? `${row.key_a} / ${row.key_b}` : row.key_a,
    total: Number(row.total || 0),
    avgConfidence: Number(row.avg_confidence || 0),
    avgChangeRatio: Number(row.avg_change_ratio || 0)
  }));
  const actions = actionRows.rows.map((row) => `${row.action} ${row.total}`);

  const summaryMarkdown = [
    `### 预算建议包`,
    `- 应用：${spec.appKey}${spec.platform ? ` / ${spec.platform}` : ''}`,
    `- 聚合维度：${formatDimensionLabel(spec.templateId)}`,
    hasText(spec.from) || hasText(spec.to)
      ? `- 日期范围：${String(spec.from || '不限')} ~ ${String(spec.to || '不限')}`
      : '- 日期范围：不限',
    `- 总建议数：${summary.total}；平均置信度：${formatNum(summary.avg_confidence || 0)}`,
    `- 状态分布：pending ${summary.pending_count} / applied ${summary.applied_count} / rejected ${summary.rejected_count} / expired ${summary.expired_count}`,
    actions.length ? `- 动作分布：${actions.join('；')}` : '- 动作分布：暂无',
    groups.length
      ? `- Top 聚合：${groups
          .map((row) => `${row.label}（${row.total} 条，置信度 ${formatNum(row.avgConfidence)}）`)
          .join('；')}`
      : '- Top 聚合：当前筛选条件下暂无数据'
  ].join('\n');

  return {
    type: 'budget_summary',
    templateId: spec.templateId,
    title: `预算建议 · ${formatDimensionLabel(spec.templateId)}`,
    summaryMarkdown,
    structured: {
      appKey: spec.appKey,
      platform: normalizePlatform(spec.platform) || null,
      from: spec.from || null,
      to: spec.to || null,
      status: spec.status || null,
      executionStatus: spec.executionStatus || null,
      isAdopted: typeof spec.isAdopted === 'boolean' ? spec.isAdopted : null,
      hasManualReview: typeof spec.hasManualReview === 'boolean' ? spec.hasManualReview : null,
      summary: {
        total: Number(summary.total || 0),
        avgConfidence: Number(summary.avg_confidence || 0),
        pendingCount: Number(summary.pending_count || 0),
        appliedCount: Number(summary.applied_count || 0),
        rejectedCount: Number(summary.rejected_count || 0),
        expiredCount: Number(summary.expired_count || 0)
      },
      actionBreakdown: actionRows.rows.map((row) => ({
        action: row.action,
        total: Number(row.total || 0)
      })),
      groups
    },
    rowCount: groups.length,
    truncated: false,
    appliedFilters: {
      appKey: spec.appKey,
      platform: normalizePlatform(spec.platform) || null,
      from: spec.from || null,
      to: spec.to || null,
      status: spec.status || null,
      executionStatus: spec.executionStatus || null,
      isAdopted: typeof spec.isAdopted === 'boolean' ? spec.isAdopted : null,
      hasManualReview: typeof spec.hasManualReview === 'boolean' ? spec.hasManualReview : null
    }
  };
}

function buildAsaWhere(spec: AiContextPackSpec): { whereSql: string; values: unknown[] } {
  const values: unknown[] = [];
  const clauses: string[] = [];

  values.push(spec.appKey);
  clauses.push(`app_key = $${values.length}`);

  const platform = normalizePlatform(spec.platform);
  if (platform) {
    values.push(platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (hasText(spec.stage)) {
    values.push(String(spec.stage).trim());
    clauses.push(`current_stage = $${values.length}`);
  }
  if (hasText(spec.keyword)) {
    values.push(`%${String(spec.keyword).trim().toLowerCase()}%`);
    clauses.push(`(LOWER(keyword) LIKE $${values.length} OR LOWER(campaign) LIKE $${values.length} OR LOWER(adset) LIKE $${values.length})`);
  }
  if (hasText(spec.campaign)) {
    values.push(`%${String(spec.campaign).trim().toLowerCase()}%`);
    clauses.push(`LOWER(campaign) LIKE $${values.length}`);
  }
  if (hasText(spec.from)) {
    values.push(String(spec.from).trim());
    clauses.push(`last_seen_date >= $${values.length}::date`);
  }
  if (hasText(spec.to)) {
    values.push(String(spec.to).trim());
    clauses.push(`last_seen_date <= $${values.length}::date`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values
  };
}

async function buildAsaKeywordPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  if (!ASA_TEMPLATES.has(spec.templateId)) {
    throw new Error('invalid_asa_template');
  }

  const { whereSql, values } = buildAsaWhere(spec);

  const summaryResult = await pgQuery<{
    total: string;
    installs_7d: string | null;
    total_cost_7d: string | null;
    avg_ecpi: string | null;
    avg_cpp: string | null;
    avg_roas: string | null;
  }>(
    `SELECT
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(sum(installs_7d), 'FM999999999999990.00') AS installs_7d,
        to_char(sum(total_cost_7d), 'FM999999999999990.00') AS total_cost_7d,
        to_char(avg(current_ecpi), 'FM999999990.00') AS avg_ecpi,
        to_char(avg(current_cpp), 'FM999999990.00') AS avg_cpp,
        to_char(avg(current_d7_roas), 'FM999999990.00') AS avg_roas
      FROM asa_keyword_states
      ${whereSql}`,
    values
  );

  let groupSql = '';
  if (spec.templateId === 'stage') {
    groupSql = `SELECT
        current_stage AS key_a,
        '' AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(sum(installs_7d), 'FM999999999999990.00') AS installs_7d,
        to_char(avg(current_ecpi), 'FM999999990.00') AS avg_ecpi,
        to_char(avg(current_d7_roas), 'FM999999990.00') AS avg_roas
      FROM asa_keyword_states
      ${whereSql}
      GROUP BY current_stage
      ORDER BY count(*) DESC, current_stage ASC
      LIMIT ${MAX_GROUP_ROWS}`;
  } else if (spec.templateId === 'campaign_adset') {
    groupSql = `SELECT
        campaign AS key_a,
        adset AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(sum(installs_7d), 'FM999999999999990.00') AS installs_7d,
        to_char(avg(current_ecpi), 'FM999999990.00') AS avg_ecpi,
        to_char(avg(current_d7_roas), 'FM999999990.00') AS avg_roas
      FROM asa_keyword_states
      ${whereSql}
      GROUP BY campaign, adset
      ORDER BY sum(installs_7d) DESC, count(*) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  } else {
    groupSql = `SELECT
        keyword AS key_a,
        '' AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(sum(installs_7d), 'FM999999999999990.00') AS installs_7d,
        to_char(avg(current_ecpi), 'FM999999990.00') AS avg_ecpi,
        to_char(avg(current_d7_roas), 'FM999999990.00') AS avg_roas
      FROM asa_keyword_states
      ${whereSql}
      GROUP BY keyword
      ORDER BY sum(installs_7d) DESC, count(*) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  }

  const groupRowsResult = await pgQuery<{
    key_a: string;
    key_b: string;
    total: string;
    installs_7d: string | null;
    avg_ecpi: string | null;
    avg_roas: string | null;
  }>(groupSql, values);

  const recoClauses: string[] = ['app_key = $1'];
  const recoValues: unknown[] = [spec.appKey];
  const platform = normalizePlatform(spec.platform);
  if (platform) {
    recoValues.push(platform);
    recoClauses.push(`platform = $${recoValues.length}`);
  }
  if (hasText(spec.from)) {
    recoValues.push(String(spec.from).trim());
    recoClauses.push(`date >= $${recoValues.length}::date`);
  }
  if (hasText(spec.to)) {
    recoValues.push(String(spec.to).trim());
    recoClauses.push(`date <= $${recoValues.length}::date`);
  }
  const recoWhereSql = recoClauses.length ? `WHERE ${recoClauses.join(' AND ')}` : '';
  const actionRows = await pgQuery<{ action: string; total: string }>(
    `SELECT action, to_char(count(*), 'FM999999999999999') AS total
      FROM asa_keyword_recommendations
      ${recoWhereSql}
      GROUP BY action
      ORDER BY count(*) DESC, action ASC
      LIMIT 6`,
    recoValues
  );

  const summary = summaryResult.rows[0] ?? {
    total: '0',
    installs_7d: '0.00',
    total_cost_7d: '0.00',
    avg_ecpi: '0.00',
    avg_cpp: '0.00',
    avg_roas: '0.00'
  };
  const groups = groupRowsResult.rows.map((row) => ({
    label: row.key_b ? `${row.key_a} / ${row.key_b}` : row.key_a,
    total: Number(row.total || 0),
    installs7d: Number(row.installs_7d || 0),
    avgEcpi: Number(row.avg_ecpi || 0),
    avgRoas: Number(row.avg_roas || 0)
  }));
  const actions = actionRows.rows.map((row) => `${row.action} ${row.total}`);

  const summaryMarkdown = [
    `### ASA 关键词包`,
    `- 应用：${spec.appKey}${platform ? ` / ${platform}` : ''}`,
    `- 聚合维度：${formatDimensionLabel(spec.templateId)}`,
    hasText(spec.from) || hasText(spec.to)
      ? `- 日期范围：${String(spec.from || '不限')} ~ ${String(spec.to || '不限')}`
      : '- 日期范围：不限',
    `- 关键词总数：${summary.total}；7 日安装：${formatNum(summary.installs_7d || 0)}；7 日花费：${formatNum(summary.total_cost_7d || 0)}`,
    `- 均值：eCPI ${formatNum(summary.avg_ecpi || 0)} / CPP ${formatNum(summary.avg_cpp || 0)} / D7 ROAS ${formatNum(summary.avg_roas || 0)}`,
    actions.length ? `- 建议动作：${actions.join('；')}` : '- 建议动作：当前范围内暂无推荐记录',
    groups.length
      ? `- Top 聚合：${groups
          .map((row) => `${row.label}（${row.total} 个词，安装 ${formatNum(row.installs7d)}）`)
          .join('；')}`
      : '- Top 聚合：当前筛选条件下暂无数据'
  ].join('\n');

  return {
    type: 'asa_keyword_summary',
    templateId: spec.templateId,
    title: `ASA 关键词 · ${formatDimensionLabel(spec.templateId)}`,
    summaryMarkdown,
    structured: {
      appKey: spec.appKey,
      platform: platform || null,
      from: spec.from || null,
      to: spec.to || null,
      stage: spec.stage || null,
      keyword: spec.keyword || null,
      campaign: spec.campaign || null,
      summary: {
        total: Number(summary.total || 0),
        installs7d: Number(summary.installs_7d || 0),
        totalCost7d: Number(summary.total_cost_7d || 0),
        avgEcpi: Number(summary.avg_ecpi || 0),
        avgCpp: Number(summary.avg_cpp || 0),
        avgRoas: Number(summary.avg_roas || 0)
      },
      actionBreakdown: actionRows.rows.map((row) => ({
        action: row.action,
        total: Number(row.total || 0)
      })),
      groups
    },
    rowCount: groups.length,
    truncated: false,
    appliedFilters: {
      appKey: spec.appKey,
      platform: platform || null,
      from: spec.from || null,
      to: spec.to || null,
      stage: spec.stage || null,
      keyword: spec.keyword || null,
      campaign: spec.campaign || null
    }
  };
}

export async function buildAiContextPacks(
  specs: AiContextPackSpec[]
): Promise<{ packs: AiBuiltContextPack[]; warnings: string[] }> {
  const packs: AiBuiltContextPack[] = [];
  const warnings: string[] = [];

  for (const spec of specs) {
    try {
      if (!spec || !hasText(spec.appKey)) {
        warnings.push('已跳过一个缺少应用标识的数据包。');
        continue;
      }
      if (spec.type === 'metrics_trend') {
        packs.push(await buildMetricsTrendPack(spec));
      } else if (spec.type === 'budget_summary') {
        packs.push(await buildBudgetSummaryPack(spec));
      } else if (spec.type === 'asa_keyword_summary') {
        packs.push(await buildAsaKeywordPack(spec));
      } else {
        warnings.push(`暂不支持的数据包类型：${String((spec as { type?: unknown }).type || 'unknown')}`);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : '数据包构建失败');
    }
  }

  return { packs, warnings };
}

export function buildAiContextPrompt(packs: AiBuiltContextPack[]): {
  prompt: string;
  warnings: string[];
  packsUsed: AiBuiltContextPack[];
} {
  if (packs.length === 0) {
    return {
      prompt: '',
      warnings: [],
      packsUsed: []
    };
  }
  const intro = '以下是当前工作台自动附带的业务上下文，请优先基于这些数据回答。若上下文不足，请明确说明，不要编造不存在的数据。';
  const sections: string[] = [intro];
  const warnings: string[] = [];
  const packsUsed: AiBuiltContextPack[] = [];
  let usedChars = intro.length;

  for (const pack of packs) {
    const metaLine = buildContextPackMetaLine(pack);
    const sectionHeader = `\n[上下文包 ${packsUsed.length + 1}] ${pack.title}\n${metaLine}\n`;
    const baseSummary = truncateText(pack.summaryMarkdown, MAX_CONTEXT_PACK_SUMMARY_CHARS);
    const remainingChars = MAX_CONTEXT_PACK_PROMPT_CHARS - usedChars - sectionHeader.length;
    if (remainingChars < MIN_CONTEXT_PACK_SUMMARY_CHARS) {
      warnings.push(`上下文包「${pack.title}」因总上下文过长已跳过。`);
      continue;
    }
    const finalSummary = truncateText(baseSummary.text || '暂无可用摘要。', remainingChars);
    const section = `${sectionHeader}${finalSummary.text}`;
    sections.push(section);
    packsUsed.push(pack);
    usedChars += section.length;
    if (baseSummary.truncated || finalSummary.truncated) {
      warnings.push(`上下文包「${pack.title}」内容较长，已自动截短。`);
    }
  }

  return {
    prompt: packsUsed.length > 0 ? sections.join('\n') : '',
    warnings,
    packsUsed
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)])) as T;
  }
  return value;
}

function toStableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => toStableJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${toStableJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeGuruToolCalls(raw: unknown): AiChatToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item, index) => {
      const toolCall = isPlainObject(item) ? item : {};
      const fn = isPlainObject(toolCall.function) ? toolCall.function : {};
      const name = String(fn.name || '').trim();
      if (
        name !== GURU_MCP_TOOL_NAMES.appsList &&
        name !== GURU_MCP_TOOL_NAMES.metricsGetTrend &&
        name !== GURU_MCP_TOOL_NAMES.budgetGetSummary &&
        name !== GURU_MCP_TOOL_NAMES.asaKeywordsGetSummary
      ) {
        return null;
      }
      const rawArguments =
        typeof fn.arguments === 'string'
          ? fn.arguments
          : isPlainObject(fn.arguments)
            ? JSON.stringify(fn.arguments)
            : '{}';
      return {
        id: String(toolCall.id || `tool-call-${Date.now()}-${index}`),
        name: name as GuruMcpToolName,
        rawArguments,
        arguments: parseJsonObject(rawArguments)
      } satisfies AiChatToolCall;
    })
    .filter((item): item is AiChatToolCall => Boolean(item));
}

function countClarificationRounds(history: AiChatHistoryMessage[]): number {
  return history.reduce((count, item) => {
    if (item.role !== 'assistant') {
      return count;
    }
    return item.meta?.agent_action === 'clarification' ? count + 1 : count;
  }, 0);
}

function normalizePageContextSpecs(items: AiContextPackSpec[] | undefined, limit = 5): AiContextPackSpec[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter((item) => item && hasText(item.appKey)).slice(0, limit).map((item) => ({
    ...item
  }));
}

function formatPageContextValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function sanitizePageContextFilterRecord(raw: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  if (!raw) {
    return {};
  }
  const entries = Object.entries(raw)
    .map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, value.trim().slice(0, 120)] as const;
      }
      if (typeof value === 'boolean') {
        return [key, value] as const;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return [key, value] as const;
      }
      return [key, null] as const;
    })
    .filter(([, value]) => value !== null && value !== '');
  return Object.fromEntries(entries);
}

function buildAiPageContextPrompt(pageContext?: AiChatPageContext): string {
  if (!pageContext) {
    return '';
  }
  const lines: string[] = ['当前页面上下文（优先用于补齐工具参数）'];
  if (hasText(pageContext.pageLabel) || hasText(pageContext.activeSection)) {
    lines.push(`- 页面：${String(pageContext.pageLabel || pageContext.activeSection || '').trim()}`);
  }
  const defaultParts = [
    hasText(pageContext.defaults?.appKey) ? `应用 ${pageContext.defaults?.appKey}` : '',
    hasText(pageContext.defaults?.platform) ? `平台 ${pageContext.defaults?.platform}` : '',
    hasText(pageContext.defaults?.from) || hasText(pageContext.defaults?.to)
      ? `时间 ${String(pageContext.defaults?.from || '不限')} ~ ${String(pageContext.defaults?.to || '不限')}`
      : ''
  ].filter(Boolean);
  if (defaultParts.length > 0) {
    lines.push(`- 默认范围：${defaultParts.join(' / ')}`);
  }
  const currentFilters = sanitizePageContextFilterRecord(pageContext.currentFilters);
  const filterEntries = Object.entries(currentFilters)
    .flatMap(([key, value]) => {
      const text = formatPageContextValue(value);
      return text ? [`${key}=${text}`] : [];
    })
    .slice(0, 8);
  if (filterEntries.length > 0) {
    lines.push(`- 当前筛选：${filterEntries.join('；')}`);
  }

  const candidateSpecs = [
    ...normalizePageContextSpecs(pageContext.recommendedSpecs, 2),
    ...normalizePageContextSpecs(pageContext.coreSpecs, 3)
  ];
  const seen = new Set<string>();
  const specsPrompt: string[] = [];
  for (const spec of candidateSpecs) {
    try {
      const tool = resolveGuruMcpToolForContextPack(spec);
      const signature = `${tool.name}:${toStableJson(tool.arguments)}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      specsPrompt.push(`- ${tool.name} ${JSON.stringify(tool.arguments)}`);
    } catch {
      continue;
    }
  }
  if (specsPrompt.length > 0) {
    lines.push('- 当前页面可直接查询的工具参数示例：');
    lines.push(...specsPrompt);
  }
  return truncateText(lines.join('\n'), MAX_PAGE_CONTEXT_PROMPT_CHARS).text;
}

function buildAiChatSystemPrompt(input: {
  manualPacks: AiBuiltContextPack[];
  pageContextPrompt: string;
  clarificationCount: number;
}): string {
  const clarificationRule =
    input.clarificationCount >= MAX_CLARIFICATION_ROUNDS
      ? '你已经追问过足够多次，当前这轮不允许再次追问；如果信息仍不完整，请明确说明不确定性，并基于已有信息尽量回答。'
      : `若确实缺少关键参数，可最多再追问 ${MAX_CLARIFICATION_ROUNDS - input.clarificationCount} 轮。追问时只输出一条简洁问题，并以 "CLARIFY:" 开头。`;
  const manualContextRule =
    input.manualPacks.length > 0
      ? `用户已经手动附带了 ${input.manualPacks.length} 个业务上下文包。请优先使用这些已有上下文，不要重复查询同样的数据。`
      : '如果用户没有手动附带上下文，也可以根据当前页面上下文和工具自行补齐参数。';
  const pageContextRule = input.pageContextPrompt
    ? `${input.pageContextPrompt}\n在没有明确指定 app/platform/from/to 时，优先沿用上面的页面默认范围。`
    : '如果当前页面上下文为空，且问题明确依赖业务数据，请先确认应用、平台或时间范围。';
  return [
    '你是 Hotspot 控制台的 Guru Ads Agent。默认使用简体中文回答。',
    '只有当用户的问题明显依赖投放数据、预算建议、ASA 关键词、趋势或工作台事实时，才调用工具。普通闲聊、常识问答、写作润色、接入测试不要调用任何工具。',
    manualContextRule,
    pageContextRule,
    clarificationRule,
    '调用工具前，先判断是否已经有足够的手动上下文或历史工具结果；避免重复查询同一份数据。',
    '最终回答默认结构：先给结论，再给 2-4 条关键证据，最后给一个可继续追问的方向。',
    '回答请使用简洁 Markdown：允许短段落、加粗、列表、行内代码；不要使用 HTML、复杂表格、冗长标题或花哨格式。',
    '不要编造系统里不存在的事实；如果工具失败或数据不足，要明确说明。'
  ].join('\n');
}

function findFallbackContextSpec(
  toolName: GuruMcpToolName,
  pageContext: AiChatPageContext | undefined,
  manualSpecs: AiContextPackSpec[]
): AiContextPackSpec | null {
  const allSpecs = [...manualSpecs, ...normalizePageContextSpecs(pageContext?.recommendedSpecs), ...normalizePageContextSpecs(pageContext?.coreSpecs)];
  const matched = allSpecs.find((spec) => {
    if (toolName === GURU_MCP_TOOL_NAMES.metricsGetTrend) {
      return spec.type === 'metrics_trend';
    }
    if (toolName === GURU_MCP_TOOL_NAMES.budgetGetSummary) {
      return spec.type === 'budget_summary';
    }
    if (toolName === GURU_MCP_TOOL_NAMES.asaKeywordsGetSummary) {
      return spec.type === 'asa_keyword_summary';
    }
    return false;
  });
  if (matched) {
    return { ...matched };
  }
  const defaults = pageContext?.defaults;
  if (!hasText(defaults?.appKey)) {
    return null;
  }
  if (toolName === GURU_MCP_TOOL_NAMES.metricsGetTrend) {
    return {
      type: 'metrics_trend',
      templateId: 'media_source',
      appKey: String(defaults?.appKey || '').trim(),
      platform: defaults?.platform,
      from: defaults?.from,
      to: defaults?.to,
      source: 'pull'
    };
  }
  if (toolName === GURU_MCP_TOOL_NAMES.budgetGetSummary) {
    return {
      type: 'budget_summary',
      templateId: 'platform_media_source',
      appKey: String(defaults?.appKey || '').trim(),
      platform: defaults?.platform,
      from: defaults?.from,
      to: defaults?.to
    };
  }
  if (toolName === GURU_MCP_TOOL_NAMES.asaKeywordsGetSummary) {
    return {
      type: 'asa_keyword_summary',
      templateId: 'stage',
      appKey: String(defaults?.appKey || '').trim(),
      platform: defaults?.platform,
      from: defaults?.from,
      to: defaults?.to
    };
  }
  return null;
}

function resolveGuruToolArguments(input: {
  toolName: GuruMcpToolName;
  args: Record<string, unknown>;
  pageContext?: AiChatPageContext;
  manualSpecs: AiContextPackSpec[];
}): Record<string, unknown> {
  const fallbackSpec = findFallbackContextSpec(input.toolName, input.pageContext, input.manualSpecs);
  const fallbackArgs = fallbackSpec ? resolveGuruMcpToolForContextPack(fallbackSpec).arguments : {};
  const merged = {
    ...cloneJsonValue(fallbackArgs),
    ...cloneJsonValue(input.args)
  } as Record<string, unknown>;

  const readText = (key: string): string | undefined => {
    const value = merged[key];
    const text = typeof value === 'string' ? value.trim() : '';
    return text || undefined;
  };
  const readBoolean = (key: string): boolean | undefined => {
    const value = merged[key];
    return typeof value === 'boolean' ? value : undefined;
  };

  if (input.toolName === GURU_MCP_TOOL_NAMES.appsList) {
    return {};
  }
  if (input.toolName === GURU_MCP_TOOL_NAMES.metricsGetTrend) {
    return {
      appKey: readText('appKey') || '',
      templateId: readText('templateId') || 'media_source',
      platform: readText('platform'),
      from: readText('from'),
      to: readText('to'),
      source: readText('source'),
      metric: readText('metric'),
      eventName: readText('eventName')
    };
  }
  if (input.toolName === GURU_MCP_TOOL_NAMES.budgetGetSummary) {
    return {
      appKey: readText('appKey') || '',
      templateId: readText('templateId') || 'platform_media_source',
      platform: readText('platform'),
      from: readText('from'),
      to: readText('to'),
      status: readText('status'),
      executionStatus: readText('executionStatus'),
      isAdopted: readBoolean('isAdopted'),
      hasManualReview: readBoolean('hasManualReview')
    };
  }
  return {
    appKey: readText('appKey') || '',
    templateId: readText('templateId') || 'stage',
    platform: readText('platform'),
    from: readText('from'),
    to: readText('to'),
    stage: readText('stage'),
    keyword: readText('keyword'),
    campaign: readText('campaign')
  };
}

function buildToolSignature(toolName: GuruMcpToolName, args: Record<string, unknown>): string {
  return `${toolName}:${toStableJson(args)}`;
}

function toStructuredResultFromPack(pack: AiBuiltContextPack): GuruMcpStructuredResult {
  return {
    title: pack.title,
    summary_markdown: pack.summaryMarkdown,
    structured: pack.structured,
    row_count: pack.rowCount,
    truncated: pack.truncated,
    applied_filters: pack.appliedFilters
  };
}

function buildGuruToolTrace(toolName: GuruMcpToolName, result: GuruMcpStructuredResult | GuruMcpAppsListResult): AiChatToolTrace {
  const labelMap: Record<string, string> = {
    appKey: '应用',
    platform: '平台',
    from: '开始',
    to: '结束',
    source: '来源',
    metric: '指标',
    templateId: '维度',
    status: '状态',
    stage: '阶段',
    keyword: '关键词',
    campaign: 'Campaign'
  };
  const detail = Object.entries(result.applied_filters || {})
    .flatMap(([key, value]) => {
      const text = formatContextPackFilterValue(value);
      return text ? [`${labelMap[key] || key} ${text}`] : [];
    })
    .slice(0, 3)
    .join(' / ');
  return {
    tool: toolName,
    title: result.title,
    brief: detail || (toolName === GURU_MCP_TOOL_NAMES.appsList ? `返回 ${result.row_count} 个应用` : '已按当前页面范围查询')
  };
}

function buildGuruToolResultContent(result: GuruMcpStructuredResult | GuruMcpAppsListResult): string {
  const compact = {
    title: result.title,
    summary_markdown: truncateText(String(result.summary_markdown || ''), 6000).text,
    row_count: result.row_count,
    truncated: result.truncated,
    applied_filters: result.applied_filters,
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
  return JSON.stringify(compact, null, 2);
}

function buildGuruToolErrorContent(toolName: GuruMcpToolName, message: string): string {
  return JSON.stringify(
    {
      tool: toolName,
      ok: false,
      error: message
    },
    null,
    2
  );
}

function buildManualContextToolCache(
  specs: AiContextPackSpec[],
  packs: AiBuiltContextPack[]
): Map<string, AiChatToolExecutionResult> {
  const cache = new Map<string, AiChatToolExecutionResult>();
  specs.forEach((spec, index) => {
    const pack = packs[index];
    if (!pack) {
      return;
    }
    try {
      const toolCall = resolveGuruMcpToolForContextPack(spec);
      const result = toStructuredResultFromPack(pack);
      cache.set(buildToolSignature(toolCall.name, toolCall.arguments), {
        trace: buildGuruToolTrace(toolCall.name, result),
        content: buildGuruToolResultContent(result),
        warnings: [],
        success: true
      });
    } catch {
      // ignore unsupported manual specs
    }
  });
  return cache;
}

function isClarificationReply(content: string): boolean {
  return /^\s*CLARIFY\s*:/i.test(content);
}

function stripClarificationPrefix(content: string): string {
  return content.replace(/^\s*CLARIFY\s*:\s*/i, '').trim();
}

async function requestAiChatCompletion(input: {
  modelConfig: AiChatProviderConfig;
  messages: Array<Record<string, unknown>>;
  images: AiChatImageInput[];
  thinkingEnabled: boolean;
  tools?: AiChatToolDefinition[];
  toolChoice?: 'auto';
}): Promise<AiChatCompletionStepResult> {
  const maxOutputTokens = resolveAiChatMaxOutputTokens(input.modelConfig);
  const payload: Record<string, unknown> = {
    model: input.modelConfig.model,
    temperature: 0.3,
    messages: input.messages
  };
  if (input.modelConfig.id === 'openai_gpt54') {
    payload.max_completion_tokens = maxOutputTokens;
  } else {
    payload.max_tokens = maxOutputTokens;
  }
  if (input.modelConfig.id === 'qwen') {
    payload.extra_body = {
      enable_thinking: input.thinkingEnabled
    };
  }
  if (Array.isArray(input.tools) && input.tools.length > 0) {
    payload.tools = input.tools;
    payload.tool_choice = input.toolChoice || 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveAiChatRequestTimeoutMs(input.modelConfig));

  try {
    const res = await fetch(`${input.modelConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${input.modelConfig.apiKey}`,
        ...(input.modelConfig.extraHeaders || {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const responseJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errorText = extractTextFromMessageContent(
        (responseJson.error as Record<string, unknown> | undefined)?.message ?? responseJson.message
      );
      if (
        input.modelConfig.id === 'openrouter_kimi_k25' &&
        /not available in your region/i.test(String(errorText || ''))
      ) {
        throw new Error('openrouter_region_unavailable');
      }
      throw new Error(errorText || `ai_chat_request_failed_${res.status}`);
    }

    const choices = Array.isArray(responseJson.choices) ? responseJson.choices : [];
    const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
    const message = (firstChoice.message ?? {}) as Record<string, unknown>;
    const toolCalls = normalizeGuruToolCalls(message.tool_calls);
    const reply = extractTextFromMessageContent(message.content);
    if (!reply && toolCalls.length === 0) {
      throw new Error('empty_ai_reply');
    }

    return {
      content: reply,
      toolCalls,
      usage:
        responseJson.usage && typeof responseJson.usage === 'object'
          ? (responseJson.usage as Record<string, unknown>)
          : null,
      rawMessage: message,
      raw: responseJson
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || /aborted/i.test(error.message) || /timed? ?out/i.test(error.message))
    ) {
      throw new Error(AI_CHAT_TIMEOUT_ERROR);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runAiChat(
  input: {
    message: string;
    history: AiChatHistoryMessage[];
    contextPacks: AiContextPackSpec[];
    images: AiChatImageInput[];
    modelId?: AiChatModelId;
    requestId?: string;
    pageContext?: AiChatPageContext;
  },
  deps: AiChatRuntimeDeps = defaultAiChatRuntimeDeps
): Promise<AiChatResult> {
  const promptMessage = hasText(input.message) ? String(input.message).trim() : '请结合我附带的上下文和图片，给出中文分析。';
  const normalizedHistory = normalizeHistory(input.history);
  const priorClarificationCount = countClarificationRounds(normalizedHistory);
  let packs: AiBuiltContextPack[] = [];
  let packSpecs: AiContextPackSpec[] = [];
  let warnings: string[] = [];
  let hasMcpTimeout = false;
  if (input.contextPacks.length > 0) {
    try {
      const mcpResult = await deps.buildAiContextPacksViaMcp(input.contextPacks, input.requestId);
      packs = mcpResult.packs;
      packSpecs = mcpResult.packSpecs;
      warnings = mcpResult.warnings;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'mcp_context_unavailable';
      hasMcpTimeout = isMcpTimeoutErrorMessage(errorMessage);
      warnings = [toGuruMcpUserMessage(errorMessage, { context: 'pack' })];
    }
    if (packs.length === 0 && !hasText(input.message) && input.images.length === 0) {
      if (hasMcpTimeout) {
        throw new Error(AI_CHAT_TIMEOUT_ERROR);
      }
      throw new Error('mcp_context_unavailable');
    }
  }
  const contextPromptResult = buildAiContextPrompt(packs);
  const mergedWarnings = [...warnings, ...contextPromptResult.warnings];
  const resolvedModelId = input.modelId ?? getDefaultAiChatModelId();
  if (!resolvedModelId) {
    throw new Error('ai_chat_model_unavailable');
  }
  const modelConfig = resolveAiChatProviderConfig(resolvedModelId);
  if (!modelConfig) {
    throw new Error('ai_chat_model_unavailable');
  }
  if (input.images.length > 0 && !modelConfig.supportsImages) {
    throw new Error('ai_model_images_unsupported');
  }
  const shouldEnableThinking =
    modelConfig.supportsThinking && (input.images.length > 0 || contextPromptResult.packsUsed.length > 0);
  const pageContextPrompt = buildAiPageContextPrompt(input.pageContext);
  const toolTrace: AiChatToolTrace[] = [];
  const toolTraceSignatures = new Set<string>();
  const manualContextCache = buildManualContextToolCache(packSpecs, packs);
  const executedToolCache = new Map<string, AiChatToolExecutionResult>();
  const seenToolCallSignatures = new Set<string>();
  const distinctToolNames = new Set<GuruMcpToolName>();
  let attemptedToolCalls = 0;
  let successfulToolCalls = 0;

  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: promptMessage
    }
  ];
  for (const image of input.images) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:${image.mimeType};base64,${image.base64Data}`
      }
    });
  }

  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content: buildAiChatSystemPrompt({
        manualPacks: packs,
        pageContextPrompt,
        clarificationCount: priorClarificationCount
      })
    },
    ...normalizedHistory.map((item) => ({
      role: item.role,
      content: item.content
    }))
  ];

  const contextPrompt = contextPromptResult.prompt;
  if (contextPrompt) {
    messages.push({
      role: 'system',
      content: contextPrompt
    });
  }
  messages.push({
    role: 'user',
    content: userContent
  });

  let finalStep: AiChatCompletionStepResult | null = null;

  for (let round = 0; round < MAX_TOOL_CALL_ROUNDS; round += 1) {
    const step = await deps.requestCompletion({
      modelConfig,
      messages,
      images: input.images,
      thinkingEnabled: shouldEnableThinking,
      tools: AI_CHAT_TOOL_DEFINITIONS,
      toolChoice: 'auto'
    });

    finalStep = step;
    if (step.toolCalls.length === 0) {
      break;
    }

    messages.push({
      role: 'assistant',
      content: step.content || '',
      tool_calls: Array.isArray(step.rawMessage.tool_calls) ? step.rawMessage.tool_calls : []
    });

    for (const toolCall of step.toolCalls) {
      attemptedToolCalls += 1;
      const resolvedArgs = resolveGuruToolArguments({
        toolName: toolCall.name,
        args: toolCall.arguments,
        pageContext: input.pageContext,
        manualSpecs: input.contextPacks
      });
      const signature = buildToolSignature(toolCall.name, resolvedArgs);
      let execution: AiChatToolExecutionResult;

      if (distinctToolNames.size >= MAX_TOOL_CALL_TYPES && !distinctToolNames.has(toolCall.name)) {
        execution = {
          trace: {
            tool: toolCall.name,
            title: toolCall.name,
            brief: '已跳过多余工具'
          },
          content: buildGuruToolErrorContent(toolCall.name, '为保证时延，本次最多自动查询 2 类数据。'),
          warnings: ['自动查询工具已达上限，已跳过多余查询。'],
          success: false
        };
      } else if (seenToolCallSignatures.has(signature) && executedToolCache.has(signature)) {
        execution = executedToolCache.get(signature) as AiChatToolExecutionResult;
      } else if (manualContextCache.has(signature)) {
        execution = manualContextCache.get(signature) as AiChatToolExecutionResult;
        seenToolCallSignatures.add(signature);
        distinctToolNames.add(toolCall.name);
        executedToolCache.set(signature, execution);
        successfulToolCalls += 1;
      } else if (seenToolCallSignatures.has(signature)) {
        execution = {
          trace: {
            tool: toolCall.name,
            title: toolCall.name,
            brief: '重复查询已跳过'
          },
          content: buildGuruToolErrorContent(toolCall.name, '重复的同参工具调用已跳过，请直接基于已有结果回答。'),
          warnings: ['模型重复请求了同一份数据，已自动跳过重复查询。'],
          success: false
        };
      } else {
        seenToolCallSignatures.add(signature);
        distinctToolNames.add(toolCall.name);
        try {
          const toolResult = await deps.callGuruMcpTool(toolCall.name, resolvedArgs, input.requestId);
          const structuredResult = toolResult as GuruMcpStructuredResult | GuruMcpAppsListResult;
          execution = {
            trace: buildGuruToolTrace(toolCall.name, structuredResult),
            content: buildGuruToolResultContent(structuredResult),
            warnings: Array.isArray(structuredResult.warnings) ? structuredResult.warnings.map((item) => String(item)) : [],
            success: true
          };
          executedToolCache.set(signature, execution);
          successfulToolCalls += 1;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'mcp_context_unavailable';
          hasMcpTimeout = hasMcpTimeout || isMcpTimeoutErrorMessage(errorMessage);
          const userWarning = toGuruMcpUserMessage(errorMessage, {
            context: 'tool',
            title: toolCall.name
          });
          execution = {
            trace: {
              tool: toolCall.name,
              title: toolCall.name,
              brief: '查询失败'
            },
            content: buildGuruToolErrorContent(toolCall.name, userWarning),
            warnings: [userWarning],
            success: false
          };
        }
      }

      mergedWarnings.push(...execution.warnings);
      if (execution.success && !toolTraceSignatures.has(signature)) {
        toolTrace.push(execution.trace);
        toolTraceSignatures.add(signature);
      }
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: execution.content
      });
    }
  }

  if (finalStep && finalStep.toolCalls.length > 0) {
    finalStep = await deps.requestCompletion({
      modelConfig,
      messages: [
        ...messages,
        {
          role: 'system',
          content: '请基于已有上下文和工具结果直接回答用户，不要再调用工具。'
        }
      ],
      images: input.images,
      thinkingEnabled: shouldEnableThinking
    });
  }

  if (!finalStep) {
    throw new Error('empty_ai_reply');
  }

  const agentAction = isClarificationReply(finalStep.content) ? 'clarification' : 'answer';
  const reply = agentAction === 'clarification' ? stripClarificationPrefix(finalStep.content) : finalStep.content.trim();
  if (!reply) {
    if (attemptedToolCalls > 0 && successfulToolCalls === 0 && contextPromptResult.packsUsed.length === 0) {
      if (hasMcpTimeout) {
        throw new Error(AI_CHAT_TIMEOUT_ERROR);
      }
      throw new Error('mcp_context_unavailable');
    }
    throw new Error('empty_ai_reply');
  }

  const nextClarificationCount = agentAction === 'clarification' ? priorClarificationCount + 1 : priorClarificationCount;

  return {
    model_id: modelConfig.id,
    model: modelConfig.model,
    model_label: modelConfig.label,
    provider: modelConfig.provider,
    reply,
    agent_action: agentAction,
    tool_trace: toolTrace,
    clarification_count: nextClarificationCount,
    usage: finalStep.usage,
    warnings: Array.from(new Set(mergedWarnings.filter((item) => hasText(item)))),
    attachments_used: {
      images: input.images.map((image) => ({
        name: image.name,
        mimeType: image.mimeType,
        size: image.size
      })),
      context_packs: contextPromptResult.packsUsed.map((pack) => ({
        type: pack.type,
        templateId: pack.templateId,
        title: pack.title,
        rowCount: pack.rowCount,
        truncated: pack.truncated
      }))
    },
    raw: finalStep.raw
  };
}
