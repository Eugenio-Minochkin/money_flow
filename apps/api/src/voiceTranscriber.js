const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen?model=nova-3-general&language=multi&smart_format=true";

export class VoiceMessageTooLongError extends Error {
  constructor() { super("voice_message_too_long"); this.code = "voice_message_too_long"; }
}

export function createVoiceTranscriber(options = {}) {
  const telegramBotToken = options.telegramBotToken;
  const deepgramApiKey = options.deepgramApiKey;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAudioDurationSec = options.maxAudioDurationSec ?? 60;
  const consumeVoiceUsage = options.consumeVoiceUsage ?? null;
  const enabled = options.enabled !== false;

  return {
    isEnabled() {
      return enabled;
    },

    isConfigured() {
      return Boolean(telegramBotToken && deepgramApiKey && fetchImpl && enabled);
    },

    async transcribeTelegramVoice(voice, options = {}) {
      if (!this.isConfigured()) {
        throw new Error("Voice transcription is not configured");
      }
      if (Number(voice?.duration) > maxAudioDurationSec) throw new VoiceMessageTooLongError();

      const onPerfStage = options.onPerfStage ?? (() => {});
      onPerfStage("telegram_file_download_start", voiceMetadata(voice));
      const file = await getTelegramFile({ telegramBotToken, fileId: voice.file_id, fetchImpl });
      const audio = await downloadTelegramFile({ telegramBotToken, filePath: file.filePath, fetchImpl });
      onPerfStage("telegram_file_download_end", {
        ...voiceMetadata(voice),
        fileSizeKb: bytesToKb(file.fileSizeBytes)
      });

      onPerfStage("transcription_start", {
        ...voiceMetadata(voice),
        transcriptionProvider: "deepgram"
      });
      await consumeVoiceUsage?.({
        userId: options.userId,
        audioDurationSec: Number(voice?.duration) || 0,
        requestKey: options.requestKey ?? null
      });
      return transcribeWithDeepgram({
        deepgramApiKey,
        audio,
        mimeType: voice.mime_type ?? contentTypeForPath(file.filePath),
        fetchImpl
      }).then((transcript) => {
        onPerfStage("transcription_end", {
          ...voiceMetadata(voice),
          transcriptionProvider: "deepgram",
          responseChars: transcript.length
        });
        return transcript;
      });
    }
  };
}

async function getTelegramFile({ telegramBotToken, fileId, fetchImpl }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${telegramBotToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const body = await response.json();
  if (!response.ok || !body.ok || !body.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${response.status}`);
  }
  return {
    filePath: body.result.file_path,
    fileSizeBytes: body.result.file_size
  };
}

async function downloadTelegramFile({ telegramBotToken, filePath, fetchImpl }) {
  const response = await fetchImpl(`https://api.telegram.org/file/bot${telegramBotToken}/${filePath}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status} ${await response.text()}`);
  }
  return response.arrayBuffer();
}

async function transcribeWithDeepgram({ deepgramApiKey, audio, mimeType, fetchImpl }) {
  const response = await fetchImpl(DEEPGRAM_LISTEN_URL, {
    method: "POST",
    headers: {
      "authorization": `Token ${deepgramApiKey}`,
      "content-type": normalizeMimeType(mimeType)
    },
    body: Buffer.from(await audio)
  });

  if (!response.ok) {
    throw new Error(`Deepgram transcription failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const transcript = body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (!transcript) throw new Error("Deepgram response did not include transcript");
  return transcript;
}

function normalizeMimeType(mimeType) {
  if (mimeType === "audio/oga") return "audio/ogg";
  return mimeType || "application/octet-stream";
}

function contentTypeForPath(filePath) {
  if (filePath.endsWith(".oga") || filePath.endsWith(".ogg")) return "audio/ogg";
  if (filePath.endsWith(".mp3")) return "audio/mpeg";
  if (filePath.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

function voiceMetadata(voice) {
  return {
    audioDurationSec: voice?.duration
  };
}

function bytesToKb(bytes) {
  const value = Number(bytes);
  return Number.isFinite(value) ? Math.round(value / 1024) : undefined;
}
