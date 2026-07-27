CREATE TABLE IF NOT EXISTS radar_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor INTEGER NOT NULL DEFAULT 0,
  total_universe INTEGER NOT NULL DEFAULT 0,
  scanned_this_round INTEGER NOT NULL DEFAULT 0,
  scan_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS radar_events (
  event_key TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  value REAL,
  direction TEXT NOT NULL DEFAULT 'neutral',
  event_time TEXT NOT NULL,
  event_ts INTEGER NOT NULL,
  support REAL,
  resistance REAL,
  ema50 REAL,
  ema200 REAL,
  event_price REAL
);

CREATE INDEX IF NOT EXISTS idx_radar_events_ts ON radar_events(event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_radar_events_symbol ON radar_events(symbol, exchange);
INSERT OR IGNORE INTO radar_state (id) VALUES (1);
