# DEPLOYMENT_MINIMAL

给云端弱 Agent 使用的最简部署与迁移方案。

目标：

- 单台云服务器部署
- 独立域名 HTTPS 访问
- 完整迁移 Postgres + ClickHouse 数据
- 不依赖高智能 Agent 做复杂判断

这份方案只保留一条最短路径：

1. 先在源环境做冷迁移备份
2. 再在目标云服务器先启动数据库
3. 恢复数据库
4. 最后启动业务与域名反代

如果不是迁移旧数据，而是全新空环境，可以直接跳过第 2 节的数据备份与第 4 节的数据恢复。

---

## 1. 方案约束

为了让弱 Agent 也能稳定执行，这里固定采用：

- 单机 `Docker Compose`
- 域名反代使用 `Caddy`
- HTTPS 证书使用 `Caddy` 自动签发
- 数据迁移使用仓库内脚本：
  - `scripts/backup-cloud-migration.sh`
  - `scripts/restore-cloud-migration.sh`

不要让 Agent 自己发明以下内容：

- 不要改成 Kubernetes
- 不要改成外置 RDS / 外置 ClickHouse
- 不要手写 SQL 差量迁移
- 不要直接复制 Docker volume 目录

如果确实要做更复杂的生产化拆分，应在这套最简方案跑通之后再做。

---

## 2. 源环境备份

前提：

- 源环境和目标环境必须使用同一份代码版本
- 最简单做法是：先把源环境更新到你准备部署的同一 commit，再备份

### 2.1 进入源环境仓库

```bash
cd /path/to/ASA_AppsFlyer_System/hotspot-system
git rev-parse HEAD
```

记下这个 commit，目标云服务器也必须 checkout 到同一个 commit。

### 2.2 停止业务写入，只保留数据库

```bash
cd infra
docker compose stop api aggregator detector puller keyword-engine budget-advisor asa-keywords daily-brief asa-daily-brief bitable-export bitable-feedback-sync mcp-server
docker compose up -d postgres clickhouse
cd ..
```

### 2.3 执行备份脚本

```bash
chmod +x scripts/backup-cloud-migration.sh
./scripts/backup-cloud-migration.sh
```

成功后会得到两个产物：

- 备份目录：`migration-backups/hotspot-migration-时间戳`
- 压缩包：`migration-backups/hotspot-migration-时间戳.tar.gz`

把 `.tar.gz` 上传到云服务器即可。

---

## 3. 目标云服务器部署

### 3.1 服务器最低要求

- Ubuntu 22.04/24.04 或同类 Linux
- 已安装 Docker
- 已安装 Docker Compose Plugin
- 安全组只开放：
  - `80`
  - `443`
- 域名已配置 A 记录指向这台服务器公网 IP

最简建议：

- 域名：`hotspot.example.com`
- 不要对公网开放 `3000 / 5432 / 8123`

### 3.2 clone 仓库并切到同一 commit

```bash
git clone <repo-url>
cd ASA_AppsFlyer_System/hotspot-system
git checkout <source_commit>
```

### 3.3 准备 `.env`

```bash
cp .env.example .env
```

最小必填项：

```env
NODE_ENV=production
TZ=Asia/Shanghai
API_PORT_MAPPING=127.0.0.1:3000:3000

ADMIN_BASIC_AUTH_USER=
ADMIN_BASIC_AUTH_PASSWORD=

POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=hotspot

CLICKHOUSE_USER=
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DB=hotspot
CLICKHOUSE_API_PASSWORD=

APPSFLYER_PULL_TOKEN=
APPSFLYER_MASTER_API_TOKEN=
BI_APPSFLYER_RAWDATA_TOKEN=

FEISHU_BITABLE_ENABLED=false
DAILY_BRIEF_ENABLED=false
ASA_DAILY_BRIEF_ENABLED=false

QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_API_KEY=
QWEN_MODEL=qwen3.6-plus

MCP_INTERNAL_TOKEN=<random-long-token>
HOTSPOT_DOMAIN=hotspot.example.com
```

为了简化：

- `OPENAI_*` 可以全部留空
- `OPENROUTER_*` 可以全部留空
- 云端只保留 `Qwen` 一种模型即可
- `API_PORT_MAPPING=127.0.0.1:3000:3000` 用于确保 `api` 只接受本机回环访问，再由 `Caddy` 暴露到公网
- `docker-compose.cloud.yml` 也会强制覆盖 `api.ports` 为 `127.0.0.1:3000:3000`，避免误把 `3000` 裸露到公网
- 如果飞书消息 / 多维表格还没准备好，先保持：
  - `FEISHU_BITABLE_ENABLED=false`
  - `DAILY_BRIEF_ENABLED=false`
  - `ASA_DAILY_BRIEF_ENABLED=false`

