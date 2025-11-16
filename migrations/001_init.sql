-- Cloudflare D1 schema for Social Voice Micro Browser
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_cache (
  feed_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  response_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_usage_lookup
  ON api_usage (provider, endpoint, timestamp);
