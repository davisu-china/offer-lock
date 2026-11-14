"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParaformerManager = void 0;
const paraformerSession_1 = require("./paraformerSession");
const deepgramSession_1 = require("./deepgramSession");
const openAISession_1 = require("./openAISession");
const doubaoSession_1 = require("./doubaoSession");
const ConfigHelper_1 = require("./ConfigHelper");
class ParaformerManager {
  constructor() {
    this.sessions = new Map();
  }
  async startSession(options) {
    const config = ConfigHelper_1.configHelper.loadConfig();
    const voiceProvider =
      config.voiceAsrProvider || config.voiceProvider || "ali";
    if (voiceProvider === "openai") {
      // Use OpenAI Whisper
      const openaiAsrApiKey = config.openaiAsrApiKey || "";
      const openaiAsrBaseUrl =
        config.openaiAsrBaseUrl || "https://api.openai.com/v1";
      if (!openaiAsrApiKey) {
        throw new Error("OpenAI ASR API Key not configured");
      }
      console.log("[manager] starting OpenAI ASR session", {
        baseUrl: openaiAsrBaseUrl,
      });
      const session = new openAISession_1.OpenAISession({
        apiKey: openaiAsrApiKey,
        baseUrl: openaiAsrBaseUrl,
        model: "whisper-1",
        sampleRate: 16000,
        chunkDurationMs: 3000,
        onEvent: (evt) => this.forwardOpenAIEvent(evt),
      });
      const sessionId = await session.start();
      console.log("[manager] openai session started", sessionId);
      this.sessions.set(sessionId, {
        session,
        provider: "openai",
        sender: options.sender,
        bytesSent: 0,
        chunksSent: 0,
        maxAmplitude: 0,
        rmsSum: 0,
        rmsSamples: 0,
        awaitingNextTask: false,
      });
      if (!options.sender.isDestroyed()) {
        options.sender.once("destroyed", () => {
          void this.stopSession(sessionId);
        });
      }
      return { sessionId, taskId: sessionId };
    } else if (voiceProvider === "deepgram") {
      // Use Deepgram
      const deepgramApiKey = config.deepgramApiKey || "";
      const deepgramLanguage = config.deepgramLanguage || "en-US";
      if (!deepgramApiKey) {
        throw new Error("Deepgram API Key not configured");
      }
      const session = new deepgramSession_1.DeepgramSession({
        apiKey: deepgramApiKey,
        language: deepgramLanguage,
        model: "nova-3",
        sampleRate: 16000,
        onEvent: (evt) => this.forwardDeepgramEvent(evt),
      });
      const sessionId = await session.start();
      console.log("[manager] deepgram session started", sessionId);
      this.sessions.set(sessionId, {
        session,
        provider: "deepgram",
        sender: options.sender,
        bytesSent: 0,
        chunksSent: 0,
        maxAmplitude: 0,
        rmsSum: 0,
        rmsSamples: 0,
        awaitingNextTask: false,
      });
      if (!options.sender.isDestroyed()) {
        options.sender.once("destroyed", () => {
          void this.stopSession(sessionId);
        });
      }
      return { sessionId, taskId: sessionId };
    } else if (voiceProvider === "doubao") {
      // Use Doubao (Volcengine Seed-ASR)
      const doubaoAppId = config.doubaoAppId || "";
      const doubaoToken = config.doubaoToken || "";
      const doubaoClusterId =
        config.doubaoClusterId || "volc.seedasr.sauc.duration";
      if (!doubaoAppId || !doubaoToken) {
        throw new Error("Doubao AppID or Token not configured");
      }
      const session = new doubaoSession_1.DoubaoSession({
        appId: doubaoAppId,
        token: doubaoToken,
        clusterId: doubaoClusterId,
        onEvent: (evt) => this.forwardDoubaoEvent(evt),
      });
      const sessionId = session.getSessionId();
      this.sessions.set(sessionId, {
        session,
        provider: "doubao",
        sender: options.sender,
        bytesSent: 0,
        chunksSent: 0,
        maxAmplitude: 0,
        rmsSum: 0,
        rmsSamples: 0,
        awaitingNextTask: false,
      });
      const taskId = await session.start();
      console.log("[manager] doubao session started", sessionId, taskId);
      if (!options.sender.isDestroyed()) {
        options.sender.once("destroyed", () => {
          void this.stopSession(sessionId);
        });
      }
      return { sessionId, taskId: taskId };
    } else {
      // Use Ali (Paraformer/FunASR)
      const session = new paraformerSession_1.ParaformerSession({
        ...options,
        onEvent: (evt) => this.forwardEvent(evt),
      });
      const taskId = await session.start();
      const sessionId = session.getSessionId();
      console.log("[manager] ali session started", sessionId, taskId);
      this.sessions.set(sessionId, {
        session,
        provider: "ali",
        sender: options.sender,
        bytesSent: 0,
        chunksSent: 0,
        maxAmplitude: 0,
        rmsSum: 0,
        rmsSamples: 0,
        awaitingNextTask: false,
      });
      if (!options.sender.isDestroyed()) {
        options.sender.once("destroyed", () => {
          void this.stopSession(sessionId);
        });
      }
      return { sessionId, taskId };
    }
  }
  async sendAudio(sessionId, taskId, data) {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("session_not_found");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let max = 0;
    let sumSquares = 0;
    let samples = 0;
    for (let i = 0; i + 1 < view.byteLength; i += 2) {
      const sample = view.getInt16(i, true);
      const abs = Math.abs(sample);
      if (abs > max) max = abs;
      sumSquares += sample * sample;
      samples++;
    }
    const rms = samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
    entry.bytesSent += data.byteLength;
    entry.chunksSent += 1;
    entry.rmsSum += rms;
    entry.rmsSamples += 1;
    if (max > entry.maxAmplitude) entry.maxAmplitude = max;
    if (entry.chunksSent <= 3 || entry.chunksSent % 100 === 0) {
      console.log(
        `[${entry.provider}] sendAudio`,
        sessionId,
        taskId,
        data.byteLength,
        `(#${entry.chunksSent})`,
        "totalBytes=",
        entry.bytesSent,
        "max=",
        max,
        "rms=",
        rms.toFixed(2),
      );
    }
    await entry.session.sendAudioChunk(data);
  }
  async finishTask(sessionId, taskId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("session_not_found");
    console.log(`[${entry.provider}] finishTask`, sessionId, taskId, {
      chunks: entry.chunksSent,
      bytes: entry.bytesSent,
      maxAmplitude: entry.maxAmplitude,
      meanRms:
        entry.rmsSamples > 0 ? (entry.rmsSum / entry.rmsSamples).toFixed(2) : 0,
    });
    // Only Ali/Paraformer has finishTask
    if (
      entry.provider === "ali" &&
      entry.session instanceof paraformerSession_1.ParaformerSession
    ) {
      await entry.session.finishTask();
    }
  }
  async stopSession(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    console.log(`[${entry.provider}] stopSession`, sessionId, {
      chunks: entry.chunksSent,
      bytes: entry.bytesSent,
      maxAmplitude: entry.maxAmplitude,
      meanRms:
        entry.rmsSamples > 0 ? (entry.rmsSum / entry.rmsSamples).toFixed(2) : 0,
    });
    try {
      await entry.session.stop();
    } catch (error) {
      console.warn(`[${entry.provider}] error stopping session`, error);
    }
  }
  async stopAll() {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.stopSession(id)));
  }
  forwardEvent(evt) {
    const entry = evt.sessionId ? this.sessions.get(evt.sessionId) : undefined;
    const sender = entry?.sender;
    if (sender && !sender.isDestroyed()) {
      sender.send("paraformer-event", evt.raw);
    }
    const event = evt.event;
    const raw = evt.raw;
    if (event === "result-generated") {
      const output = raw?.payload?.output;
      const collectItems = () => {
        if (!output) return [];
        if (Array.isArray(output?.results)) return output.results;
        if (Array.isArray(output?.result)) return output.result;
        if (Array.isArray(output?.segments)) return output.segments;
        if (Array.isArray(output?.sentences)) return output.sentences;
        if (Array.isArray(output?.transcriptions)) return output.transcriptions;
        if (output?.sentence && typeof output.sentence === "object")
          return [output.sentence];
        if (output?.transcription && typeof output.transcription === "object")
          return [output.transcription];
        return [];
      };
      const items = collectItems();
      if (items.length === 0 && output?.text) {
        items.push({
          text: output.text,
          sentence_end: output.sentence_end,
          sentence_id: output.sentence_id,
        });
      }
      if (items.length === 0) {
        console.warn(
          "[paraformer] result-generated but no parsable items",
          JSON.stringify(output),
        );
      }
      for (const item of items) {
        const text = item?.text || item?.transcript || item?.content;
        const sentenceEnd = Boolean(
          item?.sentence_end || item?.is_sentence_end || item?.final,
        );
        const sentenceId =
          typeof item?.sentence_id !== "undefined"
            ? item.sentence_id
            : (item?.segment_id ?? null);
        console.log(
          "[paraformer] result-generated",
          evt.sessionId,
          evt.taskId,
          {
            text,
            sentenceEnd,
            sentenceId,
          },
        );
        if (sender && !sender.isDestroyed() && text) {
          sender.send("voice-transcript-delta", {
            text,
            sentenceEnd,
            sentenceId,
          });
          if (sentenceEnd) {
            sender.send("voice-transcript-result", text);
          }
        }
      }
    }
    if (event === "task-finished") {
      console.log("[paraformer] task finished", evt.sessionId, evt.taskId);
      if (sender && !sender.isDestroyed()) {
        sender.send("paraformer-task-finished", raw);
      }
      // Only Ali/Paraformer needs to start next task
      if (
        entry &&
        entry.provider === "ali" &&
        entry.session instanceof paraformerSession_1.ParaformerSession
      ) {
        entry.awaitingNextTask = true;
        entry.session
          .startNextTask()
          .then((newTaskId) => {
            entry.awaitingNextTask = false;
            entry.bytesSent = 0;
            entry.chunksSent = 0;
            entry.maxAmplitude = 0;
            entry.rmsSum = 0;
            entry.rmsSamples = 0;
            console.log(
              "[paraformer] new task started",
              evt.sessionId,
              newTaskId,
            );
          })
          .catch((error) => {
            entry.awaitingNextTask = false;
            console.error("[paraformer] failed to start next task", {
              sessionId: evt.sessionId,
              error,
            });
            void this.stopSession(evt.sessionId);
          });
      }
    }
    if (event === "task-failed") {
      console.warn(
        "[paraformer] task failed",
        evt.sessionId,
        evt.taskId,
        raw?.header?.error_message,
      );
      if (sender && !sender.isDestroyed()) {
        sender.send("paraformer-task-failed", raw);
      }
      void this.stopSession(evt.sessionId);
    }
    if (event === "closed") {
      console.warn("[paraformer] session closed", evt.sessionId);
      void this.stopSession(evt.sessionId);
    }
  }
  // Forward Deepgram events (already in unified format)
  forwardDeepgramEvent(evt) {
    const entry = evt.sessionId ? this.sessions.get(evt.sessionId) : undefined;
    const sender = entry?.sender;
    if (evt.event === "result-generated" && evt.text) {
      console.log("[deepgram] result-generated", evt.sessionId, {
        text: evt.text.substring(0, 50) + (evt.text.length > 50 ? "..." : ""),
        sentenceEnd: evt.sentenceEnd,
        isFinal: evt.isFinal,
      });
      if (sender && !sender.isDestroyed()) {
        sender.send("voice-transcript-delta", {
          text: evt.text,
          sentenceEnd: evt.sentenceEnd,
          sentenceId: evt.sentenceId,
        });
        if (evt.sentenceEnd) {
          sender.send("voice-transcript-result", evt.text);
        }
      }
    }
    if (evt.event === "error") {
      console.error("[deepgram] error", evt.sessionId, evt.raw);
      if (sender && !sender.isDestroyed()) {
        sender.send("paraformer-task-failed", { error: evt.raw });
      }
    }
    if (evt.event === "closed") {
      console.warn("[deepgram] session closed", evt.sessionId);
      void this.stopSession(evt.sessionId);
    }
  }
  // Forward OpenAI Whisper events (same pattern as Deepgram)
  forwardOpenAIEvent(evt) {
    const entry = evt.sessionId ? this.sessions.get(evt.sessionId) : undefined;
    const sender = entry?.sender;
    if (evt.event === "result-generated" && evt.text) {
      console.log("[openai] result-generated", evt.sessionId, {
        text: evt.text.substring(0, 50) + (evt.text.length > 50 ? "..." : ""),
        sentenceEnd: evt.sentenceEnd,
      });
      if (sender && !sender.isDestroyed()) {
        sender.send("voice-transcript-delta", {
          text: evt.text,
          sentenceEnd: evt.sentenceEnd,
          sentenceId: null,
        });
        if (evt.sentenceEnd) {
          sender.send("voice-transcript-result", evt.text);
        }
      }
    }
    if (evt.event === "error") {
      console.error("[openai] error", evt.sessionId, evt.raw);
      if (sender && !sender.isDestroyed()) {
        sender.send("paraformer-task-failed", { error: evt.raw });
      }
    }
    if (evt.event === "closed") {
      console.warn("[openai] session closed", evt.sessionId);
      void this.stopSession(evt.sessionId);
    }
  }
  // Forward Doubao events (Volcengine Seed-ASR)
  forwardDoubaoEvent(evt) {
    const entry = evt.sessionId ? this.sessions.get(evt.sessionId) : undefined;
    const sender = entry?.sender;
    if (evt.event === "result-generated" && evt.text) {
      console.log("[doubao] result-generated", evt.sessionId, {
        text:
          evt.text.length > 50 ? evt.text.substring(0, 50) + "..." : evt.text,
        sentenceEnd: evt.sentenceEnd,
      });
      if (sender && !sender.isDestroyed()) {
        sender.send("voice-transcript-delta", {
          text: evt.text,
          sentenceEnd: evt.sentenceEnd,
          sentenceId: null,
        });
        if (evt.sentenceEnd) {
          sender.send("voice-transcript-result", evt.text);
        }
      }
    }
    if (evt.event === "task-failed" || evt.event === "error") {
      console.error("[doubao] task error / failure", evt.sessionId, evt.raw);
      if (sender && !sender.isDestroyed()) {
        sender.send("paraformer-task-failed", { error: evt.raw });
      }
      void this.stopSession(evt.sessionId);
    }
    if (evt.event === "task-finished" || evt.event === "closed") {
      console.warn("[doubao] session finished/closed", evt.sessionId);
      if (sender && !sender.isDestroyed()) {
        sender.send("paraformer-task-finished", evt.raw);
      }
      void this.stopSession(evt.sessionId);
    }
  }
}
exports.ParaformerManager = ParaformerManager;
