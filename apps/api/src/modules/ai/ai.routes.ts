import { Router } from 'express';
import { buildAiContextPacks, type AiContextPackSpec } from '@shared/utils/aiContextPacks.js';
import {
  runAiChat,
  AiChatHistoryMessage,
  AiChatImageInput,
  type AiChatPageContext,
  getDefaultAiChatModelId,
  isAiChatModelId,
  listAvailableAiChatModels,
  type AiChatModelId
} from '@shared/utils/aiChat.js';

interface AiRouteDeps {
  buildAiContextPacks: typeof buildAiContextPacks;
  runAiChat: typeof runAiChat;
  listAvailableAiChatModels: typeof listAvailableAiChatModels;
  getDefaultAiChatModelId: typeof getDefaultAiChatModelId;
}

const defaultDeps: AiRouteDeps = {
  buildAiContextPacks,
  runAiChat,
  listAvailableAiChatModels,
  getDefaultAiChatModelId
};

const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_CONTEXT_PACK_COUNT = 3;

type UploadedFormFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function toHeadersInit(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => result.append(key, item));
    } else if (typeof value === 'string') {
      result.set(key, value);
    }
  }
  return result;
}

function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isUploadedFormFile(value: unknown): value is UploadedFormFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UploadedFormFile).arrayBuffer === 'function' &&
    typeof (value as UploadedFormFile).type === 'string'
  );
}

function sanitizeHistory(raw: unknown): AiChatHistoryMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const obj = item as Record<string, unknown>;
      const role = obj.role === 'assistant' ? 'assistant' : 'user';
      const content = String(obj.content ?? '').trim();
      const metaRaw = obj.meta && typeof obj.meta === 'object' ? (obj.meta as Record<string, unknown>) : null;
      return {
        role,
        content,
        meta: metaRaw
          ? {
              agent_action:
                metaRaw.agent_action === 'clarification'
                  ? 'clarification'
                  : metaRaw.agent_action === 'answer'
                    ? 'answer'
                    : undefined,
              clarification_round:
                typeof metaRaw.clarification_round === 'number' ? metaRaw.clarification_round : undefined,
              page_trace: Array.isArray(metaRaw.page_trace)
                ? metaRaw.page_trace
                    .filter((trace): trace is Record<string, unknown> => Boolean(trace) && typeof trace === 'object')
                    .map((trace) => ({
                      title: String(trace.title || '').trim(),
                      brief: String(trace.brief || '').trim()
                    }))
                    .filter((trace) => trace.title)
                : undefined,
              tool_trace: Array.isArray(metaRaw.tool_trace)
                ? metaRaw.tool_trace
                    .filter((trace): trace is Record<string, unknown> => Boolean(trace) && typeof trace === 'object')
                    .map((trace) => ({
                      tool: String(trace.tool || '').trim() as never,
                      title: String(trace.title || '').trim(),
                      brief: String(trace.brief || '').trim()
                    }))
                    .filter((trace) => trace.title)
                : undefined
            }
          : undefined
      } satisfies AiChatHistoryMessage;
    })
    .filter((item) => item.content.length > 0);
}

function sanitizePageContext(raw: unknown): AiChatPageContext | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const defaultsRaw = obj.defaults && typeof obj.defaults === 'object' ? (obj.defaults as Record<string, unknown>) : {};
  const currentFiltersRaw =
    obj.currentFilters && typeof obj.currentFilters === 'object' ? (obj.currentFilters as Record<string, unknown>) : {};
  const loadedContextsRaw = Array.isArray(obj.loaded_contexts) ? obj.loaded_contexts : [];
  return {
    activeSection: String(obj.activeSection || '').trim() || undefined,
    pageLabel: String(obj.pageLabel || '').trim() || undefined,
    defaults: {
      appKey: String(defaultsRaw.appKey || '').trim() || undefined,
      platform: String(defaultsRaw.platform || '').trim() || undefined,
      from: String(defaultsRaw.from || '').trim() || undefined,
      to: String(defaultsRaw.to || '').trim() || undefined
    },
    currentFilters: Object.fromEntries(
      Object.entries(currentFiltersRaw)
        .map(([key, value]) => {
          if (typeof value === 'string') {
            return [key, value.trim().slice(0, 120)];
          }
          if (typeof value === 'boolean') {
            return [key, value];
          }
          if (typeof value === 'number' && Number.isFinite(value)) {
            return [key, value];
          }
          return [key, null];
        })
        .filter(([, value]) => value !== null && value !== '')
    ),
    loaded_contexts: loadedContextsRaw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        kind: String(item.kind || '').trim() || undefined,
        title: String(item.title || '').trim(),
        summary_markdown: String(item.summary_markdown || '').trim(),
        applied_filters:
          item.applied_filters && typeof item.applied_filters === 'object'
            ? Object.fromEntries(
                Object.entries(item.applied_filters as Record<string, unknown>)
                  .map(([key, value]) => {
                    if (typeof value === 'string') {
                      return [key, value.trim().slice(0, 120)];
                    }
                    if (typeof value === 'boolean') {
                      return [key, value];
                    }
                    if (typeof value === 'number' && Number.isFinite(value)) {
                      return [key, value];
                    }
                    return [key, null];
                  })
                  .filter(([, value]) => value !== null && value !== '')
              )
            : {},
        source_section: String(item.source_section || '').trim() || undefined,
        freshness: String(item.freshness || '').trim() || undefined,
        tool_hint: sanitizeContextPacks(item.tool_hint ? [item.tool_hint] : [])[0]
      }))
      .filter((item) => item.title && item.summary_markdown),
    recommendedSpecs: sanitizeContextPacks(obj.recommendedSpecs),
    coreSpecs: sanitizeContextPacks(obj.coreSpecs)
  };
}

