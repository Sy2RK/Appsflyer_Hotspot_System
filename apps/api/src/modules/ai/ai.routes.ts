import { Router } from 'express';
import { buildAiContextPacks, runAiChat, AiChatHistoryMessage, AiContextPackSpec, AiChatImageInput } from '@shared/utils/aiChat.js';

const router = Router();

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
      return {
        role,
        content
      } satisfies AiChatHistoryMessage;
    })
    .filter((item) => item.content.length > 0);
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
    const images = formData.getAll('images').filter((item) => isUploadedFormFile(item));

    if (!message && images.length === 0 && contextPacks.length === 0) {
      return res.status(400).json({ ok: false, error: 'message_or_attachment_required' });
    }
    if (images.length > MAX_IMAGE_COUNT) {
      return res.status(400).json({ ok: false, error: 'too_many_images' });
    }
    if (contextPacks.length > MAX_CONTEXT_PACK_COUNT) {
      return res.status(400).json({ ok: false, error: 'too_many_context_packs' });
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

    const result = await runAiChat({
      message,
      history,
      contextPacks,
      images: imagePayloads
    });

    return res.json({
      ok: true,
      data: result
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'ai_chat_timeout') {
      return res.status(504).json({
        ok: false,
        error: 'ai_chat_timeout',
        message: 'Guru Ads Agent 响应超时，请重试，或减少上下文后再发送。'
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
    const result = await buildAiContextPacks(contextPacks);
    return res.json({
      ok: true,
      data: result
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
