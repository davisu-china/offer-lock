"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.DoubaoSession = void 0;
const ws_1 = __importDefault(require("ws"));
const uuid_1 = require("uuid");
const zlib = __importStar(require("zlib"));
const DOUBAO_WS_URL =
  "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
class DoubaoSession {
  constructor(options) {
    this.ws = null;
    this.currentTaskId = null;
    this.closed = false;
    this.options = options;
    this.sessionId = (0, uuid_1.v4)();
    console.log("[doubao] create session", this.sessionId);
  }
  getSessionId() {
    return this.sessionId;
  }
  getTaskId() {
    return this.currentTaskId;
  }
  async start() {
    if (this.ws) {
      if (this.currentTaskId) return this.currentTaskId;
    }
    console.log("[doubao] start requested", {
      sessionId: this.sessionId,
      appId: this.options.appId,
    });
    await this.connect();
    this.sendFullClientRequest();
    return this.awaitCurrentTask();
  }
  async sendAudioChunk(buffer) {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
      throw new Error("session_not_ready");
    }
    if (!buffer || buffer.length === 0) return;
    // Message type 2 (AudioReq), specific flags 0
    // Serialization 0 (none), compression 0 (none)
    const header = Buffer.from([0x11, 0x20, 0x00, 0x00]);
    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(buffer.length, 0);
    const message = Buffer.concat([header, payloadSize, buffer]);
    this.ws.send(message);
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.ws) {
      // Send last package (negative sequence or specific flag = 2 indicating last packet)
      // Actually Volcengine handles normal drops too, but letting them know is polite.
      // Byte 1: specific flags = 0b0010 (2) -> Last audio packet
      try {
        if (this.ws.readyState === ws_1.default.OPEN) {
          const header = Buffer.from([0x11, 0x22, 0x00, 0x00]);
          const payloadSize = Buffer.alloc(4);
          payloadSize.writeUInt32BE(0, 0);
          this.ws.send(Buffer.concat([header, payloadSize]));
        }
      } catch (err) {
        console.warn("[doubao] send last packet failed", err);
      }
      try {
        this.ws.removeAllListeners();
        // Prevent Uncaught Exception if ws.close() or ws.terminate() emits an error
        this.ws.on("error", () => {});
        if (
          this.ws.readyState === ws_1.default.OPEN ||
          this.ws.readyState === ws_1.default.CONNECTING
        ) {
          this.ws.close();
        }
      } catch (err) {
        console.warn("[doubao] error closing websocket", err);
      }
    }
    this.ws = null;
    this.currentTaskId = null;
    this.resolver = undefined;
    this.rejecter = undefined;
  }
  awaitCurrentTask() {
    return new Promise((resolve, reject) => {
      if (this.currentTaskId) {
        resolve(this.currentTaskId);
        return;
      }
      this.resolver = resolve;
      this.rejecter = reject;
    });
  }
  async connect() {
    return new Promise((resolve, reject) => {
      const headers = {
        "X-Api-App-Key": this.options.appId,
        "X-Api-Access-Key": this.options.token,
        "X-Api-Resource-Id":
          this.options.clusterId || "volc.seedasr.sauc.duration",
        "X-Api-Connect-Id": this.sessionId,
        "X-Api-Request-Id": (0, uuid_1.v4)(),
        "X-Api-Sequence": "-1",
      };
      console.log("[doubao] connecting to ws...", this.sessionId);
      const ws = new ws_1.default(DOUBAO_WS_URL, { headers });
      this.ws = ws;
      ws.on("open", () => {
        console.log("[doubao] websocket open", this.sessionId);
        this.currentTaskId = (0, uuid_1.v4)();
        resolve();
      });
      ws.on("message", (data) => {
        this.handleMessage(data);
      });
      ws.on("error", (err) => {
        console.error("[doubao] websocket error", this.sessionId, err);
        if (this.rejecter) {
          this.rejecter(err instanceof Error ? err : new Error(String(err)));
          this.rejecter = undefined;
        }
        this.emit("error", { error: err.message });
      });
      ws.on("close", (code, reason) => {
        console.warn(
          "[doubao] websocket closed",
          this.sessionId,
          code,
          reason.toString(),
        );
        if (this.rejecter) {
          this.rejecter(new Error("connection_closed"));
          this.rejecter = undefined;
        }
        this.emit("closed", { code, reason });
        this.ws = null;
        this.currentTaskId = null;
      });
    });
  }
  sendFullClientRequest() {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) return;
    const payloadObj = {
      app: {
        appid: this.options.appId,
        token: this.options.token,
        cluster: this.options.clusterId || "volc.seedasr.sauc.duration",
      },
      user: {
        uid: "user_" + Date.now().toString(),
      },
      audio: {
        format: "pcm",
        codec: "raw",
        rate: 16000,
        bits: 16,
        channel: 1,
        language: "zh-CN",
      },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        enable_ddc: false,
        show_utterances: true,
        result_type: "single",
        end_window_size: 800,
        enable_nonstream: true,
      },
    };
    const payloadJsonStr = JSON.stringify(payloadObj);
    const payloadBuffer = Buffer.from(payloadJsonStr, "utf8");
    // Gzip compression
    const compressedPayload = zlib.gzipSync(payloadBuffer);
    // Header structure:
    // Byte 0: Protocol version (4 bits) | Header size (4 bits) = 0x11
    // Byte 1: Message type (4 bits) | specific flags (4 bits) -> Type 1 (FullClientReq) = 0x10
    // Byte 2: Serialization method (4 bits) | compression (4 bits) -> 1 (JSON) | 1 (Gzip) = 0x11
    // Byte 3: Reserved (8 bits) = 0x00
    const header = Buffer.from([0x11, 0x10, 0x11, 0x00]);
    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(compressedPayload.length, 0);
    const message = Buffer.concat([header, payloadSize, compressedPayload]);
    console.log("[doubao] send full client request", this.sessionId);
    this.ws.send(message);
    // We immediately consider the task started once connected and request sent
    if (this.currentTaskId && this.resolver) {
      this.resolver(this.currentTaskId);
      this.resolver = undefined;
      this.rejecter = undefined;
    }
  }
  handleMessage(raw) {
    if (!Buffer.isBuffer(raw)) {
      console.warn("[doubao] received non-buffer WS message");
      return;
    }
    if (raw.length < 4) {
      console.warn("[doubao] invalid message length < 4");
      return;
    }
    const header = raw.subarray(0, 4);
    const headerSize = (header[0] & 0x0f) * 4;
    const messageType = header[1] >> 4;
    // MessageType 9: Full Server Response, 15: Error
    // Payload size starts right after the header?
    // According to docs, format is Header(4B) -> Sequence(4B, if flag is set, wait)
    // In Server Response, the payload size usually starts at headerSize + X.
    // Wait, let's look at full server response:
    // "Header | Sequence | Payload size (4B, unsigned int32) | Payload"
    // Sequence size is 4 bytes.
    let offset = headerSize;
    const messageTypeSpecificFlags = header[1] & 0x0f;
    // If flag == 1 or 3, next 4 bytes are sequence number
    if (
      messageTypeSpecificFlags === 0b0001 ||
      messageTypeSpecificFlags === 0b0011
    ) {
      offset += 4;
    } else if (messageType === 9) {
      // According to docs Full Server Response often has sequence
      // In their docs: "Header | Sequence | Payload size (4B) | Payload"
      // This implies sequence is unconditionally there for type=9? Actually it depends on flags.
      // Usually Server response specific flags = 0001 (seq positive) or 0011 (seq negative).
      // So let's rely on specific flags OR assume type 9 always has 4B sequence.
      // Volcengine docs say: type 9 format: Header | Sequence | Payload size | Payload.
      // Let's safely check if offset + 4 <= raw.length
      if (messageTypeSpecificFlags === 0) {
        // According to exact spec, 0000 = no sequence. But docs says format is "Header|Sequence|Payload size".
        // Let's assume the doc implies flag 0001 or 0011 is always set for type 9.
        offset += 4; // Let's advance it assuming type 9 always has seq, unless we read it from flag
      }
    } else if (messageType === 15) {
      // Error
      // Next is payload size?
    }
    // Safety fallback: just search for '{' in the payload if uncompressed JSON
    // The serialization method in Byte 2
    const serializationMethod = header[2] >> 4;
    const messageCompression = header[2] & 0x0f;
    if (messageType === 15) {
      // Error
      try {
        // Find JSON payload dynamically
        const jsonStart = raw.indexOf(Buffer.from("{"));
        if (jsonStart !== -1) {
          const payloadStr = raw.subarray(jsonStart).toString("utf8");
          const errObj = JSON.parse(payloadStr);
          console.error("[doubao] server error response:", errObj);
          this.emit("task-failed", errObj);
        }
      } catch (e) {}
      return;
    }
    if (messageType !== 9) {
      return; // We only care about Full Server Response and Error
    }
    try {
      // Safely extract payload by searching for '{'
      // Because sometimes docs are slightly off about sequence length
      // and finding JSON directly is much more robust for uncompressed/gzipped JSON.
      // Let's follow strict spec first:
      // Offset right now points to Payload Size
      let payloadSize = 0;
      if (offset + 4 <= raw.length) {
        payloadSize = raw.readUInt32BE(offset);
        offset += 4;
      }
      let payloadBuffer = raw.subarray(offset, offset + payloadSize);
      if (payloadBuffer.length === 0) {
        // Fallback: take all remaining
        payloadBuffer = raw.subarray(offset);
      }
      // Decompress if needed
      if (messageCompression === 1) {
        // GZIP
        payloadBuffer = zlib.gunzipSync(payloadBuffer);
      }
      const payloadStr = payloadBuffer.toString("utf8");
      const parsed = JSON.parse(payloadStr);
      // Expected JSON format:
      // { "result": { "text": "...", "utterances": [ ... ] } }
      const text = parsed?.result?.text;
      const reqid = parsed?.reqid;
      if (text !== undefined) {
        // console.log("[doubao] result:", JSON.stringify(parsed?.result))
        // Find if this is a final definite sentence
        // In 2.0 (Seed-ASR), multiple utterances imply that previous segments are finalized.
        // We trigger sentenceEnd if the last utterance is definite OR if we have more than one utterance active.
        let sentenceEnd = false;
        const utterances = parsed?.result?.utterances || [];
        if (utterances.length > 0) {
          const lastUtterance = utterances[utterances.length - 1];
          sentenceEnd =
            Boolean(lastUtterance.definite) || utterances.length > 1;
        }
        console.log("[doubao] result-generated:", {
          text: text.length > 20 ? text.substring(0, 20) + "..." : text,
          sentenceEnd,
          utterances: utterances.length,
        });
        const isFinal =
          messageTypeSpecificFlags === 0b0011 ||
          messageTypeSpecificFlags === 0b0010; // flag indicates last packet
        this.emit("result-generated", parsed, text, sentenceEnd || isFinal);
      }
      // If it's the last packet
      if (
        messageTypeSpecificFlags === 0b0011 ||
        messageTypeSpecificFlags === 0b0010
      ) {
        this.emit("task-finished", parsed);
        this.currentTaskId = null;
      }
    } catch (e) {
      // console.warn("[doubao] parse payload error", e)
    }
  }
  emit(event, raw, text, sentenceEnd) {
    try {
      this.options.onEvent({
        sessionId: this.sessionId,
        taskId: this.currentTaskId,
        event,
        raw,
        text,
        sentenceEnd,
      });
    } catch (error) {
      console.warn("[doubao] emit event error", error);
    }
  }
}
exports.DoubaoSession = DoubaoSession;
