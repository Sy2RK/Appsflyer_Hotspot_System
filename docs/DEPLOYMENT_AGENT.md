# DEPLOYMENT_AGENT

给远程服务器上的 AI Agent 使用的**冷启动部署剧本**。目标不是解释业务，而是让能力较弱的 Agent 在 `git clone` 之后，也能按固定顺序完成：

- 首次部署
- 增量发布
- 基础验收
- 常见故障定位

配套文档：

- 项目概览：`README.md`
- 接口：`docs/API.md`
- 表结构：`docs/SCHEMA.md`
- 功能验证：`docs/RUNBOOK.md`

---

## 1. 这份文档适合谁

适用于以下场景：

- 远程服务器上刚 clone 仓库
- Agent 对项目业务不熟
- 需要按固定步骤完成部署和验收
- 不希望 Agent 自行推断哪些服务要启动

这份文档默认 Agent 只做**仓库里已经存在的事情**，不临时发明部署方法。

---

## 2. 人工必须先提供的东西

Agent 可以执行命令、启动容器、跑接口验证，但以下内容通常必须由人类提前准备：

### 2.1 基础环境

- 一台可联网的 Linux 服务器
- 已安装：
  - Docker
  - Docker Compose Plugin
- 允许对外访问：
  - `3000`（API / WebUI）
  - `5432`（Postgres，仅在需要外连时）
  - `8123`（ClickHouse HTTP，仅在需要外连时）

### 2.2 必填密钥与账号

- AppsFlyer
  - `APPSFLYER_PULL_TOKEN`
  - `APPSFLYER_MASTER_API_TOKEN`
  - `BI_APPSFLYER_RAWDATA_TOKEN`
- Feishu 消息
  - `FEISHU_APP_ID`
  - `FEISHU_APP_SECRET`
  - `FEISHU_CHAT_ID`
- Feishu 多维表格
  - `FEISHU_BITABLE_APP_TOKEN`
  - `FEISHU_BITABLE_PULL_TABLE_ID`
  - `FEISHU_BITABLE_PULL_VIEW_ID`
- 控制面登录
  - `ADMIN_BASIC_AUTH_USER`
  - `ADMIN_BASIC_AUTH_PASSWORD`
- 数据库
  - `POSTGRES_USER`
  - `POSTGRES_PASSWORD`
  - `POSTGRES_DB`
  - `CLICKHOUSE_USER`
  - `CLICKHOUSE_PASSWORD`
  - `CLICKHOUSE_API_PASSWORD`
- Qwen
  - `QWEN_BASE_URL`
  - `QWEN_API_KEY`

### 2.3 Agent 不应擅自处理的事情

下面这些事情如果缺失，Agent 应停下来并明确说明，而不是自己乱填：

- `.env` 中的真实 token / secret
- AppsFlyer / Feishu 后台授权
- 生产数据库数据清理
- Docker volume 删除

---

## 3. Agent 可以自动完成的事情

在具备上面条件后，Agent 可以自动完成：

- clone 仓库
- 复制并检查 `.env`
- 启动全部容器
- 补跑仓库已有初始化脚本
- 调接口做冒烟验证
- 查看日志判断哪个 worker 异常
- 重建单个服务或全量服务
- 手动触发日报 / ASA / 多维表格导出验证

---

## 4. 项目服务与默认调度

主要服务：

- `api`
- `aggregator`
- `detector`
- `puller`
- `keyword-engine`
- `budget-advisor`
- `asa-keywords`
- `daily-brief`
- `asa-daily-brief`
- `bitable-export`
- `clickhouse`
- `postgres`

固定时区：

- `Asia/Shanghai`
- 等价于 `UTC+8`

默认调度：

- `puller`：每天 `09:00`
- `asa-keywords`：每天 `09:00`
- `daily-brief`：每天 `10:00`
- `asa-daily-brief`：每天 `10:00`
- `bitable-export`：每天 `10:05`

说明：
- 以上是初始化默认值
- 启动后可在 WebUI 顶部 `全局调度设置` 中修改：
  - `Pull 时间`
  - `推送时间`
- `bitable-export` 固定使用 `推送时间 + 5 分钟`
- 数据库存储表为：`runtime_schedule_configs`

控制面登录行为：
- 未登录浏览器访问 `/ui` / `/ui/` 时，会重定向到 `/login`
- 未登录访问 `/api/*` 时，会返回 `401`
- 登录成功后依赖 Cookie 会话访问控制面
- Cookie 只会在 HTTPS 或 `x-forwarded-proto=https` 时带 `Secure`
  - 本地 HTTP 验证允许正常登录
  - 生产环境必须通过 HTTPS / 反向代理访问

