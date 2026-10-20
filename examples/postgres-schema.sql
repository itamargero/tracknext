-- Optional storage only. Apply through your application's normal migration tool.
CREATE TABLE IF NOT EXISTS tracknext_attribution (
  visitor_id UUID PRIMARY KEY,
  state JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS tracknext_attribution_expiry
  ON tracknext_attribution (expires_at);

-- Schedule cleanup in your application: the library never creates background jobs.
-- DELETE FROM tracknext_attribution WHERE expires_at <= NOW();