function sanitizeContextPacks(raw: unknown): AiContextPackSpec[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const obj = item as Record<string, unknown>;
      return {
        type: String(obj.type || '') as AiContextPackSpec['type'],
        templateId: String(obj.templateId || '') as AiContextPackSpec['templateId'],
        appKey: String(obj.appKey || '').trim(),
        platform: String(obj.platform || '').trim() || undefined,
        from: String(obj.from || '').trim() || undefined,
        to: String(obj.to || '').trim() || undefined,
        sourceSection: String(obj.sourceSection || '').trim() || undefined,
        source: obj.source === 'push' ? 'push' : obj.source === 'pull' ? 'pull' : undefined,
        metric: String(obj.metric || '').trim() || undefined,
        eventName: String(obj.eventName || '').trim() || undefined,
        status: String(obj.status || '').trim() || undefined,
        executionStatus: String(obj.executionStatus || '').trim() || undefined,
        isAdopted: typeof obj.isAdopted === 'boolean' ? obj.isAdopted : undefined,
        hasManualReview: typeof obj.hasManualReview === 'boolean' ? obj.hasManualReview : undefined,
        stage: String(obj.stage || '').trim() || undefined,
        keyword: String(obj.keyword || '').trim() || undefined,
        campaign: String(obj.campaign || '').trim() || undefined
      } satisfies AiContextPackSpec;
    })
    .filter((item) => item.appKey);
}

function findAvailableModel(modelId: AiChatModelId, deps: AiRouteDeps) {
  return deps.listAvailableAiChatModels().find((item) => item.id === modelId) || null;
}