### 3.4 迁移场景先只启动数据库

```bash
cd infra
docker compose up -d postgres clickhouse
```

这样可以避免在恢复数据库之前，`puller / budget-advisor / asa-keywords / daily-brief / bitable-export` 这些业务容器先进入调度循环。

如果这是一个全新空环境，不需要导入旧数据，可以直接跳到第 3.5 节。

### 3.5 全新空环境时启动基础服务 + 域名反代

```bash
cd infra
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build
```

只有在“不需要恢复旧数据”的全新空环境里，才直接执行这一步。

这一步会启动：

- 原有业务容器
- 新增 `caddy`

`caddy` 会自动处理：

- `80 -> 443` 证书挑战
- HTTPS 证书签发
- 域名反代到 `api:3000`

---

## 4. 目标云服务器恢复数据库

把源环境导出的 `hotspot-migration-时间戳.tar.gz` 上传到云服务器，例如：

```bash
scp hotspot-migration-20260409-120000.tar.gz user@your-server:/root/
```

然后在云服务器执行：

```bash
cd /path/to/ASA_AppsFlyer_System/hotspot-system
chmod +x scripts/restore-cloud-migration.sh
./scripts/restore-cloud-migration.sh /root/hotspot-migration-20260409-120000.tar.gz
```

这一步会做：

1. 先补齐当前版本 schema
2. 校验备份 commit 与当前仓库 commit 一致
3. 如发现业务容器正在运行，先自动停掉它们
4. 恢复 Postgres
5. 清空并恢复 ClickHouse 全库数据

恢复完成后，再启动业务服务一次：

```bash
cd infra
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d
```

如果你明确知道备份 commit 与当前仓库 commit 不一致，但已经人工确认 schema 兼容，才允许：

```bash
HOTSPOT_ALLOW_COMMIT_MISMATCH=true ./scripts/restore-cloud-migration.sh /root/hotspot-migration-20260409-120000.tar.gz
```

---

## 5. 验收

### 5.1 容器状态

```bash
cd /path/to/ASA_AppsFlyer_System/hotspot-system/infra
docker compose -f docker-compose.yml -f docker-compose.cloud.yml ps
```

重点确认：

- `api` 是 `Up`
- `postgres` 是 `Up`
- `clickhouse` 是 `Up`
- `caddy` 是 `Up`

### 5.2 HTTP 健康检查

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
curl https://$HOTSPOT_DOMAIN/ready
```

说明：

- `/health` 只表示 API 进程存活
- `/ready` 才表示 API 到 Postgres / ClickHouse 的核心依赖可用

### 5.3 浏览器验收

浏览器打开：

- `https://你的域名/login`
- `https://你的域名/ui`

如果能正常登录，说明：

- 域名反代通了
- HTTPS 生效了
- 登录 Cookie 也会走 `Secure`

### 5.4 关键日志

```bash
cd /path/to/ASA_AppsFlyer_System/hotspot-system/infra
docker compose -f docker-compose.yml -f docker-compose.cloud.yml logs --tail=100 api caddy puller budget-advisor asa-keywords
```

---

## 6. 给弱 Agent 的固定执行顺序

只允许按下面顺序执行：

1. 在源环境停止业务写入
2. 在源环境运行 `./scripts/backup-cloud-migration.sh`
3. 上传备份包到云服务器
4. 云服务器 clone 仓库并 checkout 同一 commit
5. 填写 `.env`
6. 配好域名 A 记录
7. 先执行 `docker compose up -d postgres clickhouse`
8. 执行 `./scripts/restore-cloud-migration.sh <backup.tar.gz>`
9. 再执行 `docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build`
10. 做 `/ready` 和 `/login` 验收

不要跳步。

---

## 7. 最简回滚

如果恢复后发现业务异常，最简单回滚方式是：

1. 停止目标云服务器业务容器
2. 保留当前备份包
3. 修复 `.env` / 域名 / 代码版本问题
4. 重新执行：
   - `docker compose up -d postgres clickhouse`
   - `./scripts/restore-cloud-migration.sh <backup.tar.gz>`
   - `docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build`

如果是域名切换后才出问题：

- 先把 DNS 切回旧服务器
- 不要先删旧环境

---

## 8. 最终建议

如果你现在的第一目标是“尽快稳定上线”，就坚持这套最小集合：

- 单机部署
- 本机 Postgres
- 本机 ClickHouse
- Caddy 自动 HTTPS
- 只保留 Qwen
- 冷迁移备份/恢复
- 业务服务在恢复完成后再启动

这套路径最不依赖 Agent 的理解能力，也最容易一次成功。
