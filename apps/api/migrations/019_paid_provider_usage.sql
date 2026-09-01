CREATE TABLE IF NOT EXISTS paid_provider_usage_windows (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai_parser', 'deepgram_transcription')),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  audio_seconds INTEGER NOT NULL DEFAULT 0 CHECK (audio_seconds >= 0),
  PRIMARY KEY (user_id, provider)
);
