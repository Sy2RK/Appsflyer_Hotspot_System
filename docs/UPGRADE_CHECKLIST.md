# UPGRADE_CHECKLIST

适用场景：

- 已有一套旧版 `hotspot-system` 在运行
- 现在需要升级到当前版本
- 目标是**不丢现有数据、不用重新冷启动部署**

这份清单只关注“老环境升级”。如果是全新机器首次部署，优先看：

- `README.md`
- `docs/RUNBOOK.md`
- `docs/DEPLOYMENT_AGENT.md`

---

## 1. 这次升级的关键变化

本次升级不是纯前端变更，包含以下**必须同步**的运行时变化：

1. 控制面登录改为**生产环境强制凭证**
2. Postgres / ClickHouse 不再允许依赖仓库内弱默认凭据
3. `alerts` 表新增 `platform`
4. ASA 切片改为 `snapshot_id` + `asa_slice_snapshots` 快照切换
5. Feishu 推送成功判定更严格
6. 路由日报开始支持真正的 `app + platform` 告警过滤

结论：

- **必须补环境变量**
- **必须补数据库 schema**
- **必须重启相关服务**

---

## 2. 升级前准备

### 2.1 进入仓库

```bash
cd /path/to/hotspot-system
```

### 2.2 拉取新代码

```bash
git pull --ff-only
```

### 2.3 备份当前数据库

建议至少先做一份逻辑备份。

#### Postgres

```bash
docker exec hotspot-postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /tmp/hotspot-pre-upgrade.dump
```

#### ClickHouse

```bash
mkdir -p /tmp/hotspot-clickhouse-pre-upgrade

docker exec hotspot-clickhouse clickhouse-client --query "
SELECT name
FROM system.tables
WHERE database = 'hotspot'
  AND engine NOT LIKE '%View%'
ORDER BY name
" > /tmp/hotspot-upgrade-tables.list

for t in $(cat /tmp/hotspot-upgrade-tables.list); do
  echo "Backing up $t"
  docker exec hotspot-clickhouse clickhouse-client --query "SELECT * FROM hotspot.$t FORMAT Native" > /tmp/hotspot-clickhouse-pre-upgrade/$t.native
done
```

---

## 3. 必须补齐的 `.env` 项

升级前先检查这些值是否已在生产环境 `.env` 中显式配置：

```env
ADMIN_BASIC_AUTH_USER=
ADMIN_BASIC_AUTH_PASSWORD=
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=
CLICKHOUSE_USER=
CLICKHOUSE_PASSWORD=
CLICKHOUSE_API_PASSWORD=
```

### 3.1 必须满足的要求

- 以上值都必须非空
- 不允许继续依赖旧版仓库内的默认弱口令
- `CLICKHOUSE_API_PASSWORD` 用于初始化 / 更新 `hotspot_api` 用户

### 3.2 快速检查

```bash
grep -E '^(ADMIN_BASIC_AUTH_USER|ADMIN_BASIC_AUTH_PASSWORD|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|CLICKHOUSE_USER|CLICKHOUSE_PASSWORD|CLICKHOUSE_API_PASSWORD)=' .env
```

如果任何一项为空：

- **停止升级**
- 先补齐 `.env`

---

## 4. 停止业务服务，保留数据库

升级 schema 前，不要让业务 worker 继续写库。

```bash
cd infra

docker compose stop api aggregator detector puller keyword-engine budget-advisor asa-keywords daily-brief asa-daily-brief bitable-export
```

保留数据库：

```bash
docker compose up -d postgres clickhouse
```

---

## 5. 执行数据库升级

### 5.1 Postgres 升级

执行初始化 SQL，让新增列 / 表补齐：

```bash
cd /path/to/hotspot-system

docker exec -i hotspot-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < infra/postgres/init.sql
```

### 5.2 验证 Postgres 变更

检查 `alerts.platform` 是否已存在：

```bash
docker exec hotspot-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d alerts"
```

预期：

- 存在字段 `platform`

如果你想把历史告警全部标记成全局平台，可补一次：

```bash
docker exec hotspot-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE alerts SET platform='__all__' WHERE platform IS NULL OR platform='';"
```

### 5.3 ClickHouse 升级

执行 schema 补齐：

```bash
docker exec -i hotspot-clickhouse clickhouse-client -n < infra/clickhouse/init.sql
```

### 5.4 验证 ClickHouse 变更

检查新增列：

```bash
docker exec hotspot-clickhouse clickhouse-client --query "DESCRIBE TABLE hotspot.asa_raw_installs"
docker exec hotspot-clickhouse clickhouse-client --query "DESCRIBE TABLE hotspot.asa_raw_in_app_events"
docker exec hotspot-clickhouse clickhouse-client --query "DESCRIBE TABLE hotspot.asa_keyword_daily_metrics_v2"
```

预期：

- 三张表都存在 `snapshot_id`

检查快照表：

```bash
docker exec hotspot-clickhouse clickhouse-client --query "EXISTS hotspot.asa_slice_snapshots"
```

预期：

- 返回 `1`

---

## 6. 更新 ClickHouse 业务账号

本次升级后，`hotspot_api` 不应继续使用旧的固定密码。

### 6.1 直接执行初始化脚本

```bash
cd /path/to/hotspot-system
CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" CLICKHOUSE_API_PASSWORD="$CLICKHOUSE_API_PASSWORD" sh infra/clickhouse/init.sh
```

### 6.2 验证 `hotspot_api` 权限

建议在 ClickHouse 内检查用户是否存在：

```bash
docker exec hotspot-clickhouse clickhouse-client --query "SHOW USERS"
```

如果需要进一步确认，可以用应用侧配置做一次 API 健康校验，见后文第 8 节。

---

## 7. 重建并启动业务服务