---

## 5. 冷启动部署剧本

这一节是**首次部署**的线性流程。低能力 Agent 应严格按顺序执行，不要跳步。

### 5.1 检查服务器依赖

在服务器上先执行：

```bash
docker --version
docker compose version
df -h
```

成功判定：

- Docker 命令存在
- `docker compose` 可用
- 磁盘剩余空间不是明显不足

如果失败：

- Docker 不存在：停止，要求人工先安装 Docker
- `docker compose` 不存在：停止，要求人工补装 Compose Plugin

### 5.2 clone 仓库

```bash
git clone <repo-url>
cd ASA_AppsFlyer_System/hotspot-system
```

成功判定：

- 当前目录下能看到：
  - `infra/`
  - `apps/`
  - `packages/`
  - `.env.example`

如果仓库目录名不同，只要最终进入 `hotspot-system` 即可。

### 5.3 准备 `.env`

如果 `.env` 不存在：

```bash
cp .env.example .env
```

快速检查关键变量：

```bash
grep -E '^(TZ|FEISHU_|APPSFLYER_|BI_APPSFLYER_|QWEN_)' .env
```

最低要求：

- `TZ=Asia/Shanghai`
- AppsFlyer token 已填写
- Feishu 消息 token 已填写
- Feishu 多维表格配置已填写
- Qwen key 已填写

如果只是占位值或空值：

- 停止
- 明确告诉用户哪些变量缺失
- 不要继续启动

### 5.4 启动全部服务

```bash
cd infra
docker compose up -d --build
```

成功判定：

- `docker compose ps` 中主要服务处于 `Up`
- 没有连续重启的容器

建议立即查看：

```bash
docker compose ps
docker compose logs --tail=100 api
```

如果失败：

- 镜像构建失败：先读失败服务日志，不要盲目重跑
- 某服务持续重启：先记录服务名，再看该服务日志

### 5.5 初始化数据库

全新环境一般会自动初始化；如果容器已启动但表不完整，补跑仓库内已有脚本。

#### Postgres

```bash
docker exec -i hotspot-postgres psql -U postgres -d hotspot < infra/postgres/init.sql
```

#### ClickHouse

```bash
docker exec -i hotspot-clickhouse clickhouse-client -n < infra/clickhouse/init.sql
```

成功判定：

- 脚本执行不报错
- 后续 API 冒烟不再出现缺表 / 缺列错误

如果失败：

- 先看错误是否为“对象已存在”
- 若只是已存在，通常可视为兼容补跑成功
- 若是语法或权限错误，停止并记录原始报错

### 5.6 做最小健康检查

```bash
curl http://localhost:3000/health
```

成功判定：

- 返回 HTTP `200`
- body 含 `ok`

如果失败：

- 先看 `api` 日志：

```bash
docker compose logs --tail=200 api
```

### 5.7 做关键 API 冒烟

#### Pull 明细

```bash
curl -G "http://localhost:3000/api/pull-records" \
  --data-urlencode "from=2026-03-17" \
  --data-urlencode "to=2026-03-18" \
  --data-urlencode "page=1"
```

#### 通用日报预览

```bash
curl -G "http://localhost:3000/api/daily-brief/preview" \
  --data-urlencode "reportDate=2026-03-18"
```

#### ASA 简报预览

```bash
curl -G "http://localhost:3000/api/asa-keywords/brief/preview" \
  --data-urlencode "reportDate=2026-03-18"
```

#### 多维表格配置

```bash
curl "http://localhost:3000/api/bitable-exports/configs"
```

#### 全局调度配置

```bash
curl "http://localhost:3000/api/runtime-schedule"
```

成功判定：

- 接口返回 `200`
- 返回 JSON 结构正常
- 不出现缺表 / 缺字段 / token 缺失报错

### 5.8 查看关键 worker 日志

至少看这几个：

```bash
docker compose logs --tail=100 puller
docker compose logs --tail=100 daily-brief
docker compose logs --tail=100 asa-keywords
docker compose logs --tail=100 bitable-export
```

成功判定：

- worker 正常启动
- 有下一次调度时间或正常执行日志
- 没有连续异常刷屏

### 5.9 打开 WebUI

浏览器访问：

- `http://localhost:3000/ui`

至少确认这些页面能打开：

- 总览
- Pull 明细
- ASA 关键词管理
- 原始数据表格推送

---

## 6. 增量发布剧本

适用于服务器上已经有一版运行中的系统，只需要升级代码。

### 6.1 标准增量发布

