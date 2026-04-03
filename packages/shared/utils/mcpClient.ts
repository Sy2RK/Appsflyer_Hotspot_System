import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { env } from '../config/env.js';
import type { AiBuiltContextPack, AiContextPackSpec } from './aiContextPacks.js';
import { resolveGuruMcpToolForContextPack, type GuruMcpAppsListResult, type GuruMcpStructuredResult } from './guruMcp.js';

interface McpSessionState {
  sessionId: string;
  protocolVersion: string;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: Record<string, unknown>;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id?: string | number | null;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

let requestSequence = 0;
const MCP_TIMEOUT_ERROR = 'mcp_request_timeout';

function nextRequestId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${Date.now()}-${requestSequence}`;
}

function hasSessionFailure(status: number, bodyText: string): boolean {
  if (![400, 404].includes(status)) {
    return false;
  }
  return /session/i.test(bodyText);
}

async function readResponseBody(res: Response): Promise<{
  json: Record<string, unknown> | null;
  text: string;
}> {
  const text = await res.text();
  if (!text.trim()) {
    return { json: null, text: '' };
  }
  try {
    return {
      json: JSON.parse(text) as Record<string, unknown>,
      text
    };
  } catch {
    return { json: null, text };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractMcpContentErrorText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const text = content
    .map((item) => {
      if (typeof item === 'string') {
        return item.trim();
      }
      if (!isPlainObject(item)) {
        return '';
      }
      return typeof item.text === 'string' ? item.text.trim() : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text.replace(/^Error:\s*/i, '').trim();
}

function isLowLevelMcpErrorDetail(detail: string): boolean {
  const normalized = String(detail || '').trim();
  if (!normalized) {
    return false;
  }
  return /(DB::|Exception|ClickHouse|Postgres|jsonrpc|payload|schema|syntax|stack|trace|ECONN|ENOTFOUND|timeout|timed out|abort|aborted)/i.test(
    normalized
  );
}

function looksLikeMachineCode(detail: string): boolean {
  const normalized = String(detail || '').trim();
  return /^[a-z0-9_.:-]+$/i.test(normalized);
}

function buildContextPackFallbackTitle(spec: AiContextPackSpec): string {
  const parts = [spec.type, spec.templateId].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '当前业务上下文';
}

async function fetchWithMcpTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(env.mcp.timeoutMs, 1000));
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || /aborted/i.test(error.message) || /timed? ?out/i.test(error.message))
    ) {
      throw new Error(MCP_TIMEOUT_ERROR);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function isMcpTimeoutErrorMessage(message: string): boolean {
  return String(message || '').trim() === MCP_TIMEOUT_ERROR;
}

export function toGuruMcpUserMessage(message: string, options: { context?: 'pack' | 'tool'; title?: string } = {}): string {
  const raw = String(message || '').trim();
  const titlePrefix = options.title ? `「${options.title}」` : '当前业务上下文';
  if (isMcpTimeoutErrorMessage(raw)) {
    return options.context === 'tool'
      ? `${titlePrefix} 查询超时，已跳过这次自动查询。`
      : `${titlePrefix} 获取超时，已跳过这次附加。`;
  }
  if (/^mcp_initialize_failed:/i.test(raw) || /^mcp_initialized_notification_failed:/i.test(raw) || /^mcp_initialize_missing_session_id$/i.test(raw)) {
    return `${titlePrefix} 服务暂时不可用，已跳过这次附加。`;
  }
  if (/^mcp_tool_error:/i.test(raw)) {
    const detail = raw.replace(/^mcp_tool_error:/i, '').trim();
    if (detail && !isLowLevelMcpErrorDetail(detail)) {
      return `${titlePrefix} 查询失败：${detail}`;
    }
    return `${titlePrefix} 查询失败，请稍后重试。`;
  }
  if (/^mcp_tool_call_failed:/i.test(raw) || /^mcp_tool_invalid_payload:/i.test(raw) || /^mcp_transport_error:/i.test(raw)) {
    return `${titlePrefix} 查询失败，请稍后重试。`;
  }
  if (!raw || looksLikeMachineCode(raw) || isLowLevelMcpErrorDetail(raw)) {
    return `${titlePrefix} 查询失败，请稍后重试。`;
  }
  return raw;
}

async function postMcpMessage(
  message: Record<string, unknown>,
  options: {
    requestId?: string;
    session?: McpSessionState | null;
    expectJson?: boolean;
  } = {}
): Promise<{ response: Response; payload: Record<string, unknown> | null; text: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${env.mcp.internalToken}`
  };
  if (options.requestId) {
    headers['x-request-id'] = options.requestId;
  }
  if (options.session?.sessionId) {
    headers['mcp-session-id'] = options.session.sessionId;
    headers['mcp-protocol-version'] = options.session.protocolVersion;
  }

  const response = await fetchWithMcpTimeout(env.mcp.baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(message)
  });
  const { json, text } = await readResponseBody(response);
  if (options.expectJson === false) {
    return { response, payload: json, text };
  }
  return { response, payload: json, text };
}

