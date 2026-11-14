"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAISession = void 0;
const uuid_1 = require("uuid");
const axios_1 = __importDefault(require("axios"));
class OpenAISession {
  constructor(options) {
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
    this.flushTimer = null;
    this.closed = false;
    this.sentenceCounter = 0;
    this.totalChunksSent = 0;
    this.totalBytesSent = 0;
    this.totalRequestsMade = 0;
    this.options = {
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      sampleRate: 16000,
      chunkDurationMs: 3000,
      ...options,
    };
    this.sessionId = (0, uuid_1.v4)();
    console.log("[openai-asr] 🎤 session created", {
      sessionId: this.sessionId,
      baseUrl: this.options.baseUrl,
      model: this.options.model,
      language: this.options.language || "auto",
      sampleRate: this.options.sampleRate,
      chunkDurationMs: this.options.chunkDurationMs,
    });
  }
  getSessionId() {
    return this.sessionId;
  }
  /**
   * 启动会话。对于 HTTP 方式，这里只是标记会话开始。
   * 返回 sessionId 作为 taskId（保持与 Deepgram 一致的接口）。
   */
  async start() {
    console.log("[openai-asr] ✅ session started", this.sessionId);
    this.startFlushTimer();
    return this.sessionId;
  }
  /**
   * 接收音频块（PCM 16-bit LE, 16kHz）
   * 缓冲到一定时长后自动发送
   */
  async sendAudioChunk(buffer) {
    if (this.closed) return;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.audioBuffer.push(buf);
    this.audioBufferBytes += buf.byteLength;
    this.totalChunksSent++;
    this.totalBytesSent += buf.byteLength;
    // 每 100 个 chunk 打印一次统计
    if (this.totalChunksSent <= 3 || this.totalChunksSent % 100 === 0) {
      console.log("[openai-asr] 📦 audio chunk received", {
        sessionId: this.sessionId,
        chunkSize: buf.byteLength,
        bufferBytes: this.audioBufferBytes,
        totalChunks: this.totalChunksSent,
        totalBytes: this.totalBytesSent,
      });
    }
    // 检查是否达到发送阈值
    const sampleRate = this.options.sampleRate;
    const chunkDurationMs = this.options.chunkDurationMs;
    const thresholdBytes = Math.floor(
      (sampleRate * 2 * chunkDurationMs) / 1000,
    ); // 16-bit = 2 bytes per sample
    if (this.audioBufferBytes >= thresholdBytes) {
      console.log("[openai-asr] 📤 buffer threshold reached, flushing", {
        sessionId: this.sessionId,
        bufferBytes: this.audioBufferBytes,
        thresholdBytes,
      });
      await this.flushBuffer();
    }
  }
  /**
   * 停止会话，发送剩余缓冲
   */
  async stop() {
    if (this.closed) return;
    this.closed = true;
    console.log("[openai-asr] 🛑 stopping session", {
      sessionId: this.sessionId,
      remainingBufferBytes: this.audioBufferBytes,
      totalChunks: this.totalChunksSent,
      totalBytes: this.totalBytesSent,
      totalRequests: this.totalRequestsMade,
    });
    this.stopFlushTimer();
    // 发送剩余音频
    if (this.audioBufferBytes > 0) {
      console.log("[openai-asr] 📤 flushing remaining buffer before stop");
      await this.flushBuffer();
    }
    this.emitEvent("closed", "", false, null);
    console.log("[openai-asr] ✅ session stopped", this.sessionId);
  }
  // ===== 内部方法 =====
  /**
   * 定时器：每隔 chunkDurationMs 检查一次缓冲区
   * 这样即使音频很少，也不会无限等待
   */
  startFlushTimer() {
    const interval = this.options.chunkDurationMs;
    this.flushTimer = setInterval(async () => {
      if (this.audioBufferBytes > 0 && !this.closed) {
        console.log("[openai-asr] ⏰ timer flush triggered", {
          sessionId: this.sessionId,
          bufferBytes: this.audioBufferBytes,
        });
        await this.flushBuffer();
      }
    }, interval);
  }
  stopFlushTimer() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
  /**
   * 将缓冲区的 PCM 数据打包为 WAV，发送到 OpenAI
   */
  async flushBuffer() {
    if (this.audioBufferBytes === 0) return;
    // 取出当前缓冲
    const chunks = this.audioBuffer.splice(0);
    const totalBytes = this.audioBufferBytes;
    this.audioBufferBytes = 0;
    // 合并为完整 PCM buffer
    const pcmData = Buffer.concat(chunks);
    // 转为 WAV
    const wavData = this.pcmToWav(pcmData, this.options.sampleRate, 1, 16);
    this.totalRequestsMade++;
    const requestId = this.totalRequestsMade;
    console.log("[openai-asr] 🚀 sending request #" + requestId, {
      sessionId: this.sessionId,
      pcmBytes: totalBytes,
      wavBytes: wavData.byteLength,
      durationMs: Math.round((totalBytes / 2 / this.options.sampleRate) * 1000),
    });
    try {
      const text = await this.callWhisperAPI(wavData, requestId);
      if (text && text.trim()) {
        this.sentenceCounter++;
        console.log("[openai-asr] ✅ transcription result #" + requestId, {
          sessionId: this.sessionId,
          text: text.substring(0, 80) + (text.length > 80 ? "..." : ""),
          sentenceId: this.sentenceCounter,
        });
        this.emitEvent(
          "result-generated",
          text.trim(),
          true,
          this.sentenceCounter,
        );
      } else {
        console.log(
          "[openai-asr] ⚪ empty transcription result #" + requestId,
          {
            sessionId: this.sessionId,
          },
        );
      }
    } catch (error) {
      console.error("[openai-asr] ❌ transcription failed #" + requestId, {
        sessionId: this.sessionId,
        error: error?.message || error,
        status: error?.response?.status,
      });
      this.emitEvent("error", "", false, error);
    }
  }
  /**
   * 调用 OpenAI Whisper API（使用 axios + 手动构建 multipart/form-data）
   */
  async callWhisperAPI(wavData, requestId) {
    const baseUrl = (
      this.options.baseUrl || "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    const url = `${baseUrl}/audio/transcriptions`;
    console.log("[openai-asr] 📡 POST", url, {
      requestId,
      model: this.options.model,
      language: this.options.language || "auto-detect",
      wavSize: wavData.byteLength,
    });
    // 手动构建 multipart/form-data（避免引入额外依赖）
    const boundary =
      "----OpenAIWhisperBoundary" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2);
    const parts = [];
    // file 字段
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`,
      ),
    );
    parts.push(wavData);
    parts.push(Buffer.from("\r\n"));
    // model 字段
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="model"\r\n\r\n` +
          `${this.options.model}\r\n`,
      ),
    );
    // language 字段（可选）
    if (this.options.language) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="language"\r\n\r\n` +
            `${this.options.language}\r\n`,
        ),
      );
    }
    // response_format 字段
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
          `text\r\n`,
      ),
    );
    // 结束边界
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const startTime = Date.now();
    const response = await axios_1.default.post(url, body, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.byteLength),
      },
      // 返回原始文本
      responseType: "text",
      transformResponse: [(data) => data],
      // 超时 30 秒
      timeout: 30000,
      // 不验证状态码（手动处理错误）
      validateStatus: () => true,
    });
    const elapsed = Date.now() - startTime;
    if (response.status < 200 || response.status >= 300) {
      const errorBody =
        typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data);
      console.error("[openai-asr] ❌ API error", {
        requestId,
        status: response.status,
        statusText: response.statusText,
        body: errorBody.substring(0, 200),
        elapsed: elapsed + "ms",
      });
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText} - ${errorBody}`,
      );
    }
    const text =
      typeof response.data === "string" ? response.data : String(response.data);
    console.log("[openai-asr] ⏱️ API response time", {
      requestId,
      elapsed: elapsed + "ms",
      textLength: text.length,
    });
    return text;
  }
  /**
   * PCM 16-bit LE → WAV 格式
   */
  pcmToWav(pcmData, sampleRate, channels, bitsPerSample) {
    const dataSize = pcmData.byteLength;
    const headerSize = 44;
    const fileSize = headerSize + dataSize;
    const header = Buffer.alloc(headerSize);
    // RIFF header
    header.write("RIFF", 0);
    header.writeUInt32LE(fileSize - 8, 4);
    header.write("WAVE", 8);
    // fmt sub-chunk
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // Sub-chunk size
    header.writeUInt16LE(1, 20); // Audio format (PCM)
    header.writeUInt16LE(channels, 22); // Number of channels
    header.writeUInt32LE(sampleRate, 24); // Sample rate
    header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28); // Byte rate
    header.writeUInt16LE((channels * bitsPerSample) / 8, 32); // Block align
    header.writeUInt16LE(bitsPerSample, 34); // Bits per sample
    // data sub-chunk
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmData]);
  }
  /**
   * 发送事件到 ParaformerManager
   */
  emitEvent(event, text, sentenceEnd, raw) {
    try {
      this.options.onEvent({
        sessionId: this.sessionId,
        event,
        text,
        sentenceEnd,
        raw,
      });
    } catch (error) {
      console.warn("[openai-asr] ⚠️ emit event error", error);
    }
  }
}
exports.OpenAISession = OpenAISession;
