import { env } from '../config/env.js';
import { md5Hex } from './hash.js';
import { LlmExplainResult } from '../types/models.js';
import { loadLatestFeedbackSkillPrompt } from './recommendationFeedback.js';

export interface BudgetLlmInput {
  appKey: string;
  platform: string;
  mediaSource: string;
  primaryMetric: 'ecpi' | 'roas';
  metricMode: 'active' | 'roas_pending_revenue';
  keyword: string;
  matchType: string;
  action: 'increase' | 'decrease' | 'hold' | 'pause';
  changeRatio: number;
  currentCost: number;
  suggestedBudget: number;
  confidence: number;
  reasonCode: string;
  stage: string;
  lastCpi: number;
  lastInstalls: number;
  lastClicks: number;
  currentEcpi: number;
  targetEcpi: number;
  volumeTier: string;
  last3Installs: number;
  last7Installs: number;
  currentRoas?: number | null;
  targetRoas?: number | null;
  currentCpp?: number | null;
  targetCpp?: number | null;
  scenarioTags?: string[];
  presetActionItems?: string[];
  structuredPolicy?: Record<string, unknown>;
  computedContext?: Record<string, unknown>;
  manualPromptMarkdown?: string | null;
}

export interface LlmCallResult {
  ok: boolean;
  model: string;
  promptHash: string;
  latencyMs: number;
  output: LlmExplainResult;
  raw: Record<string, unknown>;
  error?: string;
}

function fallbackExplain(input: BudgetLlmInput): LlmExplainResult {
  const direction =
    input.action === 'increase'
      ? '建议提高预算，优先观察成本稳定性。'
      : input.action === 'decrease'
        ? '建议降低预算，控制低效流量。'
        : input.action === 'pause'
        ? '建议暂停，等待关键词质量恢复后再重启。'
        : '建议保持预算，继续观察短期波动。';
  const scenarioTags = Array.isArray(input.scenarioTags) ? input.scenarioTags.filter(Boolean).slice(0, 6) : [];
  const presetActionItems = Array.isArray(input.presetActionItems)
    ? input.presetActionItems.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    summary_cn: `${direction} 媒体源=${input.mediaSource}，当前 eCPI=${input.currentEcpi.toFixed(2)}，目标 eCPI=${input.targetEcpi.toFixed(2)}，量级=${input.volumeTier}，置信度=${Math.round(input.confidence * 100)}%。`,
    risk_level: input.action === 'increase' ? 'medium' : input.action === 'pause' ? 'high' : 'low',
    checklist: ['检查最近 3 天激活量是否稳定', '确认 AppsFlyer eCPI 与投放后台口径一致', '复核最近 3 天数据延迟'],
    explanation_points: [
      `reason_code=${input.reasonCode}`,
      `media_source=${input.mediaSource} / primary_metric=${input.primaryMetric} / metric_mode=${input.metricMode}`,
      `ecpi=${input.currentEcpi.toFixed(2)} / target=${input.targetEcpi.toFixed(2)} / tier=${input.volumeTier}`,
      `change_ratio=${(input.changeRatio * 100).toFixed(1)}%`,
      `current_cost=${input.currentCost.toFixed(2)}, suggested_budget=${input.suggestedBudget.toFixed(2)}`
    ],
    action_items:
      presetActionItems.length > 0 ? presetActionItems : ['先复核数据成熟度，再决定是否执行当前动作。', '执行后连续观察 2-3 天，确认成本与回收没有异常。'],
    scenario_tags: scenarioTags
  };
}

function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return '{}';
}

