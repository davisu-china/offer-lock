"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiveTranslateSession = exports.LIVE_TRANSLATE_MODEL = void 0;
const ws_1 = __importDefault(require("ws"));
const uuid_1 = require("uuid");
exports.LIVE_TRANSLATE_MODEL = "qwen3.5-livetranslate-flash-realtime";
const DASH_SCOPE_REALTIME_URL =
  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
class LiveTranslateSession {
  constructor(options) {
    this.ws = null;
    this.closed = false;
    this.chunksSent = 0;
    this.bytesSent = 0;
    this.options = options;
    this.sessionId = (0, uuid_1.v4)();
    console.log("[livetranslate] create session", this.sessionId);
  }
  getSessionId() {
    return this.sessionId;
  }
  async start() {
    if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
      return this.sessionId;
    }
    console.log("[livetranslate] start requested", {
      sessionId: this.sessionId,
      model: this.model,
      sampleRate: this.sampleRate,
      sourceLanguage: this.normalizedSourceLanguage,
      targetLanguage: this.targetLanguage,
      enableSourceTranscription:
        this.options.enableSourceTranscription ?? false,
    });
    await this.connect();
    this.sendSessionUpdate();
    return this.sessionId;
  }
  async sendAudioChunk(buffer) {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
      throw new Error("session_not_ready");
    }
    if (!buffer || buffer.length === 0) return;
    const payload = {
      event_id: `event_${(0, uuid_1.v4)()}`,
      type: "input_audio_buffer.append",
      audio: Buffer.from(buffer).toString("base64"),
    };
    this.chunksSent += 1;
    this.bytesSent += buffer.length;
    if (this.chunksSent <= 3 || this.chunksSent % 100 === 0) {
      console.log("[livetranslate] send audio chunk", {
        sessionId: this.sessionId,
        chunksSent: this.chunksSent,
        bytesSent: this.bytesSent,
        chunkBytes: buffer.length,
      });
    }
    this.ws.send(JSON.stringify(payload));
  }
  async finishTask() {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) return;
    const payload = {
      event_id: `event_${(0, uuid_1.v4)()}`,
      type: "session.finish",
    };
    console.log("[livetranslate] send session.finish", this.sessionId);
    this.ws.send(JSON.stringify(payload));
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.finishTask().catch(() => {});
    } catch (err) {
      console.warn("[livetranslate] finish before close failed", err);
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on("error", () => {});
        if (
          this.ws.readyState === ws_1.default.OPEN ||
          this.ws.readyState === ws_1.default.CONNECTING
        ) {
          this.ws.close();
        }
      } catch (err) {
        console.warn("[livetranslate] error closing websocket", err);
      }
    }
    this.ws = null;
  }
  get model() {
    return this.options.model || exports.LIVE_TRANSLATE_MODEL;
  }
  get sampleRate() {
    return this.options.sampleRate ?? 16000;
  }
  get targetLanguage() {
    return this.options.targetLanguage || "zh";
  }
  get normalizedSourceLanguage() {
    const language = (this.options.sourceLanguage || "").trim();
    return language && language !== "auto" ? language : undefined;
  }
  async connect() {
    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${this.options.apiKey}`,
        "X-DashScope-DataInspection": "enable",
      };
      const url = `${DASH_SCOPE_REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
      console.log("[livetranslate] connecting", {
        sessionId: this.sessionId,
        url,
      });
      const ws = new ws_1.default(url, { headers });
      this.ws = ws;
      ws.on("open", () => {
        console.log("[livetranslate] websocket open", this.sessionId);
        resolve();
      });
      ws.on("message", (data) => {
        this.handleMessage(data);
      });
      ws.on("error", (err) => {
        console.error("[livetranslate] websocket error", this.sessionId, err);
        this.emit("error", err);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("close", (code, reason) => {
        console.warn(
          "[livetranslate] websocket closed",
          this.sessionId,
          code,
          reason.toString(),
        );
        this.emit("closed", { code, reason: reason.toString() });
        this.ws = null;
      });
    });
  }
  sendSessionUpdate() {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) return;
    const session = {
      modalities: ["text"],
      sample_rate: this.sampleRate,
      input_audio_format: "pcm",
      translation: {
        language: this.targetLanguage,
      },
    };
    const sourceLanguage = this.normalizedSourceLanguage;
    if (this.options.enableSourceTranscription) {
      session.input_audio_transcription = {
        model: "qwen3-asr-flash-realtime",
        ...(sourceLanguage ? { language: sourceLanguage } : {}),
      };
    }
    const payload = {
      event_id: `event_${(0, uuid_1.v4)()}`,
      type: "session.update",
      session,
    };
    console.log("[livetranslate] send session.update", {
      sessionId: this.sessionId,
      session,
    });
    this.ws.send(JSON.stringify(payload));
  }
  handleMessage(raw) {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error("[livetranslate] failed to parse message", error);
      this.emit("parse-error", text);
      return;
    }
    const event = parsed?.type || "unknown";
    if (
      event === "session.created" ||
      event === "session.updated" ||
      event === "response.text.text" ||
      event === "response.text.done" ||
      event === "conversation.item.input_audio_transcription.completed" ||
      event === "session.finished" ||
      event === "error"
    ) {
      console.log("[livetranslate] recv event", {
        sessionId: this.sessionId,
        event,
        responseId: parsed?.response_id,
        itemId: parsed?.item_id,
        textLength:
          typeof parsed?.text === "string" ? parsed.text.length : undefined,
        transcriptLength:
          typeof parsed?.transcript === "string"
            ? parsed.transcript.length
            : undefined,
        error: parsed?.error?.message,
      });
    }
    this.emit(event, parsed);
  }
  emit(event, raw) {
    try {
      this.options.onEvent({
        sessionId: this.sessionId,
        event,
        raw,
      });
    } catch (error) {
      console.warn("[livetranslate] emit event error", error);
    }
  }
}
exports.LiveTranslateSession = LiveTranslateSession;
