ALTER TABLE paid_provider_usage_windows
  DROP CONSTRAINT IF EXISTS paid_provider_usage_windows_provider_check;

ALTER TABLE paid_provider_usage_windows
  ADD CONSTRAINT paid_provider_usage_windows_provider_check
  CHECK (provider IN ('openai_parser', 'openai_image_analysis', 'deepgram_transcription'));

ALTER TABLE paid_provider_usage_reservations
  DROP CONSTRAINT IF EXISTS paid_provider_usage_reservations_provider_check;

ALTER TABLE paid_provider_usage_reservations
  ADD CONSTRAINT paid_provider_usage_reservations_provider_check
  CHECK (provider IN ('openai_parser', 'openai_image_analysis', 'deepgram_transcription'));
