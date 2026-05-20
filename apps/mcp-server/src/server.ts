import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { env } from '@shared/config/env.js';
import { buildAiContextPack } from '@shared/utils/aiContextPacks.js';
import { resolveDisplayName, resolvePlatformDisplayName } from '@shared/utils/displayName.js';
import {
  GURU_MCP_TOOL_NAMES,
  toGuruMcpStructuredResult,
  type GuruMcpAppsListResult,
  type GuruMcpStructuredResult
} from '@shared/utils/guruMcp.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { listApps } from '@shared/utils/repositories.js';
import { logger } from './logger.js';

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const sessions = new Map<string, SessionEntry>();

function sendJsonRpcHttpError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {
      code,
      message
    },
    id: null
  });
}

function requireInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = String(req.header('authorization') || '').trim();
  const expected = `Bearer ${env.mcp.internalToken}`;
  if (!authHeader || authHeader !== expected) {
    return sendJsonRpcHttpError(res, 401, -32001, 'Unauthorized');
  }
  next();
}

async function writeGuruMcpAudit(input: {
  requestId?: string;
  action: string;
  appKey?: string;
  status: 'success' | 'failed' | 'skipped' | 'info';
  summary: string;
  detailJson: Record<string, unknown>;
}): Promise<void> {
  await writeOperationLog(
    {
      source: 'guru_mcp',
      action: input.action,
      target_type: input.appKey ? 'app' : 'mcp',
      target_key: input.appKey ?? '',
      status: input.status,
      summary: input.summary,
      detail_json: {
        request_id: input.requestId ?? '',
        ...input.detailJson
      }
    },
    logger
  );
}