async function initializeMcpSession(requestId?: string): Promise<McpSessionState> {
  const initId = nextRequestId('mcp-init');
  const { response, payload, text } = await postMcpMessage(
    {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'hotspot-api',
          version: '0.1.0'
        }
      }
    },
    { requestId }
  );

  if (!response.ok) {
    throw new Error(`mcp_initialize_failed:${response.status}:${text || 'unknown_error'}`);
  }
  const success = payload as JsonRpcSuccess | null;
  const result = success?.result;
  const protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : LATEST_PROTOCOL_VERSION;
  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error('mcp_initialize_missing_session_id');
  }

  const session: McpSessionState = {
    sessionId,
    protocolVersion
  };

  const initializedNotification = await postMcpMessage(
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    },
    {
      requestId,
      session,
      expectJson: false
    }
  );

  if (!initializedNotification.response.ok) {
    throw new Error(
      `mcp_initialized_notification_failed:${initializedNotification.response.status}:${initializedNotification.text || 'unknown_error'}`
    );
  }

  return session;
}

async function callMcpToolOnce(
  toolName: string,
  args: Record<string, unknown>,
  requestId?: string,
  session?: McpSessionState | null
): Promise<GuruMcpStructuredResult | GuruMcpAppsListResult> {
  const callId = nextRequestId('mcp-call');
  const { response, payload, text } = await postMcpMessage(
    {
      jsonrpc: '2.0',
      id: callId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    },
    {
      requestId,
      session
    }
  );

  if (!response.ok) {
    throw new Error(`mcp_tool_call_failed:${response.status}:${text || 'unknown_error'}`);
  }

  const body = payload as (JsonRpcSuccess & JsonRpcError) | null;
  if (body?.error?.message) {
    throw new Error(`mcp_tool_error:${body.error.message}`);
  }

  const result = body?.result as Record<string, unknown> | undefined;
  if (result?.isError === true) {
    throw new Error(`mcp_tool_error:${extractMcpContentErrorText(result.content) || toolName}`);
  }
  const structuredContent = result?.structuredContent;
  if (!structuredContent || typeof structuredContent !== 'object') {
    const contentError = extractMcpContentErrorText(result?.content);
    if (contentError) {
      throw new Error(`mcp_tool_error:${contentError}`);
    }
    throw new Error(`mcp_tool_invalid_payload:${toolName}`);
  }
  return structuredContent as GuruMcpStructuredResult | GuruMcpAppsListResult;
}

async function terminateMcpSession(session: McpSessionState, requestId?: string): Promise<void> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.mcp.internalToken}`,
    'mcp-session-id': session.sessionId,
    'mcp-protocol-version': session.protocolVersion
  };
  if (requestId) {
    headers['x-request-id'] = requestId;
  }
  await fetchWithMcpTimeout(env.mcp.baseUrl, {
    method: 'DELETE',
    headers
  }).catch(() => undefined);
}

async function callGuruMcpToolWithinSession(
  session: McpSessionState,
  toolName: string,
  args: Record<string, unknown>,
  requestId?: string
): Promise<GuruMcpStructuredResult | GuruMcpAppsListResult> {
  return callMcpToolOnce(toolName, args, requestId, session);
}

export async function callGuruMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  requestId?: string
): Promise<GuruMcpStructuredResult | GuruMcpAppsListResult> {
  const session = await initializeMcpSession(requestId);
  try {
    return await callGuruMcpToolWithinSession(session, toolName, args, requestId);
  } finally {
    await terminateMcpSession(session, requestId);
  }
}

export async function buildAiContextPacksViaMcp(
  specs: AiContextPackSpec[],
  requestId?: string
): Promise<{ packs: AiBuiltContextPack[]; packSpecs: AiContextPackSpec[]; warnings: string[] }> {
  const packs: AiBuiltContextPack[] = [];
  const packSpecs: AiContextPackSpec[] = [];
  const warnings: string[] = [];
  const session = await initializeMcpSession(requestId);

  try {
    for (const spec of specs) {
      const fallbackTitle = buildContextPackFallbackTitle(spec);
      try {
        const toolCall = resolveGuruMcpToolForContextPack(spec);
        const result = await callGuruMcpToolWithinSession(session, toolCall.name, toolCall.arguments, requestId);
        const structuredResult = result as GuruMcpStructuredResult;
        packs.push({
          type: spec.type,
          templateId: spec.templateId,
          title: structuredResult.title,
          summaryMarkdown: structuredResult.summary_markdown,
          structured: structuredResult.structured,
          rowCount: structuredResult.row_count,
          truncated: structuredResult.truncated,
          appliedFilters: structuredResult.applied_filters
        });
        packSpecs.push(spec);
        if (Array.isArray(structuredResult.warnings)) {
          warnings.push(
            ...structuredResult.warnings.map((item) =>
              toGuruMcpUserMessage(String(item), { context: 'pack', title: structuredResult.title })
            )
          );
        }
      } catch (error) {
        let title = fallbackTitle;
        try {
          title = resolveGuruMcpToolForContextPack(spec).name || fallbackTitle;
        } catch {
          title = fallbackTitle;
        }
        warnings.push(
          toGuruMcpUserMessage(error instanceof Error ? error.message : 'mcp_context_pack_failed', {
            context: 'pack',
            title
          })
        );
      }
    }
  } finally {
    await terminateMcpSession(session, requestId);
  }

  return { packs, packSpecs, warnings };
}