function normalizeExplain(raw: unknown, input: BudgetLlmInput): LlmExplainResult {
  if (!raw || typeof raw !== 'object') {
    return fallbackExplain(input);
  }
  const obj = raw as Record<string, unknown>;
  const riskRaw = String(obj.risk_level ?? 'medium').toLowerCase();
  const riskLevel = riskRaw === 'low' || riskRaw === 'high' ? riskRaw : 'medium';
  const summary = String(obj.summary_cn ?? '').trim().slice(0, 800);
  const checklist = Array.isArray(obj.checklist)
    ? obj.checklist.map((item) => String(item).trim()).filter((item) => item.length > 0).slice(0, 8)
    : [];
  const explanationPoints = Array.isArray(obj.explanation_points)
    ? obj.explanation_points
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
        .slice(0, 8)
    : [];
  const actionItems = Array.isArray(obj.action_items)
    ? obj.action_items.map((item) => String(item).trim()).filter((item) => item.length > 0).slice(0, 8)
    : [];
  const scenarioTags = Array.isArray(obj.scenario_tags)
    ? obj.scenario_tags.map((item) => String(item).trim()).filter((item) => item.length > 0).slice(0, 8)
    : [];

  if (!summary) {
    return fallbackExplain(input);
  }

  return {
    summary_cn: summary,
    risk_level: riskLevel,
    checklist: checklist.length ? checklist : fallbackExplain(input).checklist,
    explanation_points: explanationPoints.length ? explanationPoints : fallbackExplain(input).explanation_points,
    action_items: actionItems.length ? actionItems : fallbackExplain(input).action_items,
    scenario_tags: scenarioTags.length ? scenarioTags : fallbackExplain(input).scenario_tags
  };
}

export async function explainBudgetRecommendationWithLlm(input: BudgetLlmInput): Promise<LlmCallResult> {
  const fallback = fallbackExplain(input);
  const feedbackSkillPrompt = await loadLatestFeedbackSkillPrompt('budget');
  const promptPayload = {
    task: 'budget_recommendation_explain',
    locale: 'zh-CN',
    constraints: [
      '输出 JSON',
      '不要返回思考链路',
      'summary_cn 尽量控制在 1-2 句话内，优先简洁，但不要因压缩长度而丢失关键判断依据',
      'checklist 为可执行检查项',
      '风险等级仅 low/medium/high',
      'action_items 只补充执行动作，不得推翻既定主动作',
      'scenario_tags 只允许输出上下文字段中已有的场景标签'
    ],
    context: input,
    structured_policy: input.structuredPolicy || undefined,
    computed_metrics_context: input.computedContext || undefined,
    manual_prompt_markdown: input.manualPromptMarkdown || undefined,
    learned_feedback_constraints: feedbackSkillPrompt || undefined
  };
  const promptText = JSON.stringify(promptPayload);
  const promptHash = md5Hex(promptText);

  if (!env.qwen.baseUrl || !env.qwen.apiKey) {
    return {
      ok: false,
      model: env.qwen.model,
      promptHash,
      latencyMs: 0,
      output: fallback,
      raw: {},
      error: 'qwen_config_missing'
    };
  }

  const url = `${env.qwen.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: env.qwen.model,
    temperature: 0.2,
    max_tokens: env.qwen.maxTokens,
    messages: [
      {
        role: 'system',
        content:
          `你是增长投放分析助手。仅输出 JSON，字段必须是 summary_cn,risk_level,checklist,explanation_points,action_items,scenario_tags。禁止输出思考过程。不得修改上下文里已经给定的主动作，只能补充解释和动作列表。summary_cn 保持简洁，但不要为了控字数截断关键信息。${
            feedbackSkillPrompt ? `\n请额外遵守以下历史反馈经验：\n${feedbackSkillPrompt}` : ''
          }`
      },
      {
        role: 'user',
        content: promptText
      }
    ]
  };

  if (env.qwen.thinkingEnabled) {
    body.extra_body = { enable_thinking: true };
    body.thinking = { enabled: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.qwen.timeoutMs);
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${env.qwen.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const latencyMs = Date.now() - start;
    const responseJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        model: env.qwen.model,
        promptHash,
        latencyMs,
        output: fallback,
        raw: responseJson,
        error: `qwen_http_${res.status}`
      };
    }

    const choices = Array.isArray(responseJson.choices) ? responseJson.choices : [];
    const message = (choices[0] as Record<string, unknown> | undefined)?.message;
    const content = (message as Record<string, unknown> | undefined)?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((item) => (typeof item === 'object' && item ? String((item as Record<string, unknown>).text ?? '') : ''))
        .join('\n');
    }

    const parsed = JSON.parse(extractJsonBlock(text));
    return {
      ok: true,
      model: env.qwen.model,
      promptHash,
      latencyMs,
      output: normalizeExplain(parsed, input),
      raw: responseJson
    };
  } catch (error) {
    return {
      ok: false,
      model: env.qwen.model,
      promptHash,
      latencyMs: Date.now() - start,
      output: fallback,
      raw: {},
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}
