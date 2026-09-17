CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('fixture', 'captured')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  action_count INTEGER NOT NULL,
  trace TEXT NOT NULL CHECK (length(trace) <= 65536)
);
CREATE INDEX reports_owner_created ON reports(owner_id, created_at DESC);
CREATE INDEX reports_expiry ON reports(expires_at);
-- Counter changes atomically with each row, including deletion and expiry.
CREATE TABLE capacity (id INTEGER PRIMARY KEY CHECK (id = 1), report_count INTEGER NOT NULL);
INSERT INTO capacity (id, report_count) VALUES (1, 0);
CREATE TRIGGER reports_insert_count AFTER INSERT ON reports BEGIN
  UPDATE capacity SET report_count = report_count + 1 WHERE id = 1;
END;
CREATE TRIGGER reports_delete_count AFTER DELETE ON reports BEGIN
  UPDATE capacity SET report_count = report_count - 1 WHERE id = 1;
END;
