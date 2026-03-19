CREATE TABLE IF NOT EXISTS apps (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  ios_display_name TEXT NOT NULL DEFAULT '',
  android_display_name TEXT NOT NULL DEFAULT '',
  pull_app_id TEXT NOT NULL DEFAULT '',
  ios_pull_app_id TEXT NOT NULL DEFAULT '',
  android_pull_app_id TEXT NOT NULL DEFAULT '',
  dataset TEXT NOT NULL,
  push_auth_token TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  notify_webhook_url TEXT,
  notify_feishu_app_id TEXT,
  notify_feishu_app_secret TEXT,
  notify_feishu_chat_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE apps ADD COLUMN IF NOT EXISTS pull_app_id TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS ios_display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS android_display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS ios_pull_app_id TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS android_pull_app_id TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS notify_feishu_app_id TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS notify_feishu_app_secret TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS notify_feishu_chat_id TEXT;

CREATE TABLE IF NOT EXISTS rules (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL REFERENCES apps(app_key) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rule_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rules_app_name
  ON rules (app_key, name);

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL,
  rule_id BIGINT REFERENCES rules(id) ON DELETE SET NULL,
  severity TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  metric TEXT NOT NULL,
  "window" TEXT NOT NULL,
  current_value DOUBLE PRECISION NOT NULL,
  baseline_value DOUBLE PRECISION NOT NULL,
  delta_value DOUBLE PRECISION NOT NULL,
  delta_ratio DOUBLE PRECISION NOT NULL,
  top_contributors JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_open_fingerprint
  ON alerts (fingerprint)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_alerts_lookup
  ON alerts (app_key, status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rules_app_enabled
  ON rules (app_key, enabled);

CREATE TABLE IF NOT EXISTS ingest_dedup_keys (
  event_uid TEXT PRIMARY KEY,
  app_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingest_dedup_keys_app_created
  ON ingest_dedup_keys (app_key, created_at DESC);

CREATE TABLE IF NOT EXISTS keyword_extract_rules (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL REFERENCES apps(app_key) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100,
  regex_pattern TEXT NOT NULL,
  keyword_group_index INTEGER NOT NULL DEFAULT 1,
  match_type_group_index INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_keyword_extract_rules_unique
  ON keyword_extract_rules (app_key, priority, regex_pattern);

CREATE INDEX IF NOT EXISTS idx_keyword_extract_rules_lookup
  ON keyword_extract_rules (app_key, enabled, priority ASC);

CREATE TABLE IF NOT EXISTS keyword_lifecycle_states (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL REFERENCES apps(app_key) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  keyword TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'unknown',
  current_stage TEXT NOT NULL CHECK (
    current_stage IN ('new', 'learning', 'scaling', 'stable', 'declining', 'pause_candidate')
  ),
  stage_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  first_seen_date DATE NOT NULL,
  last_seen_date DATE NOT NULL,
  days_in_stage INTEGER NOT NULL DEFAULT 1,
  last_cpi DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_installs DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_clicks DOUBLE PRECISION NOT NULL DEFAULT 0,
  trend_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_key, platform, keyword, match_type)
);

ALTER TABLE keyword_lifecycle_states ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE keyword_lifecycle_states
  DROP CONSTRAINT IF EXISTS keyword_lifecycle_states_app_key_keyword_match_type_key;

CREATE INDEX IF NOT EXISTS idx_keyword_lifecycle_stage
  ON keyword_lifecycle_states (app_key, current_stage, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_keyword_lifecycle_platform_key
  ON keyword_lifecycle_states (app_key, platform, keyword, match_type);

CREATE TABLE IF NOT EXISTS budget_recommendations (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL REFERENCES apps(app_key) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  media_source TEXT NOT NULL DEFAULT 'unknown',
  keyword TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'unknown',
  date DATE NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('increase', 'decrease', 'hold', 'pause')),
  change_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
  suggested_budget DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_ecpi DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_ecpi DOUBLE PRECISION NOT NULL DEFAULT 0,
  primary_metric TEXT NOT NULL DEFAULT 'ecpi' CHECK (primary_metric IN ('ecpi', 'roas')),
  metric_mode TEXT NOT NULL DEFAULT 'active' CHECK (metric_mode IN ('active', 'roas_pending_revenue')),
  current_roas DOUBLE PRECISION,
  target_roas DOUBLE PRECISION,
  volume_tier TEXT NOT NULL DEFAULT 'low',
  expected_installs_delta DOUBLE PRECISION NOT NULL DEFAULT 0,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason_code TEXT NOT NULL DEFAULT 'unknown',
  llm_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_key, platform, media_source, keyword, match_type, date)
);

ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS media_source TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS current_ecpi DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS target_ecpi DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS primary_metric TEXT NOT NULL DEFAULT 'ecpi';
ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS metric_mode TEXT NOT NULL DEFAULT 'active';
ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS current_roas DOUBLE PRECISION;
ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS target_roas DOUBLE PRECISION;
ALTER TABLE budget_recommendations ADD COLUMN IF NOT EXISTS volume_tier TEXT NOT NULL DEFAULT 'low';
ALTER TABLE budget_recommendations
  DROP CONSTRAINT IF EXISTS budget_recommendations_app_key_keyword_match_type_date_key;
DROP INDEX IF EXISTS uq_budget_recommendations_platform_key;

CREATE INDEX IF NOT EXISTS idx_budget_recommendations_lookup
  ON budget_recommendations (app_key, status, date DESC, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_recommendations_platform_media_key
  ON budget_recommendations (app_key, platform, media_source, keyword, match_type, date);

CREATE TABLE IF NOT EXISTS llm_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  biz_type TEXT NOT NULL,
  biz_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_lookup
  ON llm_audit_logs (biz_type, biz_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_brief_dispatches (
  id BIGSERIAL PRIMARY KEY,
  report_date DATE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ops_daily',
  channel TEXT NOT NULL DEFAULT 'feishu',
  route_key TEXT NOT NULL DEFAULT 'all',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'failed' CHECK (status IN ('sent', 'failed')),
  manual_triggered BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_date, kind, channel, route_key)
);

ALTER TABLE daily_brief_dispatches ADD COLUMN IF NOT EXISTS route_key TEXT NOT NULL DEFAULT 'all';
ALTER TABLE daily_brief_dispatches
  DROP CONSTRAINT IF EXISTS daily_brief_dispatches_report_date_kind_channel_key;

CREATE INDEX IF NOT EXISTS idx_daily_brief_dispatches_lookup
  ON daily_brief_dispatches (report_date DESC, status, channel);

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_brief_dispatches_route
  ON daily_brief_dispatches (report_date, kind, channel, route_key);

CREATE TABLE IF NOT EXISTS daily_brief_routes (
  id BIGSERIAL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  route_name TEXT NOT NULL,
  media_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  app_key TEXT,
  platform TEXT,
  notify_feishu_app_id TEXT,
  notify_feishu_app_secret TEXT,
  notify_feishu_chat_id TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_brief_routes_lookup
  ON daily_brief_routes (enabled, priority ASC, route_name ASC);

CREATE TABLE IF NOT EXISTS operation_logs (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'info' CHECK (status IN ('success', 'failed', 'skipped', 'info')),
  summary TEXT NOT NULL DEFAULT '',
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_lookup
  ON operation_logs (created_at DESC, source, status);

CREATE TABLE IF NOT EXISTS bitable_export_configs (
  id BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL UNIQUE CHECK (source_type IN ('pull_daily', 'asa_raw')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  target_table_id TEXT,
  target_table_name TEXT,
  chat_id TEXT,
  selected_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle', 'success', 'failed')),
  last_error TEXT,
  last_synced_at TIMESTAMPTZ,
  last_record_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bitable_export_configs_lookup
  ON bitable_export_configs (enabled, source_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS pull_cycle_locks (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pull_cycle_locks_expires_at
  ON pull_cycle_locks (expires_at);

CREATE TABLE IF NOT EXISTS pull_content_guards (
  app_key TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  report_date DATE NOT NULL,
  source_report TEXT NOT NULL DEFAULT 'daily_report_v5',
  content_signature TEXT NOT NULL DEFAULT '',
  last_status TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_allowed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_key, platform, report_date, source_report)
);

CREATE INDEX IF NOT EXISTS idx_pull_content_guards_next_allowed
  ON pull_content_guards (next_allowed_at);

CREATE TABLE IF NOT EXISTS product_stage_configs (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL REFERENCES apps(app_key) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  stage TEXT NOT NULL CHECK (stage IN ('rising', 'stable')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_key, platform)
);

CREATE INDEX IF NOT EXISTS idx_product_stage_configs_lookup
  ON product_stage_configs (enabled, app_key, platform);

CREATE TABLE IF NOT EXISTS asa_keyword_states (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL REFERENCES apps(app_key) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  keyword TEXT NOT NULL,
  campaign TEXT NOT NULL DEFAULT 'unknown',
  adset TEXT NOT NULL DEFAULT 'unknown',
  current_stage TEXT NOT NULL CHECK (current_stage IN ('rising', 'stable')),
  stage_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  first_seen_date DATE NOT NULL,
  last_seen_date DATE NOT NULL,
  current_ecpi DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_cpp DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_d7_roas DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_ecpi DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_cpp DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_d7_roas DOUBLE PRECISION NOT NULL DEFAULT 0,
  installs_7d DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_cost_7d DOUBLE PRECISION NOT NULL DEFAULT 0,
  purchase_count_7d DOUBLE PRECISION NOT NULL DEFAULT 0,
  revenue_d7_7d DOUBLE PRECISION NOT NULL DEFAULT 0,
  trend_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE asa_keyword_states
  ADD COLUMN IF NOT EXISTS adset TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE asa_keyword_states
  DROP CONSTRAINT IF EXISTS asa_keyword_states_app_key_platform_keyword_campaign_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_asa_keyword_states_scope
  ON asa_keyword_states (app_key, platform, keyword, campaign, adset);

CREATE INDEX IF NOT EXISTS idx_asa_keyword_states_lookup
  ON asa_keyword_states (app_key, platform, current_stage, updated_at DESC);

CREATE TABLE IF NOT EXISTS asa_keyword_recommendations (
  id BIGSERIAL PRIMARY KEY,
  app_key TEXT NOT NULL REFERENCES apps(app_key) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  keyword TEXT NOT NULL,
  campaign TEXT NOT NULL DEFAULT 'unknown',
  adset TEXT NOT NULL DEFAULT 'unknown',
  date DATE NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('increase', 'decrease', 'hold', 'pause')),
  change_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
  primary_metric TEXT NOT NULL CHECK (primary_metric IN ('ecpi', 'd7_roas_cpp')),
  current_ecpi DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_cpp DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_d7_roas DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_ecpi DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_cpp DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_d7_roas DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason_code TEXT NOT NULL DEFAULT 'unknown',
  llm_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'applied', 'rejected', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE asa_keyword_recommendations
  ADD COLUMN IF NOT EXISTS adset TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE asa_keyword_recommendations
  DROP CONSTRAINT IF EXISTS asa_keyword_recommendations_app_key_platform_keyword_campaign_date_key;

ALTER TABLE asa_keyword_recommendations
  DROP CONSTRAINT IF EXISTS asa_keyword_recommendations_app_key_platform_keyword_campai_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_asa_keyword_recommendations_scope
  ON asa_keyword_recommendations (app_key, platform, keyword, campaign, adset, date);

CREATE INDEX IF NOT EXISTS idx_asa_keyword_recommendations_lookup
  ON asa_keyword_recommendations (app_key, platform, status, date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS asa_keyword_routes (
  id BIGSERIAL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  route_name TEXT NOT NULL,
  app_key TEXT,
  platform TEXT,
  notify_feishu_app_id TEXT,
  notify_feishu_app_secret TEXT,
  notify_feishu_chat_id TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asa_keyword_routes_lookup
  ON asa_keyword_routes (enabled, priority ASC, route_name ASC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apps_updated_at ON apps;
CREATE TRIGGER trg_apps_updated_at
BEFORE UPDATE ON apps
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_rules_updated_at ON rules;
CREATE TRIGGER trg_rules_updated_at
BEFORE UPDATE ON rules
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_alerts_updated_at ON alerts;
CREATE TRIGGER trg_alerts_updated_at
BEFORE UPDATE ON alerts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_keyword_extract_rules_updated_at ON keyword_extract_rules;
CREATE TRIGGER trg_keyword_extract_rules_updated_at
BEFORE UPDATE ON keyword_extract_rules
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_keyword_lifecycle_states_updated_at ON keyword_lifecycle_states;
CREATE TRIGGER trg_keyword_lifecycle_states_updated_at
BEFORE UPDATE ON keyword_lifecycle_states
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_budget_recommendations_updated_at ON budget_recommendations;
CREATE TRIGGER trg_budget_recommendations_updated_at
BEFORE UPDATE ON budget_recommendations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_daily_brief_dispatches_updated_at ON daily_brief_dispatches;
CREATE TRIGGER trg_daily_brief_dispatches_updated_at
BEFORE UPDATE ON daily_brief_dispatches
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_daily_brief_routes_updated_at ON daily_brief_routes;
CREATE TRIGGER trg_daily_brief_routes_updated_at
BEFORE UPDATE ON daily_brief_routes
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_pull_cycle_locks_updated_at ON pull_cycle_locks;
CREATE TRIGGER trg_pull_cycle_locks_updated_at
BEFORE UPDATE ON pull_cycle_locks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_bitable_export_configs_updated_at ON bitable_export_configs;
CREATE TRIGGER trg_bitable_export_configs_updated_at
BEFORE UPDATE ON bitable_export_configs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_pull_content_guards_updated_at ON pull_content_guards;
CREATE TRIGGER trg_pull_content_guards_updated_at
BEFORE UPDATE ON pull_content_guards
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_product_stage_configs_updated_at ON product_stage_configs;
CREATE TRIGGER trg_product_stage_configs_updated_at
BEFORE UPDATE ON product_stage_configs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_asa_keyword_states_updated_at ON asa_keyword_states;
CREATE TRIGGER trg_asa_keyword_states_updated_at
BEFORE UPDATE ON asa_keyword_states
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_asa_keyword_recommendations_updated_at ON asa_keyword_recommendations;
CREATE TRIGGER trg_asa_keyword_recommendations_updated_at
BEFORE UPDATE ON asa_keyword_recommendations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_asa_keyword_routes_updated_at ON asa_keyword_routes;
CREATE TRIGGER trg_asa_keyword_routes_updated_at
BEFORE UPDATE ON asa_keyword_routes
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

INSERT INTO apps (
  app_key,
  display_name,
  ios_display_name,
  android_display_name,
  pull_app_id,
  ios_pull_app_id,
  android_pull_app_id,
  dataset,
  push_auth_token,
  timezone,
  notify_webhook_url,
  notify_feishu_app_id,
  notify_feishu_app_secret,
  notify_feishu_chat_id
)
VALUES
  ('ai-video-plus', 'AI Video Plus', 'AI Video Plus iOS', 'AI Video Plus Android', 'id6746191879', 'id6746191879', '', 'ods_events_device_detail', 'replace-with-generated-token-1', 'Asia/Shanghai', NULL, NULL, NULL, NULL),
  ('ai-screen-time-coach', 'Zensi', 'Zensi iOS', 'Zensi Android', 'id6756569023', 'id6756569023', '', 'ods_events_device_detail', 'replace-with-generated-token-2', 'Asia/Shanghai', NULL, NULL, NULL, NULL),
  ('ai-seek', 'Novix AI', 'Novix AI iOS', 'AI Seek Android', 'id6752638454', 'id6752638454', '', 'ods_events_device_detail', 'replace-with-generated-token-3', 'Asia/Shanghai', NULL, NULL, NULL, NULL)
ON CONFLICT (app_key) DO UPDATE
SET pull_app_id = EXCLUDED.pull_app_id,
    ios_pull_app_id = CASE
      WHEN NULLIF(EXCLUDED.ios_pull_app_id, '') IS NULL THEN apps.ios_pull_app_id
      ELSE EXCLUDED.ios_pull_app_id
    END,
    android_pull_app_id = CASE
      WHEN NULLIF(EXCLUDED.android_pull_app_id, '') IS NULL THEN apps.android_pull_app_id
      ELSE EXCLUDED.android_pull_app_id
    END,
    display_name = CASE
      WHEN NULLIF(EXCLUDED.display_name, '') IS NULL THEN apps.display_name
      ELSE EXCLUDED.display_name
    END,
    ios_display_name = CASE
      WHEN NULLIF(EXCLUDED.ios_display_name, '') IS NULL THEN apps.ios_display_name
      ELSE EXCLUDED.ios_display_name
    END,
    android_display_name = CASE
      WHEN NULLIF(EXCLUDED.android_display_name, '') IS NULL THEN apps.android_display_name
      ELSE EXCLUDED.android_display_name
    END,
    dataset = EXCLUDED.dataset,
    timezone = EXCLUDED.timezone;

INSERT INTO rules (app_key, name, enabled, rule_json)
VALUES
(
  'ai-video-plus',
  'default-hotspot-rule',
  TRUE,
  '{
    "timezone": "Asia/Shanghai",
    "silence_minutes": 30,
    "metrics": [
      {
        "metric": "revenue",
        "granularity": "hour",
        "window": "last_1h",
        "baseline": "avg_7d_same_hour",
        "up_ratio": 2.0,
        "down_ratio": 0.5,
        "min_abs_delta": 50,
        "severity": {"spike": "P1", "drop": "P0"},
        "drilldown_dims": ["media_source", "country", "campaign", "attribution", "event_type"]
      }
    ]
  }'::jsonb
),
(
  'ai-screen-time-coach',
  'default-hotspot-rule',
  TRUE,
  '{
    "timezone": "Asia/Shanghai",
    "silence_minutes": 30,
    "metrics": [
      {
        "metric": "revenue",
        "granularity": "hour",
        "window": "last_1h",
        "baseline": "avg_7d_same_hour",
        "up_ratio": 2.0,
        "down_ratio": 0.5,
        "min_abs_delta": 50,
        "severity": {"spike": "P1", "drop": "P0"},
        "drilldown_dims": ["media_source", "country", "campaign", "attribution", "event_type"]
      }
    ]
  }'::jsonb
),
(
  'ai-seek',
  'default-hotspot-rule',
  TRUE,
  '{
    "timezone": "Asia/Shanghai",
    "silence_minutes": 30,
    "metrics": [
      {
        "metric": "revenue",
        "granularity": "hour",
        "window": "last_1h",
        "baseline": "avg_7d_same_hour",
        "up_ratio": 2.0,
        "down_ratio": 0.5,
        "min_abs_delta": 50,
        "severity": {"spike": "P1", "drop": "P0"},
        "drilldown_dims": ["media_source", "country", "campaign", "attribution", "event_type"]
      },
      {
        "metric": "event_count",
        "event_name": "purchase",
        "granularity": "hour",
        "window": "last_2h",
        "baseline": "median_14d_same_hour",
        "up_ratio": 2.5,
        "down_ratio": 0.4,
        "min_abs_delta": 20,
        "severity": {"spike": "P1", "drop": "P1"},
        "drilldown_dims": ["media_source", "country", "campaign"]
      }
    ]
  }'::jsonb
)
ON CONFLICT (app_key, name) DO NOTHING;

INSERT INTO keyword_extract_rules (
  app_key,
  priority,
  regex_pattern,
  keyword_group_index,
  match_type_group_index,
  enabled
)
SELECT
  app_key,
  100,
  '^([^_]+(?:_[^_]+){0,2})_(exact|phrase|broad).*$',
  1,
  2,
  TRUE
FROM apps
ON CONFLICT (app_key, priority, regex_pattern) DO NOTHING;