async function executeReadOnlyTool(
  params: {
    requestId?: string;
    toolName: string;
    appKey?: string;
    filters: Record<string, unknown>;
  },
  build: () => Promise<GuruMcpStructuredResult | GuruMcpAppsListResult>
) {
  const startedAt = Date.now();
  try {
    const result = await build();
    await writeGuruMcpAudit({
      requestId: params.requestId,
      action: params.toolName,
      appKey: params.appKey,
      status: 'success',
      summary: `Guru MCP 调用 ${params.toolName} 成功`,
      detailJson: {
        filters: params.filters,
        row_count: result.row_count,
        truncated: result.truncated,
        duration_ms: Date.now() - startedAt,
        warnings: result.warnings ?? []
      }
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result)
        }
      ],
      structuredContent: result
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeGuruMcpAudit({
      requestId: params.requestId,
      action: params.toolName,
      appKey: params.appKey,
      status: 'failed',
      summary: `Guru MCP 调用 ${params.toolName} 失败`,
      detailJson: {
        filters: params.filters,
        duration_ms: Date.now() - startedAt,
        error: message
      }
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${message}`
        }
      ],
      isError: true
    };
  }
}

function createGuruMcpServer(requestId?: string): McpServer {
  const server = new McpServer(
    {
      name: 'guru-ads-agent-mcp',
      version: '1.0.0'
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  server.registerTool(
    GURU_MCP_TOOL_NAMES.appsList,
    {
      title: '应用列表',
      description: '列出当前已配置的应用信息。',
      annotations: {
        readOnlyHint: true
      }
    },
    async () =>
      executeReadOnlyTool(
        {
          requestId,
          toolName: GURU_MCP_TOOL_NAMES.appsList,
          filters: {}
        },
        async () => {
          const apps = await listApps();
          const normalizedApps = apps.map((app) => {
            const displayName = resolveDisplayName(app.app_key, app.display_name);
            return {
              app_key: app.app_key,
              display_name: displayName,
              ios_display_name: resolvePlatformDisplayName(app.app_key, displayName, app.ios_display_name, 'iOS'),
              android_display_name: resolvePlatformDisplayName(
                app.app_key,
                displayName,
                app.android_display_name,
                'Android'
              ),
              dataset: app.dataset,
              timezone: app.timezone,
              has_ios_app_id: Boolean(app.ios_pull_app_id || app.pull_app_id),
              has_android_app_id: Boolean(app.android_pull_app_id || app.pull_app_id)
            };
          });
          const summaryMarkdown = [
            '### 应用列表',
            normalizedApps.length > 0
              ? normalizedApps
                  .map((app) => `- ${app.display_name}（${app.app_key}）/ 时区 ${app.timezone || '未配置'} / 数据集 ${app.dataset}`)
                  .join('\n')
              : '- 当前暂无已配置应用'
          ].join('\n');

          return {
            title: '应用列表',
            summary_markdown: summaryMarkdown,
            structured: {
              apps: normalizedApps
            },
            row_count: normalizedApps.length,
            truncated: false,
            applied_filters: {}
          } satisfies GuruMcpAppsListResult;
        }
      )
  );

  server.registerTool(
    GURU_MCP_TOOL_NAMES.metricsGetTrend,
    {
      title: '指标时序',
      description: '按当前应用、时间窗口和维度读取指标时序聚合。',
      annotations: {
        readOnlyHint: true
      },
      inputSchema: {
        appKey: z.string().min(1),
        templateId: z.enum(['media_source', 'country', 'campaign']),
        platform: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        source: z.enum(['push', 'pull']).optional(),
        metric: z.string().optional(),
        eventName: z.string().optional()
      }
    },
    async (args) =>
      executeReadOnlyTool(
        {
          requestId,
          toolName: GURU_MCP_TOOL_NAMES.metricsGetTrend,
          appKey: args.appKey,
          filters: args
        },
        async () =>
          toGuruMcpStructuredResult(
            await buildAiContextPack({
              type: 'metrics_trend',
              ...args
            })
          )
      )
  );

  server.registerTool(
    GURU_MCP_TOOL_NAMES.roasGetSummary,
    {
      title: 'AF Dashboard D7 ROAS',
      description: '按 AF Cohort API roas KPI 读取官方 D7 ROAS 摘要，并返回 D-6 至 D rolling window。',
      annotations: {
        readOnlyHint: true
      },
      inputSchema: {
        appKey: z.string().min(1),
        templateId: z.enum(['dashboard_d7_roas', 'mature_window']).optional(),
        scope: z.enum(['budget', 'asa']).optional(),
        platform: z.string().optional(),
        reportDate: z.string().optional()
      }
    },
    async (args) =>
      executeReadOnlyTool(
        {
          requestId,
          toolName: GURU_MCP_TOOL_NAMES.roasGetSummary,
          appKey: args.appKey,
          filters: args
        },
        async () =>
          toGuruMcpStructuredResult(
            await buildAiContextPack({
              type: 'roas_summary',
              ...args,
              templateId: args.templateId ?? 'dashboard_d7_roas'
            })
          )
      )
  );

  server.registerTool(
    GURU_MCP_TOOL_NAMES.budgetGetSummary,
    {
      title: '预算建议摘要',
      description: '按当前应用、日期和筛选条件读取预算建议聚合。',
      annotations: {
        readOnlyHint: true
      },
      inputSchema: {
        appKey: z.string().min(1),
        templateId: z.enum(['platform_media_source', 'action_status', 'keyword']),
        platform: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        status: z.string().optional(),
        executionStatus: z.string().optional(),
        isAdopted: z.boolean().optional(),
        hasManualReview: z.boolean().optional()
      }
    },
    async (args) =>
      executeReadOnlyTool(
        {
          requestId,
          toolName: GURU_MCP_TOOL_NAMES.budgetGetSummary,
          appKey: args.appKey,
          filters: args
        },
        async () =>
          toGuruMcpStructuredResult(
            await buildAiContextPack({
              type: 'budget_summary',
              ...args
            })
          )
      )
  );

  server.registerTool(
    GURU_MCP_TOOL_NAMES.asaKeywordsGetSummary,
    {
      title: 'ASA 关键词摘要',
      description: '按当前应用、日期和筛选条件读取 ASA 关键词聚合。',
      annotations: {
        readOnlyHint: true
      },
      inputSchema: {
        appKey: z.string().min(1),
        templateId: z.enum(['stage', 'campaign_adset', 'keyword']),
        platform: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        stage: z.string().optional(),
        keyword: z.string().optional(),
        campaign: z.string().optional()
      }
    },
    async (args) =>
      executeReadOnlyTool(
        {
          requestId,
          toolName: GURU_MCP_TOOL_NAMES.asaKeywordsGetSummary,
          appKey: args.appKey,
          filters: args
        },
        async () =>
          toGuruMcpStructuredResult(
            await buildAiContextPack({
              type: 'asa_keyword_summary',
              ...args
            })
          )
      )
  );

  return server;
}

export function createGuruMcpApp() {
  const app = createMcpExpressApp({ host: env.mcp.bindHost });
  app.use((req, res, next) => {
    const requestId = String(req.header('x-request-id') || '').trim() || randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });
  app.use(requireInternalAuth);

  app.post('/mcp', async (req, res) => {
    const sessionId = String(req.header('mcp-session-id') || '').trim();
    try {
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          return sendJsonRpcHttpError(res, 404, -32000, 'Bad Request: No valid session ID provided');
        }
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        return sendJsonRpcHttpError(res, 400, -32000, 'Bad Request: No valid session ID provided');
      }

      let createdEntry: SessionEntry | null = null;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (createdSessionId) => {
          if (createdEntry) {
            sessions.set(createdSessionId, createdEntry);
          }
        },
        onsessionclosed: (closedSessionId) => {
          const entry = sessions.get(closedSessionId);
          if (entry) {
            void entry.transport.close().catch(() => undefined);
            void entry.server.close().catch(() => undefined);
            sessions.delete(closedSessionId);
          }
        }
      });
      const server = createGuruMcpServer(req.requestId);
      createdEntry = {
        server,
        transport
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('guru_mcp_request_failed', {
        request_id: req.requestId,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        sendJsonRpcHttpError(res, 500, -32603, 'Internal server error');
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST, DELETE').send('Method Not Allowed');
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = String(req.header('mcp-session-id') || '').trim();
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'mcp_session_id_required' });
    }

    const entry = sessions.get(sessionId);
    if (!entry) {
      return res.status(204).end();
    }

    sessions.delete(sessionId);
    await Promise.allSettled([entry.transport.close(), entry.server.close()]);
    return res.status(204).end();
  });

  return app;
}

export async function closeGuruMcpSessions(): Promise<void> {
  const entries = Array.from(sessions.values());
  sessions.clear();
  await Promise.allSettled(
    entries.flatMap((entry) => [entry.transport.close(), entry.server.close()])
  );
}
