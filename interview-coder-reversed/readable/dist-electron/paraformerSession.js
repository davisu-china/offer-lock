"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParaformerSession = void 0;
const ws_1 = __importDefault(require("ws"));
const uuid_1 = require("uuid");
const DASH_SCOPE_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
class ParaformerSession {
  constructor(options) {
    this.ws = null;
    this.currentTaskId = null;
    this.closed = false;
    this.options = options;
    this.sessionId = (0, uuid_1.v4)();
    console.log("[paraformer] create session", this.sessionId);
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
      this.sendRunTask();
      return this.awaitCurrentTask();
    }
    console.log("[paraformer] start requested", {
      sessionId: this.sessionId,
      model: this.options.model,
      format: this.options.format,
      sampleRate: this.options.sampleRate,
      language: this.options.language,
    });
    await this.connect();
    this.sendRunTask();
    return this.awaitCurrentTask();
  }
  async startNextTask() {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
      throw new Error("session_not_ready");
    }
    this.sendRunTask();
    return this.awaitCurrentTask();
  }
  async sendAudioChunk(buffer) {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
      throw new Error("session_not_ready");
    }
    if (!buffer || buffer.length === 0) return;
    this.ws.send(buffer);
  }
  async finishTask() {
    if (
      !this.ws ||
      this.ws.readyState !== ws_1.default.OPEN ||
      !this.currentTaskId
    )
      return;
    const payload = {
      header: {
        action: "finish-task",
        task_id: this.currentTaskId,
        streaming: "duplex",
      },
      payload: {
        input: {},
      },
    };
    console.log(
      "[paraformer] send finish-task",
      this.sessionId,
      this.currentTaskId,
    );
    this.ws.send(JSON.stringify(payload));
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.finishTask().catch(() => {});
    } catch (err) {
      console.warn("[paraformer] finish task before close failed", err);
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
        console.warn("[paraformer] error closing websocket", err);
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
        Authorization: `Bearer ${this.options.apiKey}`,
        "X-DashScope-DataInspection": "enable",
      };
      console.log("[paraformer] connecting", this.sessionId);
      const ws = new ws_1.default(DASH_SCOPE_WS_URL, { headers });
      this.ws = ws;
      ws.on("open", () => {
        console.log("[paraformer] websocket open", this.sessionId);
        resolve();
      });
      ws.on("message", (data) => {
        this.handleMessage(data);
      });
      ws.on("error", (err) => {
        console.error("[paraformer] websocket error", this.sessionId, err);
        if (this.rejecter) {
          this.rejecter(err instanceof Error ? err : new Error(String(err)));
          this.rejecter = undefined;
        }
        this.emit("error", err);
      });
      ws.on("close", (code, reason) => {
        console.warn(
          "[paraformer] websocket closed",
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
  sendRunTask() {
    if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) return;
    const taskId = (0, uuid_1.v4)();
    this.currentTaskId = null;
    this.resolver = undefined;
    this.rejecter = undefined;
    const payload = {
      header: {
        action: "run-task",
        task_id: taskId,
        streaming: "duplex",
      },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: this.options.model ?? "fun-asr-realtime",
        parameters: {
          format: this.options.format ?? "pcm",
          sample_rate: this.options.sampleRate ?? 16000,
          language: this.options.language ?? "zh",
          enable_timestamp: false,
          heartbeat: true,
        },
        input: {},
      },
    };
    console.log(
      "[paraformer] send run-task",
      this.sessionId,
      taskId,
      payload.payload.parameters,
    );
    this.ws.send(JSON.stringify(payload));
  }
  handleMessage(raw) {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error("[paraformer] failed to parse message", error);
      this.emit("parse-error", text);
      return;
    }
    const header = parsed?.header || {};
    const event = header.event || "unknown";
    const taskId = header.task_id || this.currentTaskId;
    if (event === "task-started") {
      this.currentTaskId = taskId;
      if (this.resolver) {
        this.resolver(taskId);
        this.resolver = undefined;
        this.rejecter = undefined;
      }
    }
    if (event === "task-failed") {
      const errMsg = header?.error_message || "Task failed";
      console.warn("[paraformer] task failed", this.sessionId, taskId, errMsg);
    }
    if (event === "task-finished") {
      this.currentTaskId = null;
    }
    this.emit(event, parsed);
  }
  emit(event, raw) {
    try {
      this.options.onEvent({
        sessionId: this.sessionId,
        taskId: this.currentTaskId,
        event,
        raw,
      });
    } catch (error) {
      console.warn("[paraformer] emit event error", error);
    }
  }
}
exports.ParaformerSession = ParaformerSession;
