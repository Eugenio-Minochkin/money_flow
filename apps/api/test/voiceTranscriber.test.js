import test from "node:test";
import assert from "node:assert/strict";

import { createVoiceTranscriber } from "../src/voiceTranscriber.js";

test("downloads a Telegram voice file and transcribes it with Deepgram", async () => {
  const calls = [];
  const transcriber = createVoiceTranscriber({
    telegramBotToken: "telegram-token",
    deepgramApiKey: "deepgram-key",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });

      if (String(url).includes("/getFile")) {
        return jsonResponse({
          ok: true,
          result: { file_path: "voice/file_1.oga" }
        });
      }

      if (String(url).includes("/file/bottelegram-token/voice/file_1.oga")) {
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return new Uint8Array([1, 2, 3]).buffer;
          },
          async text() {
            return "";
          }
        };
      }

      assert.equal(String(url), "https://api.deepgram.com/v1/listen?model=nova-3-general&language=multi&smart_format=true");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Token deepgram-key");
      assert.equal(options.headers["content-type"], "audio/ogg");
      return jsonResponse({
        results: {
          channels: [
            {
              alternatives: [{ transcript: "кофе 70 бат" }]
            }
          ]
        }
      });
    }
  });

  const transcript = await transcriber.transcribeTelegramVoice({ file_id: "file-id-1", mime_type: "audio/ogg" });

  assert.equal(transcript, "кофе 70 бат");
  assert.equal(calls.length, 3);
});

test("reports voice download and transcription performance metadata", async () => {
  const perfEvents = [];
  const transcriber = createVoiceTranscriber({
    telegramBotToken: "telegram-token",
    deepgramApiKey: "deepgram-key",
    fetchImpl: async (url) => {
      if (String(url).includes("/getFile")) {
        return jsonResponse({
          ok: true,
          result: { file_path: "voice/file_1.oga", file_size: 4096 }
        });
      }

      if (String(url).includes("/file/bottelegram-token/voice/file_1.oga")) {
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return new Uint8Array([1, 2, 3, 4]).buffer;
          },
          async text() {
            return "";
          }
        };
      }

      return jsonResponse({
        results: {
          channels: [
            {
              alternatives: [{ transcript: "coffee 70 baht" }]
            }
          ]
        }
      });
    }
  });

  const transcript = await transcriber.transcribeTelegramVoice(
    { file_id: "file-id-1", mime_type: "audio/ogg", duration: 7 },
    { onPerfStage: (stage, metadata) => perfEvents.push({ stage, metadata }) }
  );

  assert.equal(transcript, "coffee 70 baht");
  assert.deepEqual(perfEvents.map((event) => event.stage), [
    "telegram_file_download_start",
    "telegram_file_download_end",
    "transcription_start",
    "transcription_end"
  ]);
  assert.equal(perfEvents[1].metadata.fileSizeKb, 4);
  assert.equal(perfEvents[1].metadata.audioDurationSec, 7);
  assert.equal(perfEvents[3].metadata.transcriptionProvider, "deepgram");
});

test("reports unconfigured voice transcription", () => {
  const transcriber = createVoiceTranscriber({});

  assert.equal(transcriber.isConfigured(), false);
});

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}