```bash
cd hotspot-system
git pull origin main
cd infra
docker compose up -d --build api aggregator detector puller keyword-engine budget-advisor asa-keywords daily-brief asa-daily-brief bitable-export
```

### 6.2 小范围重建

如果只改了 WebUI 或 API：

```bash
cd hotspot-system/infra
docker compose up -d --build api
```

如果只改了某个 worker：

```bash
cd hotspot-system/infra
docker compose up -d --build <worker-name>
```

### 6.3 何时需要补跑数据库脚本

出现以下情况时，不要凭感觉跳过：

- 新增 Postgres 表 / 索引 / 配置表
- 新增 ClickHouse 表 / 列
- 新增 worker 依赖的新表结构

补跑方式仍然使用：

- `infra/postgres/init.sql`
- `infra/clickhouse/init.sql`

---

## 7. 多维表格导出专项验收

### 7.1 手动跑 Pull 明细导出

```bash
curl -X POST "http://localhost:3000/api/bitable-exports/run" \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"pull_daily","reportDate":"2026-03-17"}'
```

预期：

- 返回 `ok: true`
- `record_count > 0`
- `notify.ok = true`
- `table_id = tblARnjXQhrXquyh`

### 7.2 手动跑 ASA Raw 导出

```bash
curl -X POST "http://localhost:3000/api/bitable-exports/run" \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"asa_raw","reportDate":"2026-03-17"}'
```

预期：

- 返回 `ok: true`
- `record_count > 0`
- `notify.ok = true`
- `table_id` 存在
- 同一 Base 下有 `ASA Raw 明细`

### 7.3 查看操作日志

```bash
curl -G "http://localhost:3000/api/operation-logs" \
  --data-urlencode "source=api.bitable_export" \
  --data-urlencode "limit=20"
```

---

## 8. 常见故障与处理顺序

### 8.1 `health` 失败

先看：

```bash
docker compose logs --tail=200 api
```

常见原因：

- `.env` 缺失关键变量
- Postgres / ClickHouse 未成功启动
- 初始化表结构不完整

### 8.2 Pull 有数据，但日报为空

优先检查：

- `puller` 是否在当前 `pull_time` 后成功完成
- `daily-brief` 是否在当前 `push_time` 时读取到了前一天数据

```bash
docker compose logs --tail=200 puller
docker compose logs --tail=200 daily-brief
```

### 8.3 ASA 指标异常

如果 `eCPI / CPP / D7 ROAS` 异常：

- 先确认是否真的没有安装
- 再确认是否没有收入事件
- 再确认 Master API 成本是否回流

注意：

- 现在 ASA 成本主来源是 `Master API`
- 不要再把 Raw Data `cost_value` 当成主成本来源

### 8.4 多维表格导出失败

```bash
docker compose logs --tail=200 api
docker compose logs --tail=200 bitable-export
```

常见问题：

- `WrongRequestBody`
  - Feishu 请求体格式不对
- `FieldNameDuplicated`
  - 首次建表后字段补齐的短暂一致性问题
- `bitable_export_running`
  - 已有一轮导出在跑，全局串行锁生效

### 8.5 同日重复导出较慢

当前实现为了幂等，会：

- 扫描指定 `report_date` 的旧记录
- 删除旧记录
- 再批量写入新记录

这属于已知实现特性，不代表失败。

---

## 9. Agent 推荐执行顺序

当用户要求“在远程服务器部署并验证”时，建议固定按这个顺序：

1. 检查 Docker / Compose
2. clone 仓库并进入 `hotspot-system`
3. 检查 `.env`
4. 启动全部服务
5. 必要时补跑数据库脚本
6. `health`
7. 关键 API 冒烟
8. 关键 worker 日志
9. WebUI 打开
10. 如涉及 Feishu，至少做一轮预览或手动导出 / 手动发送

低能力 Agent 不应自行改顺序。

---

## 10. 禁止事项

不要在未确认的情况下执行以下操作：

- `git reset --hard`
- 删除 Docker volume
- 清空 Postgres / ClickHouse
- 擅自修改真实 token
- 用假数据覆盖真实 Feishu 表

遇到需要这些动作的情况，必须先向人类说明影响。

---

## 11. 建议的部署结果回报格式

Agent 完成后，建议按下面格式向人类汇报：

- 本次是首次部署还是增量发布
- 重建了哪些服务
- 是否补跑了 `init.sql`
- `health` 是否通过
- 哪些 API 冒烟通过
- 哪些 worker 日志正常
- 哪些链路未验证
- 是否还需要人工确认：
  - AppsFlyer 后台
  - Feishu 机器人
  - Feishu 多维表格权限
