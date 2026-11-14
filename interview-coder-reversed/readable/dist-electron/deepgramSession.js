"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeepgramSession = void 0;
const ws_1 = __importDefault(require("ws"));
const uuid_1 = require("uuid");
const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";
class DeepgramSession {
  constructor(options) {
    this.ws = null;
    this.closed = false;
    this.connected = false;
    this.utteranceIndex = 1;
    this.finalizedSegments = [];
    this.options = options;
    this.sessionId = (0, uuid_1.v4)();
    console.log("[deepgram] create session", this.sessionId);
  }
  getSessionId() {
    return this.sessionId;
  }
  async start() {
    if (this.ws && this.connected) {
      return this.sessionId;
    }
    console.log("[deepgram] start requested", {
      sessionId: this.sessionId,
      language: this.options.language,
      model: this.options.model,
      sampleRate: this.options.sampleRate,
    });
    await this.connect();
    return this.sessionId;
  }
  async sendAudioChunk(buffer) {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
      throw new Error("session_not_ready");
    }
    if (!buffer || buffer.length === 0) return;
    this.ws.send(buffer);
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.ws) {
      try {
        // Send CloseStream message to gracefully close
        if (this.ws.readyState === ws_1.default.OPEN) {
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        }
        this.ws.removeAllListeners();
        this.ws.on("error", () => {});
        if (
          this.ws.readyState === ws_1.default.OPEN ||
          this.ws.readyState === ws_1.default.CONNECTING
        ) {
          this.ws.close();
        }
      } catch (err) {
        console.warn("[deepgram] error closing websocket", err);
      }
    }
    this.ws = null;
    this.connected = false;
    this.rejecter = undefined;
  }
  async connect() {
    return new Promise((resolve) => {
      // Build URL with parameters
      const params = new URLSearchParams({
        model: this.options.model || "nova-3",
        language: this.options.language || "en-US",
        smart_format: "true",
        interim_results: "true",
        punctuate: "true",
        endpointing: "300",
        encoding: "linear16",
        sample_rate: String(this.options.sampleRate || 16000),
        channels: "1",
      });
      const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;
      console.log(
        "[deepgram] connecting",
        this.sessionId,
        url.replace(/\?.*/, "?..."),
      );
      // --- Proxy Support Start ---
      let agent = undefined;
      const proxyUrl =
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.ALL_PROXY ||
        process.env.all_proxy;
      if (proxyUrl) {
        try {
          // https-proxy-agent is a common transitive dependency
          const { HttpsProxyAgent } = require("https-proxy-agent");
          agent = new HttpsProxyAgent(proxyUrl);
          console.log("[deepgram] using proxy", proxyUrl);
        } catch (e) {
          console.warn(
            "[deepgram] https-proxy-agent not found, skipping proxy",
            e,
          );
        }
      }
      // --- Proxy Support End ---
      const ws = new ws_1.default(url, {
        agent,
        headers: {
          Authorization: `Token ${this.options.apiKey}`,
        },
      });
      this.ws = ws;
      ws.on("open", () => {
        console.log("[deepgram] websocket open", this.sessionId);
        this.connected = true;
        resolve();
      });
      ws.on("message", (data) => {
        this.handleMessage(data);
      });
      ws.on("error", (err) => {
        console.error("[deepgram] websocket error", this.sessionId, err);
        if (this.rejecter) {
          this.rejecter(err instanceof Error ? err : new Error(String(err)));
          this.rejecter = undefined;
        }
        this.emit("error", "", false, false, err);
      });
      ws.on("close", (code, reason) => {
        console.warn(
          "[deepgram] websocket closed",
          this.sessionId,
          code,
          reason.toString(),
        );
        if (this.rejecter) {
          this.rejecter(new Error("connection_closed"));
          this.rejecter = undefined;
        }
        this.emit("closed", "", false, false, { code, reason });
        this.ws = null;
        this.connected = false;
      });
    });
  }
  handleMessage(raw) {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error("[deepgram] failed to parse message", error);
      return;
    }
    // Deepgram response format:
    // {
    //   "type": "Results",
    //   "channel": { "alternatives": [{ "transcript": "...", "confidence": 0.99 }] },
    //   "is_final": true,
    //   "speech_final": true
    // }
    const type = parsed?.type;
    if (type === "Results") {
      const transcript = this.normalizeTranscript(
        parsed?.channel?.alternatives?.[0]?.transcript || "",
      );
      const isFinal = parsed?.is_final === true;
      const speechFinal = parsed?.speech_final === true;
      const sentenceId = this.getCurrentUtteranceId();
      const start = Number(parsed?.start ?? 0);
      const duration = Number(parsed?.duration ?? 0);
      const segmentKey =
        Number.isFinite(start) && Number.isFinite(duration)
          ? `${start.toFixed(3)}:${(start + duration).toFixed(3)}`
          : `${sentenceId}:seg:${this.finalizedSegments.length + 1}`;
      if (transcript) {
        console.log("[deepgram] result", this.sessionId, {
          transcript:
            transcript.substring(0, 50) + (transcript.length > 50 ? "..." : ""),
          isFinal,
          speechFinal,
        });
        if (isFinal) {
          this.appendFinalSegment(segmentKey, transcript);
          const finalText = this.composeTranscript();
          this.emit(
            "result-generated",
            finalText,
            speechFinal,
            true,
            parsed,
            sentenceId,
          );
          if (speechFinal) {
            this.resetCurrentUtterance();
          }
          return;
        }
        const draftText = this.composeTranscript(transcript);
        this.emit(
          "result-generated",
          draftText,
          false,
          false,
          parsed,
          sentenceId,
        );
      }
    } else if (type === "Metadata") {
      console.log("[deepgram] metadata", this.sessionId, parsed);
    } else if (type === "SpeechStarted") {
      console.log("[deepgram] speech started", this.sessionId);
    } else if (type === "UtteranceEnd") {
      console.log("[deepgram] utterance end", this.sessionId);
    }
  }
  getCurrentUtteranceId() {
    return `${this.sessionId}:utt:${this.utteranceIndex}`;
  }
  appendFinalSegment(key, text) {
    if (!text) return;
    if (this.finalizedSegments.some((segment) => segment.key === key)) {
      return;
    }
    this.finalizedSegments.push({ key, text });
  }
  composeTranscript(draftText) {
    const parts = this.finalizedSegments.map((segment) => segment.text);
    if (draftText) {
      parts.push(draftText);
    }
    return parts
      .map((part) => this.normalizeTranscript(part))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  normalizeTranscript(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }
  resetCurrentUtterance() {
    this.finalizedSegments = [];
    this.utteranceIndex += 1;
  }
  emit(event, text, sentenceEnd, isFinal, raw, sentenceId = null) {
    try {
      this.options.onEvent({
        sessionId: this.sessionId,
        event,
        text,
        sentenceEnd,
        isFinal,
        sentenceId,
        raw,
      });
    } catch (error) {
      console.warn("[deepgram] emit event error", error);
    }
  }
}
exports.DeepgramSession = DeepgramSession;
