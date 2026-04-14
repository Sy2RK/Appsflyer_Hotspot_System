CREATE DATABASE IF NOT EXISTS hotspot;

CREATE TABLE IF NOT EXISTS hotspot.raw_events (
  event_date Date,
  event_time DateTime,
  install_time DateTime,
  ingest_time DateTime,
  app_key String,
  dataset String,
  event_name String,
  event_type Enum8('unknown' = 0, 'ua' = 1, 'retargeting' = 2),
  attribution Enum8('unknown' = 0, 'organic' = 1, 'non_organic' = 2),
  media_source LowCardinality(String),
  campaign LowCardinality(String),
  adset LowCardinality(String),
  ad LowCardinality(String),
  country LowCardinality(String),
  platform LowCardinality(String),
  af_id String,
  device_id String,
  revenue Float64,
  currency LowCardinality(String),
  event_value_json String,
  event_uid FixedString(32),
  raw_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (app_key, event_date, event_name, media_source, country, campaign, event_time, event_uid);

CREATE TABLE IF NOT EXISTS hotspot.metrics_hourly (
  hour DateTime,
  app_key String,
  metric LowCardinality(String),
  value Float64,
  event_name LowCardinality(String),
  platform LowCardinality(String),
  attribution Enum8('unknown' = 0, 'organic' = 1, 'non_organic' = 2),
  event_type Enum8('unknown' = 0, 'ua' = 1, 'retargeting' = 2),
  media_source LowCardinality(String),
  country LowCardinality(String),
  campaign LowCardinality(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(hour)
ORDER BY (app_key, platform, hour, metric, event_name, attribution, event_type, media_source, country, campaign);

ALTER TABLE hotspot.metrics_hourly ADD COLUMN IF NOT EXISTS platform LowCardinality(String);
ALTER TABLE hotspot.raw_events ADD COLUMN IF NOT EXISTS install_time DateTime DEFAULT event_time;

CREATE TABLE IF NOT EXISTS hotspot.pull_aggregate_daily (
  date Date,
  app_key String,
  platform LowCardinality(String),
  media_source LowCardinality(String),
  country LowCardinality(String),
  campaign LowCardinality(String),
  agency_pmd String,
  impressions Float64,
  clicks Float64,
  ctr Float64,
  installs Float64,
  conversion_rate Float64,
  sessions Float64,
  loyal_users Float64,
  loyal_users_installs_ratio Float64,
  total_cost Float64,
  average_ecpi Float64,
  source_report LowCardinality(String),
  pull_window_from Date,
  pull_window_to Date,
  revenue Float64,
  events Float64,
  raw_json String,
  ingest_time DateTime
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (app_key, platform, date, media_source, country, campaign);

ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS agency_pmd String;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS impressions Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS clicks Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS ctr Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS conversion_rate Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS sessions Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS loyal_users Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS loyal_users_installs_ratio Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS total_cost Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS average_ecpi Float64;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS source_report LowCardinality(String);
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS pull_window_from Date;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS pull_window_to Date;
ALTER TABLE hotspot.pull_aggregate_daily ADD COLUMN IF NOT EXISTS platform LowCardinality(String);

CREATE TABLE IF NOT EXISTS hotspot.metrics_daily (
  date Date,
  app_key String,
  metric LowCardinality(String),
  value Float64,
  platform LowCardinality(String),
  media_source LowCardinality(String),
  campaign LowCardinality(String),
  country LowCardinality(String),
  source LowCardinality(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(date)
ORDER BY (app_key, platform, date, metric, media_source, campaign, country, source);

ALTER TABLE hotspot.metrics_daily ADD COLUMN IF NOT EXISTS platform LowCardinality(String);

CREATE TABLE IF NOT EXISTS hotspot.keyword_daily_metrics (
  date Date,
  app_key String,
  platform LowCardinality(String),
  keyword String,
  match_type LowCardinality(String),
  campaign LowCardinality(String),
  media_source LowCardinality(String),
  country LowCardinality(String),
  installs Float64,
  clicks Float64,
  total_cost Float64,
  cpi Float64,
  af_average_ecpi Float64,
  cvr Float64,
  source_report LowCardinality(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(date)
ORDER BY (app_key, platform, date, keyword, match_type, campaign, media_source, country);

ALTER TABLE hotspot.keyword_daily_metrics ADD COLUMN IF NOT EXISTS platform LowCardinality(String);
ALTER TABLE hotspot.keyword_daily_metrics ADD COLUMN IF NOT EXISTS af_average_ecpi Float64;

CREATE TABLE IF NOT EXISTS hotspot.keyword_value_daily_metrics (
  install_date Date,
  app_key String,
  platform LowCardinality(String),
  media_source LowCardinality(String),
  country LowCardinality(String),
  campaign LowCardinality(String),
  keyword String,
  match_type LowCardinality(String),
  installs Float64,
  total_cost Float64,
  purchase_count Float64,
  revenue_d7 Float64,
  revenue_source_missing UInt8 DEFAULT 0,
  ctr Float64,
  cvr Float64,
  cpi Float64,
  cpp Float64,
  d7_roas Float64,
  af_cohort_roas Float64 DEFAULT 0,
  af_cohort_roas_missing UInt8 DEFAULT 1,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(install_date)
ORDER BY (app_key, platform, install_date, media_source, country, campaign, keyword, match_type);

ALTER TABLE hotspot.keyword_value_daily_metrics ADD COLUMN IF NOT EXISTS revenue_source_missing UInt8 DEFAULT 0;
ALTER TABLE hotspot.keyword_value_daily_metrics ADD COLUMN IF NOT EXISTS af_cohort_roas Float64 DEFAULT 0;
ALTER TABLE hotspot.keyword_value_daily_metrics ADD COLUMN IF NOT EXISTS af_cohort_roas_missing UInt8 DEFAULT 1;

CREATE TABLE IF NOT EXISTS hotspot.asa_raw_installs (
  install_date Date,
  install_time DateTime,
  ingest_time DateTime,
  app_key String,
  platform LowCardinality(String),
  keyword String,
  campaign LowCardinality(String),
  adset LowCardinality(String),
  country LowCardinality(String),
  cost_value Float64,
  currency LowCardinality(String),
  snapshot_id UInt64 DEFAULT 0,
  event_uid FixedString(32),
  raw_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(install_date)
ORDER BY (app_key, platform, install_date, keyword, campaign, country, install_time, event_uid);

CREATE TABLE IF NOT EXISTS hotspot.asa_raw_in_app_events (
  install_date Date,
  install_time DateTime,
  event_time DateTime,
  ingest_time DateTime,
  app_key String,
  platform LowCardinality(String),
  keyword String,
  campaign LowCardinality(String),
  adset LowCardinality(String),
  country LowCardinality(String),
  event_name LowCardinality(String),
  event_revenue_usd Float64,
  cost_value Float64,
  currency LowCardinality(String),
  snapshot_id UInt64 DEFAULT 0,
  event_uid FixedString(32),
  raw_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(install_date)
ORDER BY (app_key, platform, install_date, keyword, campaign, country, event_time, event_uid);

CREATE TABLE IF NOT EXISTS hotspot.asa_keyword_daily_metrics (
  date Date,
  app_key String,
  platform LowCardinality(String),
  keyword String,
  campaign LowCardinality(String),
  country LowCardinality(String),
  installs Float64,
  total_cost Float64,
  purchase_count Float64,
  revenue_d0 Float64,
  revenue_d7 Float64,
  ecpi Float64,
  cpp Float64,
  d7_roas Float64,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(date)
ORDER BY (app_key, platform, date, keyword, campaign, country);

CREATE TABLE IF NOT EXISTS hotspot.asa_keyword_daily_metrics_v2 (
  date Date,
  app_key String,
  platform LowCardinality(String),
  keyword String,
  campaign LowCardinality(String),
  adset LowCardinality(String),
  installs Float64,
  total_cost Float64,
  purchase_count Float64,
  revenue_d0 Float64,
  revenue_d7 Float64,
  ecpi Float64,
  average_ecpi Float64,
  cpp Float64,
  d7_roas Float64,
  af_cohort_roas Float64 DEFAULT 0,
  af_cohort_roas_missing UInt8 DEFAULT 1,
  roas_source_missing UInt8 DEFAULT 0,
  snapshot_id UInt64 DEFAULT 0,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(date)
ORDER BY (app_key, platform, date, keyword, campaign, adset);

CREATE TABLE IF NOT EXISTS hotspot.asa_keyword_country_daily_metrics (
  date Date,
  app_key String,
  platform LowCardinality(String),
  country LowCardinality(String),
  keyword String,
  campaign LowCardinality(String),
  adset LowCardinality(String),
  installs Float64,
  total_cost Float64,
  ecpi Float64,
  snapshot_id UInt64 DEFAULT 0,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(date)
ORDER BY (app_key, platform, date, country, keyword, campaign, adset);

CREATE TABLE IF NOT EXISTS hotspot.asa_slice_snapshots (
  app_key String,
  platform LowCardinality(String),
  date Date,
  snapshot_id UInt64,
  status LowCardinality(String),
  created_at DateTime
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (app_key, platform, date, snapshot_id);

ALTER TABLE hotspot.asa_raw_installs ADD COLUMN IF NOT EXISTS snapshot_id UInt64 DEFAULT 0;
ALTER TABLE hotspot.asa_raw_in_app_events ADD COLUMN IF NOT EXISTS snapshot_id UInt64 DEFAULT 0;
ALTER TABLE hotspot.asa_keyword_daily_metrics_v2 ADD COLUMN IF NOT EXISTS snapshot_id UInt64 DEFAULT 0;
ALTER TABLE hotspot.asa_keyword_daily_metrics_v2 ADD COLUMN IF NOT EXISTS af_cohort_roas Float64 DEFAULT 0;
ALTER TABLE hotspot.asa_keyword_daily_metrics_v2 ADD COLUMN IF NOT EXISTS af_cohort_roas_missing UInt8 DEFAULT 1;
ALTER TABLE hotspot.asa_keyword_daily_metrics_v2 ADD COLUMN IF NOT EXISTS roas_source_missing UInt8 DEFAULT 0;
ALTER TABLE hotspot.asa_keyword_country_daily_metrics ADD COLUMN IF NOT EXISTS snapshot_id UInt64 DEFAULT 0;
