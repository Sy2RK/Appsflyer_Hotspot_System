# Code Review Report — Hotspot System

> **日期**: 2026-04-28
> **审查范围**: 全项目 (apps/api, apps/mcp-server, workers/*, packages/shared, infra, scripts)
> **审查人**: AI Code Review

---

## 一、项目架构总览

### 1.1 整体结构

```
hotspot-system/
├── apps/
│   ├── api/          # Express HTTP API + WebUI (内嵌静态页面)
│   └── mcp-server/   # MCP 协议服务 (Guru Ads Agent 只读工具)
├── workers/          # 10 个独立 worker 进程
│   ├── aggregator/   # 小时级聚合
│   ├── detector/     # 异常检测
│   ├── puller/       # AppsFlyer Pull 日级拉取
│   ├── keyword-engine/     # 关键词生命周期
│   ├── budget-advisor/     # 预算建议生成
│   ├── asa-keywords/       # ASA 关键词专项
│   ├── daily-brief/        # 通用日报
│   ├── asa-daily-brief/    # ASA 简报
│   ├── bitable-export/     # 飞书多维表格导出
│   └── bitable-feedback-sync/ # 飞书反馈回读
├── packages/shared/  # 共享代码 (类型、配置、工具函数、数据访问)
├── infra/            # Docker Compose、ClickHouse/Postgres 初始化
├── scripts/          # 运维脚本
└── docs/             # 文档
```

### 1.2 技术栈

| 层次 | 技术选型 |
|------|---------|
| 语言 | TypeScript 5.7 (strict mode), Node.js 24 |
| HTTP 框架 | Express 4.19 |
| 分析数据库 | ClickHouse 24.8 (MergeTree, ReplacingMergeTree) |
| 运营数据库 | PostgreSQL 16 |
| 容器化 | Docker Compose (本地 + 云端双配置) |
| AI 集成 | MCP SDK 1.29, Qwen/OpenRouter/OpenAI 多模型 |
| 类型校验 | Zod 4.3 |
| 运行时 | tsx (dev/start) |

### 1.3 核心设计模式

1. **分布式任务锁** — 基于 PostgreSQL `pull_cycle_locks` / `job_locks` 表实现跨实例互斥
2. **调度状态持久化** — `scheduled_worker_runs` 表记录每次运行的 attempt/cooldown/completion
3. **Pull Readiness Gate** — 下游 worker 通过 `pull_report_readiness` 表等待上游数据就绪
4. **两层去重** — ClickHouse 实时查询 + PostgreSQL `ingest_dedup_keys` 表双重保障
5. **AF Dashboard D7 ROAS** — 统一 D7 ROAS 计算口径，含覆盖率分级 (complete/partial/pending/unavailable)
6. **优雅降级** — ASA keywords 允许部分切片失败后以「降级完成」继续下游链路

---

## 二、代码质量评估

### 2.1 优点 ✅

#### 架构设计
- **关注点分离清晰**: apps / workers / packages 三层分离，职责明确
- **共享代码集中管理**: `packages/shared` 作为唯一的数据访问层，避免了各 worker 重复实现 DB 查询
- **分布式协调完善**: job lock + heartbeat + scheduled run 三重机制，有效防止多实例重复执行
- **链路编排合理**: Pull → keyword-engine/budget-advisor/asa-keywords → daily-brief/bitable-export 的依赖链通过 readiness gate 显式管理

#### 代码风格
- **TypeScript strict mode**: 全项目启用 strict，类型安全有保障
- **路径别名**: `@shared/*` 和 `@api/*` 别名使导入清晰
- **错误分类体系**: [`AppsflyerRequestError`](packages/shared/utils/appsflyerRequest.ts:13) 对 HTTP/网络错误做了精细分类 (timeout/network/rate_limit/auth/not_found/server)，并区分 immediateRetryable 和 scheduledRetryable
- **日志结构化**: 所有日志使用 `logger.info/warn/error(message, context)` 模式，带 `request_id` 追踪

#### 数据处理
- **ROAS 计算严谨**: [`roasWindow.ts`](packages/shared/utils/roasWindow.ts) 中官方 D7 rolling window、覆盖率、偏差检测逻辑完整
- **去重策略可靠**: ingest 链路同时使用 ClickHouse 实时查重 + PostgreSQL dedup keys 表，防止竞态
- **内容签名去重**: Pull 链路通过 `pull_content_guard` 的 content_signature 避免重复拉取相同数据

### 2.2 需要关注的问题 ⚠️

#### P0 — 安全风险

1. **Session Token 可预测** — [`adminBasicAuth.ts:41-43`](apps/api/src/common/auth/adminBasicAuth.ts:41)
   ```typescript
   function buildSessionToken(user: string, password: string): string {
     return crypto.createHash('sha256').update(`${user}\u0000${password}`).digest('hex');
   }
   ```
   **问题**: Session token 仅由 username + password 的 SHA256 哈希生成，没有随机盐值 (salt) 或过期时间嵌入。一旦 token 泄露，攻击者可以永久使用该 token（因为 username/password 不变）。
   **建议**: 使用 `crypto.randomUUID()` 生成 session ID，将 session 数据存储在服务端（内存或 Redis），或至少在 hash 中加入随机 salt 和过期时间戳。

2. **`.env` 文件被提交到 VSCode 可见标签** — 当前 VSCode 打开了 `.env` 文件。确认 `.gitignore` 中已包含 `.env`，避免凭据泄露。

#### P1 — 可靠性风险

3. **ClickHouse 客户端无连接池/重试** — [`clickhouse.ts:4-12`](packages/shared/utils/clickhouse.ts:4)
   ```typescript
   export const clickhouse = createClient({
     url: `http://${env.clickhouse.host}:${env.clickhouse.port}`,
     ...
   });
   ```
   **问题**: `@clickhouse/client` 的默认配置没有显式设置 `max_open_connections`、`request_timeout`、`retry_on_failure` 等参数。在高并发或网络抖动场景下可能导致连接耗尽或请求卡死。
   **建议**: 显式配置连接池参数和超时/重试策略。

4. **PostgreSQL 连接池固定 max=10** — [`postgres.ts:4-7`](packages/shared/utils/postgres.ts:4)
   ```typescript
   const pool = new Pool({
     connectionString: env.postgresUrl,
     max: 10
   });
   ```
   **问题**: 10 个 worker + API + MCP server 共享同一个 Pool 定义（每个进程独立实例化），但 `max: 10` 是硬编码的。对于高并发 API 场景可能不足，对于轻量 worker 又可能过多。
   **建议**: 通过环境变量配置 `PG_POOL_MAX`，并考虑设置 `idleTimeoutMillis`、`connectionTimeoutMillis`。

5. **Ingest 链路逐条查 ClickHouse 去重** — [`ingest.routes.ts:61-71`](apps/api/src/modules/ingest/ingest.routes.ts:61)
   ```typescript
   const duplicate = await chQuery<{ c: string }>(
     `SELECT toString(count()) AS c FROM raw_events WHERE ...`,
     ...
   );
   ```
   **问题**: 对每个 push event 都执行一次 ClickHouse 查询来检查重复，在批量推送场景下会产生 N+1 查询问题。虽然已有 PostgreSQL dedup keys 表做第二层防护，但 ClickHouse 查询仍然是一个性能瓶颈。
   **建议**: 批量查询去重，或完全依赖 PostgreSQL dedup keys 表（当前已有），移除 ClickHouse 实时查重步骤。

6. **Worker 全局可变状态** — 多个 worker 使用模块级 `let running = false` 变量防止重叠执行。这在单进程中是安全的，但如果未来使用 worker_threads 或 cluster 模式，这个保护会失效。当前依赖 job lock 作为第二层防护，设计合理，但需注意这个隐含假设。

#### P2 — 代码质量改进

7. **超大文件** — 以下文件超过 1000 行，建议拆分:
   | 文件 | 行数 |
   |------|------|
   | [`asaKeywords.ts`](packages/shared/utils/asaKeywords.ts) | ~3620 |
   | [`repositories.ts`](packages/shared/utils/repositories.ts) | ~3167 |
   | [`bitableExport.ts`](packages/shared/utils/bitableExport.ts) | ~2395 |
   | [`budgetAdvisor.ts`](packages/shared/utils/budgetAdvisor.ts) | ~1648 |
   | [`dailyBrief.ts`](packages/shared/utils/dailyBrief.ts) | ~1527 |
   | [`keywordEngine.ts`](packages/shared/utils/keywordEngine.ts) | ~1239 |
   | [`puller.ts`](packages/shared/utils/puller.ts) | ~1208 |

   **建议**: 按功能域拆分为多个子模块。例如 `repositories.ts` 可以拆分为 `repositories/apps.ts`、`repositories/budget.ts`、`repositories/asa.ts` 等。

8. **缩进不一致** — [`app.module.ts:56-59`](apps/api/src/app.module.ts:56)
   ```typescript
   app.use(asaKeywordsRoutes);
   	  app.use(runtimeScheduleRoutes);
   	  app.use(aiRoutes);
   	  app.use(appsflyerRoutes);
   	  app.use(operationLogsRoutes);
   ```
   部分行使用了 tab 缩进而非空格，建议统一使用 2-space 缩进并配置 `.editorconfig`。

9. **缺少单元测试** — 项目中未发现任何测试文件（`*.test.ts` 或 `*.spec.ts`）。对于核心业务逻辑（如 ROAS 计算、关键词生命周期判定、预算建议生成），建议至少覆盖关键路径。

10. **`unknown` 类型过度使用** — 多处使用 `unknown` 类型后紧跟类型断言，例如:
    ```typescript
    const body = (req.body ?? {}) as Record<string, unknown>;
    ```
    建议使用 Zod schema 进行运行时校验，项目中已引入 Zod 4.3 但仅在 MCP server 中使用。

11. **Logger 接口不一致** — 部分模块定义了独立的 Logger 接口:
    - [`puller.ts`](packages/shared/utils/puller.ts:105): `PullLogger`
    - [`keywordEngine.ts`](packages/shared/utils/keywordEngine.ts:15): `KeywordEngineLogger`
    - [`budgetAdvisor.ts`](packages/shared/utils/budgetAdvisor.ts:45): `BudgetAdvisorLogger`
    - [`asaKeywords.ts`](packages/shared/utils/asaKeywords.ts:83): `LoggerLike`
    - [`dailyBrief.ts`](packages/shared/utils/dailyBrief.ts:25): `LoggerLike`
    - [`bitableExport.ts`](packages/shared/utils/bitableExport.ts:42): `LoggerLike`

    **建议**: 在 `packages/shared` 中统一定义一个 `Logger` 接口，所有模块引用同一个。

---

## 三、安全性审查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 生产环境强制鉴权 | ✅ | [`assertAdminAuthConfigured()`](apps/api/src/common/auth/adminBasicAuth.ts:96) 在生产环境强制要求 ADMIN_BASIC_AUTH_USER/PASSWORD |
| API 鉴权中间件 | ✅ | [`adminBasicAuthMiddleware`](apps/api/src/common/auth/adminBasicAuth.ts:105) 覆盖所有 `/api/*` 路由 |
| Push 回调鉴权 | ✅ | [`verifyPushAuthorization`](apps/api/src/common/auth/pushAuth.ts) 基于 app 级 push_auth_token |
| MCP 内部鉴权 | ✅ | [`requireInternalAuth`](apps/mcp-server/src/server.ts:39) 使用 Bearer token |
| Session Cookie 安全属性 | ✅ | HttpOnly + SameSite=Lax + 条件 Secure (基于 x-forwarded-proto) |
| 登录重定向保护 | ✅ | [`isSafeRedirectTarget`](apps/api/src/common/auth/adminBasicAuth.ts:56) 防止 open redirect |
| JSON body 大小限制 | ✅ | `express.json({ limit: '1mb' })` |
| x-powered-by 隐藏 | ✅ | `app.disable('x-powered-by')` |
| Session token 加盐 | ❌ | 见 P0-1，缺少随机盐值 |
| HTTPS 强制 | ⚠️ | 依赖反向代理 (Caddy)，应用层未强制 HTTPS 重定向 |
| 速率限制 | ❌ | 未发现 rate limiting 中间件，登录接口 `/auth/login` 无暴力破解防护 |
| CSP/安全头 | ❌ | 未设置 Content-Security-Policy、X-Content-Type-Options 等安全头 |

---

## 四、性能审查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| ClickHouse 分区策略 | ✅ | `PARTITION BY toYYYYMM(date)` 按月分区，合理 |
| ClickHouse ORDER BY 优化 | ✅ | 按常用查询维度排序 (app_key, date, media_source, country, campaign) |
| LowCardinality 使用 | ✅ | 对 media_source, country, campaign, platform 等低基数字段使用 LowCardinality |
| PostgreSQL 索引 | ✅ | 关键查询路径均有索引覆盖 |
| N+1 查询 | ⚠️ | Ingest 链路逐条查 ClickHouse (见 P1-5) |
| 连接池配置 | ⚠️ | ClickHouse 无显式连接池配置，PostgreSQL max=10 硬编码 |
| 请求间隔控制 | ✅ | Pull/ASA 链路通过 `PULLER_REQUEST_INTERVAL_MS` / `ASA_KEYWORD_REQUEST_INTERVAL_MS` 控制频率 |
| 内容去重冷却 | ✅ | `pull_content_guard` 的 same_content_cooldown 避免重复处理相同数据 |

---

## 五、基础设施审查

### 5.1 Docker Compose

**优点**:
- 本地和云端双配置分离 (`docker-compose.yml` + `docker-compose.cloud.yml`)
- 使用 YAML anchor (`&default-logging`, `*host-gateway-extra-hosts`) 减少重复
- ClickHouse 健康检查配置合理 (10s interval, 12 retries)
- 服务依赖通过 `depends_on` + `condition: service_healthy` 确保启动顺序

**建议**:
- [`docker-compose.yml`](infra/docker-compose.yml) 中 `restart: "no"` 仅用于 clickhouse 服务，其他服务使用 `unless-stopped`。建议统一策略。
- 考虑添加 `deploy.resources.limits` 限制容器资源使用
- `api` 服务同时运行 aggregator/detector/puller 逻辑（通过 `npm run start:api`），但实际上这些是独立 worker。确认 api 容器内是否只运行 API 服务。

### 5.2 Dockerfile

[`Dockerfile`](Dockerfile) 简洁有效:
- 使用 `node:24-bookworm-slim` 减小镜像体积
- `npm ci` 确保依赖版本一致
- 建议添加 `.dockerignore` 已存在 ✅

**建议**:
- 考虑多阶段构建分离 build 和 runtime
- 添加 `HEALTHCHECK` 指令
- 使用非 root 用户运行应用 (`USER node`)

### 5.3 数据库 Schema

**ClickHouse** ([`init.sql`](infra/clickhouse/init.sql)):
- 使用 `ALTER TABLE ADD COLUMN IF NOT EXISTS` 做增量迁移，兼容性好
- `ReplacingMergeTree` 用于 metrics_hourly 支持幂等重跑

**PostgreSQL** ([`init.sql`](infra/postgres/init.sql)):
- 同样使用 `ALTER TABLE ADD COLUMN IF NOT EXISTS` 模式
- 外键约束合理 (如 `rules.app_key REFERENCES apps(app_key) ON DELETE CASCADE`)
- 部分表缺少显式索引（如 `operation_logs`、`llm_audit_logs` 按时间范围查询的场景）

---

## 六、Worker 设计审查

所有 worker 遵循统一的设计模式:

```
bootstrap() → scheduleLoop (30s poll) → tick()
  ├── running 互斥锁 (进程级)
  ├── tryAcquireJobLock (分布式锁)
  ├── startJobLockHeartbeat (锁心跳)
  ├── tryClaimScheduledWorkerRunAttempt (重试控制)
  ├── withScheduledWorkerTimeout (超时保护)
  ├── run*Cycle (实际业务逻辑)
  ├── completeScheduledWorkerRun / failScheduledWorkerRun
  └── releaseJobLock (finally)
```

**评价**: 这个模式非常成熟，考虑了分布式部署、超时、重试、心跳等边界情况。

**细微差异**:
- `detector` worker 未使用 `scheduledWorkerRun` 机制（无 runMarker/retry policy），与其他 worker 不一致
- `aggregator` worker 代码未在审查范围内（仅看到入口文件列表），建议确认其是否也遵循统一模式

---

## 七、改进建议优先级排序

### 立即修复 (P0)
1. **Session token 加盐**: 使用随机 UUID + 服务端存储替代可预测的 hash
2. **登录接口限流**: 对 `/auth/login` 添加速率限制，防止暴力破解

### 短期改进 (P1)
3. **移除 Ingest 链路 ClickHouse 逐条查重**: 完全依赖 PostgreSQL dedup keys 表
4. **ClickHouse 客户端配置**: 显式设置连接池、超时、重试参数
5. **PostgreSQL 连接池可配置化**: 通过环境变量控制 pool max
6. **添加安全响应头**: helmet 中间件或手动设置 CSP/X-Content-Type-Options 等

### 中期改进 (P2)
7. **拆分超大文件**: repositories.ts, asaKeywords.ts 等
8. **统一 Logger 接口**: 在 shared 中定义标准 Logger interface
9. **修复缩进不一致**: 配置 .editorconfig + prettier
10. **添加核心逻辑单元测试**: ROAS 计算、关键词生命周期、预算建议生成
11. **Zod schema 校验**: 对 API 请求体使用 Zod 替代 `as Record<string, unknown>`

### 长期优化 (P3)
12. **Dockerfile 多阶段构建 + 非 root 用户**
13. **统一 worker 设计模式**: detector/aggregator 对齐 scheduledWorkerRun 机制
14. **添加集成测试/端到端测试**: 验证 Pull → 建议 → 日报 → 导出完整链路
15. **监控与告警**: 集成 APM 工具监控 worker 执行延迟和失败率

---

## 八、总结

Hotspot System 是一个**设计成熟、架构清晰**的内部运营系统。核心亮点包括:
- 完善的分布式协调机制（job lock + heartbeat + scheduled run）
- 严谨的 ROAS 计算口径和覆盖率分级
- 清晰的上下游链路编排

主要改进方向集中在:
- **安全加固**（session token 加盐、登录限流、安全响应头）
- **性能优化**（移除冗余 ClickHouse 查重、连接池可配置化）
- **代码可维护性**（拆分超大文件、统一接口、补充测试）

整体代码质量评级: **B+** (良好，有明确的改进空间)