建议直接按当前代码重建全部业务容器：

```bash
cd /path/to/hotspot-system/infra

docker compose up -d --build api aggregator detector puller keyword-engine budget-advisor asa-keywords daily-brief asa-daily-brief bitable-export
```

---

## 8. 升级后验证

### 8.1 健康检查

```bash
curl http://localhost:3000/health
```

### 8.2 控制面登录检查

预期：

- 访问 `/ui` 会跳到 `/login`
- 登录页不再显示默认账号/密码
- 未配置 `ADMIN_BASIC_AUTH_*` 时，生产环境 API 不应成功启动

### 8.3 规则 DSL 校验检查

使用一个非法规则请求测试保存，预期返回 `400`：

```bash
curl -X POST "http://localhost:3000/api/rules" \
  -H "Content-Type: application/json" \
  -d '{
    "appKey":"ai-seek",
    "name":"bad-rule",
    "severity":"P1",
    "rule_json":{
      "granularity":"hour",
      "metric_rules":[
        {
          "metric":"revenue",
          "window":"last_99h",
          "baseline":"avg_7d_same_hour",
          "drop_pct":40
        }
      ]
    }
  }'
```

### 8.4 Detector 日志检查

```bash
docker compose logs --tail=200 detector
```

预期：

- 即使存在坏规则，也不会整轮 detector 崩掉
- 单条规则错误应记录为 `rule_parse_failed` 或 `rule_eval_failed`

### 8.5 ASA 快照链路检查

手动触发一次 ASA 重算：

```bash
curl -X POST "http://localhost:3000/api/asa-keywords/recompute" \
  -H "Content-Type: application/json" \
  -d '{"backfillDays":1}'
```

检查快照表：

```bash
docker exec hotspot-clickhouse clickhouse-client --query "
SELECT app_key, platform, date, snapshot_id, status
FROM hotspot.asa_slice_snapshots
ORDER BY created_at DESC
LIMIT 20
"
```

预期：

- 能看到新的 `ready` 快照

### 8.6 路由日报平台告警检查

执行 detector 后，抽查 `alerts`：

```bash
docker exec hotspot-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select app_key, platform, severity, status, created_at from alerts order by created_at desc limit 20;"
```

预期：

- 新告警会写入 `platform`
- 值通常为：`__all__` / `ios` / `android`

### 8.7 Feishu 与多维表检查

检查日志：

```bash
docker compose logs --tail=200 api daily-brief asa-daily-brief bitable-export
```

重点确认：

- Feishu 空 body / 非 JSON body 不再被记为成功
- bitable `partial_success` 会在消息里明确显示“部分成功”

---

## 9. 若升级后出现问题，优先排查顺序

### 9.1 API 无法启动

先检查：

```bash
docker compose logs --tail=200 api
```

优先看：

- `ADMIN_BASIC_AUTH_*` 是否缺失
- `POSTGRES_URL` / `POSTGRES_USER` / `POSTGRES_PASSWORD` 是否正确
- `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` 是否正确

### 9.2 `/ui` 登录失败

检查：

- `.env` 里的 `ADMIN_BASIC_AUTH_USER`
- `.env` 里的 `ADMIN_BASIC_AUTH_PASSWORD`
- 浏览器是否保留了旧 cookie

必要时清理 cookie 后重试。

### 9.3 ASA 简报或 ASA 页面为空

检查顺序：

1. `asa-keywords` 是否已成功重算
2. `asa_slice_snapshots` 是否存在 `ready` 数据
3. `APPSFLYER_MASTER_API_TOKEN` 是否可用
4. `BI_APPSFLYER_RAWDATA_TOKEN` 是否可用

### 9.4 路由日报告警不对

检查：

1. `alerts.platform` 是否已补齐
2. detector 是否在新版本下重新产出过告警
3. 该路由是否本身带了 `media_source` 过滤
   - 当前 `media_source` 路由仍然不会做精准告警切分

---

## 10. 升级完成判定

满足以下条件即可判定升级成功：

1. API / WebUI 正常启动
2. `/ui` 已启用登录页
3. Postgres `alerts` 表存在 `platform`
4. ClickHouse ASA 三张表存在 `snapshot_id`
5. `hotspot.asa_slice_snapshots` 已存在
6. detector 不会被单条坏规则打断
7. 保存非法 DSL 会返回 `400`
8. ASA 重算后可见 `ready` 快照
9. Feishu 与 bitable 推送状态文案与真实结果一致

---

## 11. 不要这样升级

不要做以下操作：

- 不备份直接改 schema
- 不停 worker 就直接跑升级 SQL
- 用旧版弱默认口令继续上线
- 只更新代码，不补 `.env`
- 只重启 `api`，不重启相关 worker

---

## 12. 建议执行顺序（最短版）

```bash
# 1. 拉代码
cd /path/to/hotspot-system
git pull --ff-only

# 2. 补 .env
# 手工补齐 ADMIN_BASIC_AUTH_* / POSTGRES_* / CLICKHOUSE_*

# 3. 停业务服务
cd infra
docker compose stop api aggregator detector puller keyword-engine budget-advisor asa-keywords daily-brief asa-daily-brief bitable-export

# 4. 跑 schema 升级
cd /path/to/hotspot-system
docker exec -i hotspot-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < infra/postgres/init.sql
docker exec -i hotspot-clickhouse clickhouse-client -n < infra/clickhouse/init.sql
CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" CLICKHOUSE_API_PASSWORD="$CLICKHOUSE_API_PASSWORD" sh infra/clickhouse/init.sh

# 5. 重建业务服务
cd infra
docker compose up -d --build api aggregator detector puller keyword-engine budget-advisor asa-keywords daily-brief asa-daily-brief bitable-export

# 6. 验证
curl http://localhost:3000/health
```
