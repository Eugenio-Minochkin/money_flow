const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen?model=nova-3-general&language=multi&smart_format=true";

export function createVoiceTranscriber(options = {}) {
  const telegramBotToken = options.telegramBotToken;
  const deepgramApiKey = options.deepgramApiKey;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    isConfigured() {
      return Boolean(telegramBotToken && deepgramApiKey && fetchImpl);
    },

    async transcribeTelegramVoice(voice) {
      if (!this.isConfigured()) {
        throw new Error("Voice transcription is not configured");
      }

      const filePath = await getTelegramFilePath({ telegramBotToken, fileId: voice.file_id, fetchImpl });
      const audio = await downloadTelegramFile({ telegramBotToken, filePath, fetchImpl });
      return transcribeWithDeepgram({
        deepgramApiKey,
        audio,
        mimeType: voice.mime_type ?? contentTypeForPath(filePath),
        fetchImpl
      });
    }
  };
}

async function getTelegramFilePath({ telegramBotToken, fileId, fetchImpl }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${telegramBotToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const body = await response.json();
  if (!response.ok || !body.ok || !body.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${response.status}`);
  }
  return body.result.file_path;
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