export function createAiRouter(deps: AiRouteDeps = defaultDeps): Router {
  const router = Router();

  router.get('/api/ai/models', async (_req, res) => {
    const models = deps.listAvailableAiChatModels();
    const defaultModelId = deps.getDefaultAiChatModelId() || models[0]?.id || '';
    return res.json({
      ok: true,
      data: {
        default_model_id: defaultModelId,
        models
      }
    });
  });

  router.post('/api/ai/chat', async (req, res, next) => {
    try {
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return res.status(400).json({ ok: false, error: 'multipart_form_data_required' });
      }

      const request = new Request(`http://localhost${req.originalUrl || req.url}`, {
        method: req.method,
        headers: toHeadersInit(req.headers),
        body: req,
        duplex: 'half'
      });
      const formData = await request.formData();
      const message = String(formData.get('message') || '').trim();
      const history = sanitizeHistory(parseJsonField(formData.get('history_json'), []));
      const contextPacks = sanitizeContextPacks(parseJsonField(formData.get('context_packs_json'), []));
      const pageContext = sanitizePageContext(parseJsonField(formData.get('page_context_json'), null));
      const images = formData.getAll('images').filter((item) => isUploadedFormFile(item));
      const rawModelId = String(formData.get('model_id') || '').trim();

      if (!message && images.length === 0 && contextPacks.length === 0) {
        return res.status(400).json({ ok: false, error: 'message_or_attachment_required' });
      }
      if (images.length > MAX_IMAGE_COUNT) {
        return res.status(400).json({ ok: false, error: 'too_many_images' });
      }
      if (contextPacks.length > MAX_CONTEXT_PACK_COUNT) {
        return res.status(400).json({ ok: false, error: 'too_many_context_packs' });
      }

      if (rawModelId && !isAiChatModelId(rawModelId)) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_model_id',
          message: '当前模型无效，请重新选择 Guru Ads Agent 模型。'
        });
      }
      const defaultModelId = deps.getDefaultAiChatModelId();
      const modelId = (rawModelId || defaultModelId || '') as AiChatModelId | '';
      if (!modelId) {
        return res.status(400).json({
          ok: false,
          error: 'ai_model_unavailable',
          message: 'Guru Ads Agent 当前没有可用模型，请联系管理员检查模型配置。'
        });
      }
      if (!findAvailableModel(modelId, deps)) {
        return res.status(400).json({
          ok: false,
          error: 'ai_model_unavailable',
          message: '当前选择的模型暂不可用，请切回其他模型后重试。'
        });
      }
      const selectedModel = findAvailableModel(modelId, deps);
      if (selectedModel && images.length > 0 && selectedModel.supports_images === false) {
        return res.status(400).json({
          ok: false,
          error: 'ai_model_images_unsupported',
          message: `当前 ${selectedModel.label} 仅支持文本对话，请切回支持图片的模型，或移除图片后再试。`
        });
      }

      const imagePayloads: AiChatImageInput[] = [];
      for (const image of images) {
        const mimeType = String(image.type || '').trim().toLowerCase();
        if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
          return res.status(400).json({ ok: false, error: 'unsupported_image_type' });
        }
        if (image.size > MAX_IMAGE_SIZE_BYTES) {
          return res.status(400).json({ ok: false, error: 'image_too_large' });
        }

        const arrayBuffer = await image.arrayBuffer();
        imagePayloads.push({
          name: image.name || 'image',
          mimeType,
          size: image.size,
          base64Data: Buffer.from(arrayBuffer).toString('base64')
        });
      }

      const result = await deps.runAiChat({
        message,
        history,
        contextPacks,
        pageContext,
        images: imagePayloads,
        modelId,
        requestId: req.requestId
      });

      return res.json({
        ok: true,
        data: result
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'ai_chat_model_unavailable') {
        return res.status(400).json({
          ok: false,
          error: 'ai_model_unavailable',
          message: '当前选择的模型暂不可用，请切回其他模型后重试。'
        });
      }
      if (error instanceof Error && error.message === 'ai_model_images_unsupported') {
        return res.status(400).json({
          ok: false,
          error: 'ai_model_images_unsupported',
          message: '当前模型仅支持文本对话，请切回支持图片的模型，或移除图片后再试。'
        });
      }
      if (error instanceof Error && error.message === 'mcp_request_timeout') {
        return res.status(504).json({
          ok: false,
          error: 'ai_chat_timeout',
          message: 'Guru Ads Agent 响应超时，请重试，或减少上下文后再发送。'
        });
      }
      if (error instanceof Error && error.message === 'ai_chat_timeout') {
        return res.status(504).json({
          ok: false,
          error: 'ai_chat_timeout',
          message: 'Guru Ads Agent 响应超时，请重试，或减少上下文后再发送。'
        });
      }
      if (error instanceof Error && error.message === 'mcp_context_unavailable') {
        return res.status(503).json({
          ok: false,
          error: 'mcp_context_unavailable',
          message: '当前业务上下文暂时不可用，请稍后重试，或先直接进行文本对话。'
        });
      }
      if (error instanceof Error && error.message === 'openrouter_region_unavailable') {
        return res.status(400).json({
          ok: false,
          error: 'openrouter_region_unavailable',
          message: '当前 OpenRouter 的 Kimi-K2.5 在你这个地区或账号下不可用，请先切回 Qwen，或更换可用地区 / 账号后再试。'
        });
      }
      return next(error);
    }
  });

  router.post('/api/ai/context-packs/preview', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawSpecs = Array.isArray(body.contextPacks) ? body.contextPacks : [];
      const contextPacks = sanitizeContextPacks(rawSpecs);
      if (contextPacks.length === 0) {
        return res.status(400).json({ ok: false, error: 'context_packs_required' });
      }
      if (contextPacks.length > MAX_CONTEXT_PACK_COUNT) {
        return res.status(400).json({ ok: false, error: 'too_many_context_packs' });
      }
      const result = await deps.buildAiContextPacks(contextPacks);
      return res.json({
        ok: true,
        data: result
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export default createAiRouter();
