"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileBridge = void 0;
const node_http_1 = __importDefault(require("node:http"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
const DEFAULT_PORT = 18765;
const MAX_PORT = 18775;
const MAX_TRANSCRIPTS = 8;
const MAX_SPEECH_TRANSCRIPTS = 16;
const RESET_PENDING_SESSION = "__RESET_PENDING__";
class MobileBridge {
  constructor(options = {}) {
    this.server = null;
    this.clients = new Map();
    this.token = (0, node_crypto_1.randomBytes)(16).toString("hex");
    this.port = null;
    this.attachedWebContents = new WeakSet();
    this.recentTranscriptKeys = new Map();
    this.activeSessionId = "";
    this.loggedStaleAnswerSessions = new Set();
    this.speechTranscripts = [];
    this.desktopTranscriptState = null;
    this.snapshot = {
      status: "idle",
      sessionId: "",
      transcripts: [],
      speechTranscripts: [],
      desktopTranscriptState: null,
      draftTranscript: "",
      answer: "",
      answerComplete: false,
    };
    this.onAction = options.onAction;
  }
  async start() {
    if (this.server) return;
    for (let port = DEFAULT_PORT; port <= MAX_PORT; port++) {
      try {
        await this.listenOnPort(port);
        this.port = port;
        const urls = this.getAccessUrls();
        console.log("[mobile] companion page started");
        urls.forEach((url) => console.log(`[mobile] ${url}`));
        this.logNetworkCandidates();
        return;
      } catch (error) {
        try {
          const failedServer = this.server;
          failedServer?.close();
        } catch {}
        this.server = null;
        if (error?.code !== "EADDRINUSE" || port === MAX_PORT) {
          console.warn("[mobile] failed to start companion page:", error);
          this.server = null;
          this.port = null;
          return;
        }
      }
    }
  }
  async stop() {
    for (const client of this.clients.values()) {
      try {
        client.response.end();
      } catch {}
    }
    this.clients.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }
  attachWebContents(webContents) {
    if (!webContents || this.attachedWebContents.has(webContents)) return;
    this.attachedWebContents.add(webContents);
    const originalSend = webContents.send.bind(webContents);
    webContents.send = (channel, ...args) => {
      try {
        this.handleRendererEvent(channel, args[0]);
      } catch (error) {
        console.warn("[mobile] failed to mirror renderer event:", error);
      }
      return originalSend(channel, ...args);
    };
  }
  getInfo() {
    return {
      enabled: Boolean(this.server && this.port),
      port: this.port,
      token: this.token,
      urls: this.getAccessUrls(),
      connectedClients: this.clients.size,
    };
  }
  getSnapshot() {
    return {
      ...this.snapshot,
      transcripts: [...this.snapshot.transcripts],
      speechTranscripts: [...this.speechTranscripts],
      desktopTranscriptState: this.desktopTranscriptState
        ? {
            ...this.desktopTranscriptState,
            sentences: [...this.desktopTranscriptState.sentences],
          }
        : null,
    };
  }
  broadcast(type, payload) {
    const event = {
      type,
      ts: Date.now(),
      payload,
    };
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const [id, client] of this.clients.entries()) {
      try {
        client.response.write(line);
      } catch {
        this.clients.delete(id);
      }
    }
  }
  updateTranscriptState(payload) {
    const sentences = Array.isArray(payload?.sentences)
      ? payload.sentences
          .map((item) => ({
            id: String(item?.id || ""),
            text: this.compactInlineText(String(item?.text || "")),
            ts: Number(item?.ts || 0) || undefined,
          }))
          .filter((item) => item.text)
          .slice(-MAX_SPEECH_TRANSCRIPTS)
      : [];
    this.desktopTranscriptState = {
      sentences,
      pointerPos: Number(payload?.pointerPos || 0),
      followLatest: Boolean(payload?.followLatest),
      currentDraft: this.compactInlineText(String(payload?.currentDraft || "")),
      pointerText: this.compactInlineText(String(payload?.pointerText || "")),
      updatedAt: Number(payload?.updatedAt || Date.now()),
    };
    this.snapshot.desktopTranscriptState = this.desktopTranscriptState;
    this.broadcast("transcript-state", this.desktopTranscriptState);
  }
  clearSpeechState() {
    this.speechTranscripts = [];
    this.desktopTranscriptState = {
      sentences: [],
      pointerPos: 0,
      followLatest: true,
      currentDraft: "",
      pointerText: "",
      updatedAt: Date.now(),
    };
    this.snapshot.speechTranscripts = [];
    this.snapshot.desktopTranscriptState = this.desktopTranscriptState;
    this.snapshot.draftTranscript = "";
    this.snapshot.transcripts = this.snapshot.transcripts.filter(
      (item) => item.kind !== "speech",
    );
    this.broadcast("transcript-state", this.desktopTranscriptState);
    this.broadcast("transcript-clear", {
      speechTranscripts: [],
      draftTranscript: "",
    });
  }
  async listenOnPort(port) {
    this.server = node_http_1.default.createServer((request, response) => {
      this.handleRequest(request, response);
    });
    await new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("server_not_initialized"));
        return;
      }
      this.server.once("error", reject);
      this.server.listen(port, "0.0.0.0", () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }
  handleRequest(request, response) {
    const host = request.headers.host || "127.0.0.1";
    const url = new URL(request.url || "/", `http://${host}`);
    const remoteAddress = request.socket.remoteAddress || "unknown";
    const userAgent = request.headers["user-agent"] || "unknown";
    if (url.pathname !== "/events") {
      console.log(
        `[mobile] request ${remoteAddress} ${request.method || "GET"} ${url.pathname} ua="${userAgent}"`,
      );
    }
    if (url.pathname === "/health") {
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (!this.isAuthorized(url)) {
      this.sendText(response, 403, "Invalid or missing mobile access token.");
      return;
    }
    if (url.pathname === "/" || url.pathname === "/mobile") {
      this.sendHtml(response, this.renderMobilePage());
      return;
    }
    if (url.pathname === "/snapshot") {
      this.sendJson(response, 200, this.getSnapshot());
      return;
    }
    if (url.pathname === "/events") {
      this.handleEvents(response);
      return;
    }
    if (url.pathname === "/action") {
      void this.handleActionRequest(request, response);
      return;
    }
    this.sendText(response, 404, "Not found.");
  }
  async handleActionRequest(request, response) {
    if (request.method !== "POST") {
      this.sendJson(response, 405, {
        success: false,
        error: "Method not allowed",
      });
      return;
    }
    if (!this.onAction) {
      this.sendJson(response, 503, {
        success: false,
        error: "Mobile actions unavailable",
      });
      return;
    }
    try {
      const body = await this.readJsonBody(request);
      const key = this.normalizeActionKey(body?.key);
      if (!key) {
        this.sendJson(response, 400, {
          success: false,
          error: "Unsupported key",
        });
        return;
      }
      const action = { key };
      if (key === "S") {
        const count = this.normalizeSentenceCount(body?.count);
        const text = this.getLastSpeechText(count);
        if (!text) {
          this.sendJson(response, 400, {
            success: false,
            error: "No transcript",
          });
          return;
        }
        action.textMode = "last";
        action.count = count;
        action.text = text;
      }
      const result = await this.onAction(action);
      this.sendJson(response, result.success ? 200 : 400, result);
    } catch (error) {
      this.sendJson(response, 500, {
        success: false,
        error: String(error?.message || error || "Action failed"),
      });
    }
  }
  async readJsonBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > 64 * 1024) throw new Error("request_too_large");
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  }
  normalizeActionKey(value) {
    const key = String(value || "").trim();
    if (
      key === "H" ||
      key === "Enter" ||
      key === "S" ||
      key === "D" ||
      key === "L" ||
      key === "R"
    ) {
      return key;
    }
    return null;
  }
  normalizeSentenceCount(value) {
    const count = Number(value);
    if (Number.isInteger(count) && count >= 1 && count <= 8) return count;
    return 4;
  }
  handleEvents(response) {
    const id = (0, node_crypto_1.randomBytes)(8).toString("hex");
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("\n");
    this.clients.set(id, { id, response });
    this.writeEvent(response, "connected", {
      serverTime: Date.now(),
      connectedClients: this.clients.size,
    });
    this.writeEvent(response, "snapshot", this.getSnapshot());
    console.log(`[mobile] sse connected id=${id} clients=${this.clients.size}`);
    response.on("close", () => {
      this.clients.delete(id);
    });
  }
  handleRendererEvent(channel, payload) {
    switch (channel) {
      case "voice-status":
        if (payload?.recording) {
          if (this.snapshot.status !== "generating") {
            this.snapshot.status = "listening";
          }
        } else if (this.snapshot.status === "listening") {
          this.snapshot.status = "idle";
        }
        this.broadcast("status", { status: this.snapshot.status });
        break;
      case "voice-transcript-result":
        this.addTranscript(String(payload || "").trim(), "speech");
        break;
      case "voice-transcript-delta":
        this.handleVoiceDelta(payload);
        break;
      case "screenshot-taken":
        this.addTranscript("Picture captured", "picture");
        break;
      case "initial-start":
      case "debug-start":
        this.startAnswerSession(payload);
        break;
      case "solution-progress":
        this.handleSolutionProgress(payload);
        break;
      case "solution-success":
      case "debug-success":
        this.handleSolutionSuccess(payload);
        break;
      case "solution-error":
      case "debug-error":
        if (this.isStaleAnswerPayload(payload)) return;
        this.handleAnswerError(channel, payload);
        break;
      case "processing-no-screenshots":
      case "api-key-invalid":
      case "out-of-credits":
        this.handleAnswerError(channel, payload);
        break;
      case "reset-view":
      case "reset":
        this.resetSnapshot();
        this.broadcast("reset", this.getSnapshot());
        break;
      default:
        break;
    }
  }
  handleVoiceDelta(payload) {
    const text = String(payload?.text || "").trim();
    if (!text) return;
    if (payload?.sentenceEnd) {
      this.snapshot.draftTranscript = "";
      this.addTranscript(text, "speech");
      return;
    }
    this.snapshot.draftTranscript = text;
    this.broadcast("transcript-draft", {
      text,
      sentenceId: payload?.sentenceId ?? null,
    });
  }
  startAnswerSession(payload) {
    const sessionId =
      typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : `mobile_${Date.now().toString(36)}_${(0, node_crypto_1.randomBytes)(3).toString("hex")}`;
    this.activeSessionId = sessionId;
    this.loggedStaleAnswerSessions.clear();
    this.snapshot.status = "generating";
    this.snapshot.sessionId = sessionId;
    this.snapshot.answer = "";
    this.snapshot.answerComplete = false;
    this.snapshot.lastError = undefined;
    this.broadcast("answer-reset", {
      status: this.snapshot.status,
      sessionId,
    });
  }
  getPayloadSessionId(payload) {
    return typeof payload?.sessionId === "string"
      ? payload.sessionId.trim()
      : "";
  }
  isStaleAnswerPayload(payload) {
    const sessionId = this.getPayloadSessionId(payload);
    if (!sessionId) return false;
    if (this.activeSessionId === RESET_PENDING_SESSION) {
      this.logStaleAnswerOnce("reset-pending", sessionId);
      return true;
    }
    if (!this.activeSessionId) {
      this.activeSessionId = sessionId;
      this.snapshot.sessionId = sessionId;
      return false;
    }
    if (sessionId !== this.activeSessionId) {
      this.logStaleAnswerOnce("stale", sessionId);
      return true;
    }
    return false;
  }
  logStaleAnswerOnce(reason, sessionId) {
    const key = `${reason}:${this.activeSessionId}:${sessionId}`;
    if (this.loggedStaleAnswerSessions.has(key)) return;
    this.loggedStaleAnswerSessions.add(key);
    if (reason === "reset-pending") {
      console.log(
        `[mobile] ignored answer events while reset is pending session=${sessionId}`,
      );
      return;
    }
    console.log(
      `[mobile] ignored stale answer events session=${sessionId} active=${this.activeSessionId}`,
    );
  }
  handleSolutionProgress(payload) {
    if (this.isStaleAnswerPayload(payload)) return;
    const fullContent =
      typeof payload?.fullContent === "string" ? payload.fullContent : "";
    const content = typeof payload?.content === "string" ? payload.content : "";
    if (fullContent) {
      this.snapshot.answer = this.normalizeAnswerText(fullContent);
    } else if (content) {
      this.snapshot.answer = this.normalizeAnswerText(
        this.snapshot.answer + content,
      );
    }
    this.snapshot.status = payload?.isComplete ? "complete" : "generating";
    this.snapshot.answerComplete = Boolean(payload?.isComplete);
    this.snapshot.lastError = undefined;
    this.broadcast("answer", {
      answer: this.snapshot.answer,
      status: this.snapshot.status,
      answerComplete: this.snapshot.answerComplete,
      provider: payload?.provider,
      sessionId: this.activeSessionId,
    });
  }
  handleSolutionSuccess(payload) {
    if (this.isStaleAnswerPayload(payload)) return;
    const answer = this.normalizeAnswerText(this.extractAnswerText(payload));
    if (answer) {
      this.snapshot.answer = answer;
    }
    this.snapshot.status = "complete";
    this.snapshot.answerComplete = true;
    this.snapshot.lastError = undefined;
    this.broadcast("answer", {
      answer: this.snapshot.answer,
      status: this.snapshot.status,
      answerComplete: true,
      sessionId: this.activeSessionId,
    });
  }
  handleAnswerError(channel, payload) {
    this.snapshot.status = "error";
    this.snapshot.lastError =
      typeof payload === "string" ? payload : this.describeError(channel);
    this.broadcast("error", {
      status: this.snapshot.status,
      message: this.snapshot.lastError,
      sessionId: this.activeSessionId,
    });
  }
  addTranscript(text, kind = "speech") {
    const clean = this.compactInlineText(text);
    if (!clean) return;
    if (this.isDuplicateTranscript(clean, kind)) return;
    const entry = {
      id: `${Date.now()}-${(0, node_crypto_1.randomBytes)(3).toString("hex")}`,
      text: clean,
      ts: Date.now(),
      kind,
    };
    if (kind === "speech") {
      this.speechTranscripts = [...this.speechTranscripts, entry].slice(
        -MAX_SPEECH_TRANSCRIPTS,
      );
      this.snapshot.speechTranscripts = [...this.speechTranscripts];
    }
    this.snapshot.transcripts = [...this.snapshot.transcripts, entry].slice(
      -MAX_TRANSCRIPTS,
    );
    this.broadcast("transcript", entry);
  }
  resetSnapshot() {
    this.recentTranscriptKeys.clear();
    this.snapshot = {
      status: "idle",
      sessionId: "",
      transcripts: [...this.speechTranscripts].slice(-MAX_TRANSCRIPTS),
      speechTranscripts: [...this.speechTranscripts],
      desktopTranscriptState: this.desktopTranscriptState,
      draftTranscript: "",
      answer: "",
      answerComplete: false,
    };
    this.activeSessionId = RESET_PENDING_SESSION;
    this.loggedStaleAnswerSessions.clear();
  }
  getLastSpeechText(count) {
    const source = this.desktopTranscriptState?.sentences?.length
      ? this.desktopTranscriptState.sentences
      : this.speechTranscripts;
    return source
      .slice(-count)
      .map((item) => this.compactInlineText(item.text))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  extractAnswerText(payload) {
    if (!payload) return "";
    if (typeof payload === "string") return payload;
    if (Array.isArray(payload)) {
      return payload
        .map((item, index) => {
          const text = this.extractAnswerText(item);
          return text ? `Answer ${index + 1}:\n${text}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
    }
    const direct =
      payload.fullContent ||
      payload.raw ||
      payload.debug_analysis ||
      payload.debugAnalysis ||
      payload.solution ||
      payload.solution_code ||
      payload.code ||
      payload.answer;
    if (typeof direct === "string") return direct;
    const parts = [];
    const problem =
      payload.problem_statement || payload.problem || payload.description;
    const explanation =
      payload.explanation || payload.thoughts || payload.analysis;
    const time = payload.time_complexity || payload.timeComplexity;
    const space = payload.space_complexity || payload.spaceComplexity;
    if (problem) parts.push(`Problem:\n${this.toText(problem)}`);
    if (explanation) parts.push(`Explanation:\n${this.toText(explanation)}`);
    if (time || space) {
      parts.push(
        [
          "Complexity:",
          time ? `Time: ${this.toText(time)}` : "",
          space ? `Space: ${this.toText(space)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    if (parts.length > 0) return parts.join("\n\n");
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }
  toText(value) {
    if (Array.isArray(value))
      return value.map((item) => this.toText(item)).join("\n");
    if (typeof value === "object") {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value ?? "");
  }
  compactInlineText(text) {
    return String(text || "")
      .replace(/\\r\\n/g, " ")
      .replace(/\\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  normalizeAnswerText(text) {
    const decoded = String(text || "")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
    return this.stripOuterAnswerJsonBraces(decoded)
      .replace(/(^|\n)\s*"?problem_statement"?\s*:\s*/gi, "$1Problem:\n")
      .replace(/(^|\n)\s*"?explanation"?\s*:\s*/gi, "$1Explanation:\n")
      .replace(/(^|\n)\s*"?solution"?\s*:\s*/gi, "$1Solution:\n")
      .replace(/(^|\n)\s*"?time_complexity"?\s*:\s*/gi, "$1Time Complexity: ")
      .replace(/(^|\n)\s*"?space_complexity"?\s*:\s*/gi, "$1Space Complexity: ")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .join("\n")
      .trim();
  }
  stripOuterAnswerJsonBraces(text) {
    const lines = String(text || "").split(/\r?\n/);
    const first = lines.findIndex((line) => line.trim() !== "");
    const lastFromEnd = [...lines]
      .reverse()
      .findIndex((line) => line.trim() !== "");
    if (first < 0 || lastFromEnd < 0) return text;
    const last = lines.length - 1 - lastFromEnd;
    const inner = lines.slice(first + 1, last).join("\n");
    const looksLikeAnswerJson =
      /(^|\n)\s*"?(?:problem_statement|solution|solution_code|code|explanation|time_complexity|space_complexity)"?\s*:/i.test(
        inner,
      );
    if (
      lines[first].trim() === "{" &&
      lines[last].trim() === "}" &&
      looksLikeAnswerJson
    ) {
      return [
        ...lines.slice(0, first),
        ...lines.slice(first + 1, last),
        ...lines.slice(last + 1),
      ].join("\n");
    }
    if (lines[first].trim() === "{") {
      return [...lines.slice(0, first), ...lines.slice(first + 1)].join("\n");
    }
    return text;
  }
  isDuplicateTranscript(text, kind) {
    const now = Date.now();
    for (const [key, ts] of this.recentTranscriptKeys.entries()) {
      if (now - ts > 5000) this.recentTranscriptKeys.delete(key);
    }
    const key = `${kind || "speech"}:${text.toLowerCase()}`;
    const last = this.recentTranscriptKeys.get(key);
    if (last && now - last < 2500) return true;
    this.recentTranscriptKeys.set(key, now);
    return false;
  }
  describeError(channel) {
    if (channel === "processing-no-screenshots")
      return "No screenshots or text to process.";
    if (channel === "api-key-invalid") return "API key is invalid.";
    if (channel === "out-of-credits") return "Out of credits.";
    return "Processing failed.";
  }
  isAuthorized(url) {
    // First read-only version favors easy LAN access. Keep the token in getInfo()
    // so we can re-enable gated access later without changing the IPC shape.
    return true;
  }
  getAccessUrls() {
    if (!this.port) return [];
    const candidates = this.getLanAddressCandidates();
    return candidates.map(
      (candidate) => `http://${candidate.address}:${this.port}/mobile`,
    );
  }
  getLanAddressCandidates() {
    const candidates = [];
    const interfaces = node_os_1.default.networkInterfaces();
    for (const [interfaceName, items] of Object.entries(interfaces)) {
      for (const item of items || []) {
        if (item.family !== "IPv4" || item.internal) continue;
        if (this.isLinkLocalAddress(item.address)) continue;
        candidates.push({
          address: item.address,
          interfaceName,
          score: this.scoreLanCandidate(interfaceName, item.address),
        });
      }
    }
    if (candidates.length === 0) {
      return [{ address: "127.0.0.1", interfaceName: "loopback", score: -999 }];
    }
    return candidates.sort((a, b) => b.score - a.score);
  }
  isLinkLocalAddress(address) {
    return address.startsWith("169.254.");
  }
  isPrivateLanAddress(address) {
    if (address.startsWith("10.")) return true;
    if (address.startsWith("192.168.")) return true;
    const match = /^172\.(\d+)\./.exec(address);
    if (!match) return false;
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  scoreLanCandidate(interfaceName, address) {
    const name = interfaceName.toLowerCase();
    let score = 0;
    if (this.isPrivateLanAddress(address)) score += 20;
    if (address.startsWith("192.168.")) score += 10;
    if (address.startsWith("10.")) score += 8;
    if (/^172\./.test(address)) score += 4;
    if (
      name.includes("wlan") ||
      name.includes("wi-fi") ||
      name.includes("wifi") ||
      name.includes("wireless") ||
      name.includes("无线")
    ) {
      score += 100;
    }
    if (name.includes("ethernet") || name.includes("以太网")) {
      score += 60;
    }
    if (
      name.includes("vmware") ||
      name.includes("virtual") ||
      name.includes("vethernet") ||
      name.includes("hyper-v") ||
      name.includes("wsl") ||
      name.includes("docker") ||
      name.includes("virtualbox") ||
      name.includes("bluetooth") ||
      name.includes("蓝牙") ||
      name.includes("tailscale") ||
      name.includes("zerotier")
    ) {
      score -= 200;
    }
    // Host-only virtual adapters are often .1; real Wi-Fi client addresses rarely are.
    if (address.endsWith(".1")) score -= 30;
    if (address.startsWith("198.18.") || address.startsWith("198.19."))
      score -= 100;
    return score;
  }
  logNetworkCandidates() {
    if (!this.port) return;
    const candidates = this.getLanAddressCandidates();
    candidates.forEach((candidate, index) => {
      console.log(
        `[mobile] candidate#${index + 1} http://${candidate.address}:${this.port}/mobile ` +
          `interface="${candidate.interfaceName}" score=${candidate.score}`,
      );
    });
  }
  writeEvent(response, type, payload) {
    const event = { type, ts: Date.now(), payload };
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  sendHtml(response, html) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(html);
  }
  sendJson(response, status, data) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(data));
  }
  sendText(response, status, text) {
    response.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(text);
  }
  renderMobilePage() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Mobile Companion</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef3f8;
      --surface: #fbfdff;
      --line: #cbd7e5;
      --text: #102033;
      --muted: #64748b;
      --accent: #0f766e;
      --accent-soft: #d7f1eb;
      --code-bg: #0f172a;
      --code-text: #dbeafe;
      --code-line: #26344f;
      --ok: #059669;
      --warn: #b45309;
      --err: #dc2626;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; background: var(--bg); color: var(--text); }
    body { min-height: 100vh; overflow: hidden; }
    .app { height: 100vh; display: flex; flex-direction: column; padding: max(5px, env(safe-area-inset-top)) 6px 5px; gap: 3px; }
    .status { position: fixed; right: 8px; top: 6px; z-index: 3; display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 10px; white-space: nowrap; opacity: 0.62; transition: opacity 160ms ease; }
    .status.compact { gap: 0; opacity: 0.72; }
    .status.compact #connection { display: none; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--warn); }
    .dot.connected { background: var(--ok); }
    .dot.error { background: var(--err); }
    .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 7px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }
    .transcript { position: relative; min-height: 54px; max-height: 110px; overflow: hidden; }
    .transcript-list { height: 100%; padding: 5px 6px 20px; overflow: auto; font-size: 10.5px; line-height: 1.18; color: #1f2937; }
    .transcript-flow { overflow-wrap: anywhere; }
    .speech-row { display: inline; padding: 1px 3px; border-radius: 4px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .speech-row.pointer { background: rgba(219, 234, 254, 0.48); color: #1e40af; }
    .speech-row.in-send-range:not(.pointer) { background: rgba(219, 234, 254, 0.24); }
    .speech-index { display: none; }
    .speech-text { min-width: 0; }
    .separator { color: var(--muted); margin: 0 4px; }
    .picture { color: var(--muted); font-weight: 600; }
    .draft { color: var(--muted); font-style: italic; }
    .answer { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .answer-head { display: none; }
    .answer-title { font-size: 12px; font-weight: 700; }
    .answer-state { color: var(--muted); font-size: 12px; }
    .answer-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 6px 52px; font-size: 12px; line-height: 1.22; overflow-wrap: anywhere; }
    .answer-body h3 { margin: 6px 0 2px; font-size: 11px; line-height: 1.18; color: #0f766e; }
    .answer-body h3:first-child { margin-top: 0; }
    .answer-body p { margin: 0 0 5px; white-space: pre-wrap; }
    .answer-body pre { margin: 4px 0 5px; padding: 6px; border-radius: 7px; background: var(--code-bg); color: var(--code-text); border: 1px solid var(--code-line); overflow-x: hidden; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .answer-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 11px; line-height: 1.22; tab-size: 2; overflow-wrap: anywhere; word-break: break-word; }
    .answer-body :not(pre) > code { padding: 1px 4px; border-radius: 4px; background: var(--accent-soft); color: #134e4a; }
    .kw { color: #93c5fd; }
    .str { color: #86efac; }
    .num { color: #fbbf24; }
    .com { color: #94a3b8; font-style: italic; }
    .code-lang { margin: 5px 0 -1px; color: var(--muted); font-size: 10px; text-transform: uppercase; }
    .kv { color: #334155; }
    .kv strong { color: #0f766e; }
    .empty { color: var(--muted); }
    .error-text { color: var(--err); }
    .command-shell { position: fixed; left: max(6px, env(safe-area-inset-left)); right: max(6px, env(safe-area-inset-right)); bottom: max(5px, env(safe-area-inset-bottom)); z-index: 4; padding: 4px; background: rgba(248, 250, 252, 0.72); border: 1px solid rgba(203, 213, 225, 0.86); border-radius: 7px; backdrop-filter: blur(8px); }
    .action-status { height: 0; margin: 0; color: var(--muted); font-size: 10px; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .action-status:not(:empty) { height: 12px; margin: 0 1px 3px; }
    .action-status.error { color: var(--err); }
    .command-bar { display: grid; grid-template-columns: 0.95fr 1.35fr 0.95fr 0.95fr 0.95fr 0.95fr; gap: 5px; }
    .key-button { min-height: 34px; border: 1px solid #cbd5e1; border-radius: 7px; background: #ffffff; color: #334155; font-size: 12.5px; font-weight: 700; letter-spacing: 0; touch-action: manipulation; }
    .key-button:active { background: #e2e8f0; }
    .key-button.danger { color: #b91c1c; border-color: #fecaca; background: #fff7f7; }
    .s-button { display: flex; align-items: center; justify-content: center; }
    .transcript-mode { position: absolute; right: 5px; bottom: 4px; z-index: 2; display: inline-grid; grid-template-columns: 16px 16px 16px; align-items: center; height: 18px; border: 1px solid rgba(20, 184, 166, 0.22); border-radius: 999px; background: rgba(204, 251, 241, 0.9); color: #0f766e; overflow: hidden; }
    .count-button { width: 16px; height: 18px; border: 0; padding: 0; background: transparent; color: #0f766e; font-size: 9px; font-weight: 800; line-height: 18px; touch-action: manipulation; }
    .count-button:active { background: #99f6e4; }
    .count-value { min-width: 16px; text-align: center; font-size: 10px; font-weight: 800; line-height: 18px; }
    @media (min-width: 760px) {
      .app { max-width: 760px; margin: 0 auto; }
      .transcript { max-height: 132px; }
      .answer-body { font-size: 15px; }
      .command-shell { left: 50%; right: auto; width: min(746px, calc(100vw - 12px)); transform: translateX(-50%); }
    }
    @media (max-width: 360px) {
      .command-bar { gap: 4px; }
      .key-button { font-size: 12px; min-height: 32px; }
    }
  </style>
</head>
<body>
  <main class="app">
    <div id="status" class="status"><span id="dot" class="dot"></span><span id="connection">Connecting</span></div>

    <section class="panel transcript">
      <div id="s-mode" class="transcript-mode">
        <button id="s-count-up" class="count-button" type="button">▲</button>
        <span id="s-count-value" class="count-value">4</span>
        <button id="s-count-down" class="count-button" type="button">▼</button>
      </div>
      <div id="transcript-list" class="transcript-list">
        <div class="empty">Waiting for speech...</div>
      </div>
    </section>

    <section class="panel answer">
      <div class="answer-head">
        <div class="answer-title">AI Answer</div>
        <div id="answer-state" class="answer-state">Idle</div>
      </div>
      <div id="answer-body" class="answer-body">
        <span class="empty">AI output will appear here.</span>
      </div>
    </section>

    <section class="command-shell">
      <div id="action-status" class="action-status"></div>
      <div class="command-bar">
        <button id="key-l" class="key-button" type="button">L</button>
        <button id="key-r" class="key-button danger" type="button">R</button>
        <button id="key-h" class="key-button" type="button">H</button>
        <button id="key-enter" class="key-button" type="button">Enter</button>
        <button id="key-s" class="key-button s-button" type="button">S</button>
        <button id="key-d" class="key-button" type="button">D</button>
      </div>
    </section>

  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const state = {
      status: "idle",
      sessionId: "",
      connected: false,
      transcripts: [],
      speechTranscripts: [],
      desktopTranscriptState: null,
      draftTranscript: "",
      answer: "",
      answerComplete: false,
      lastError: "",
      sCount: 4,
      actionStatus: "",
      actionStatusKind: "",
      connectionLabelVisible: true
    };

    const statusIndicator = document.getElementById("status");
    const dot = document.getElementById("dot");
    const connection = document.getElementById("connection");
    const transcriptList = document.getElementById("transcript-list");
    const answerBody = document.getElementById("answer-body");
    const answerState = document.getElementById("answer-state");
    const actionStatus = document.getElementById("action-status");
    const sMode = document.getElementById("s-mode");
    const sCountUp = document.getElementById("s-count-up");
    const sCountDown = document.getElementById("s-count-down");
    const sCountValue = document.getElementById("s-count-value");
    const keyH = document.getElementById("key-h");
    const keyEnter = document.getElementById("key-enter");
    const keyS = document.getElementById("key-s");
    const keyD = document.getElementById("key-d");
    const keyL = document.getElementById("key-l");
    const keyR = document.getElementById("key-r");
    let actionStatusTimer = null;
    let connectionLabelTimer = null;
    let sModeLongPressTimer = null;
    let sModeLongPressed = false;

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function timeText(ts) {
      try {
        return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch {
        return "";
      }
    }

    function statusLabel(status) {
      if (status === "listening") return "Listening";
      if (status === "generating") return "Generating";
      if (status === "complete") return "Complete";
      if (status === "error") return "Error";
      return "Idle";
    }

    function compactInlineText(value) {
      return String(value || "")
        .replace(/\\\\r\\\\n/g, " ")
        .replace(/\\\\n/g, " ")
        .replace(/\\s+/g, " ")
        .trim();
    }

    function normalizeAnswerText(value) {
      return stripOuterAnswerJsonBraces(String(value || "")
        .replace(/\\\\r\\\\n/g, "\\n")
        .replace(/\\\\r/g, "\\n")
        .replace(/\\\\n/g, "\\n")
        .replace(/\\\\t/g, "\\t"))
        .split(/\\r?\\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== "")
        .join("\\n")
        .trim();
    }

    function stripOuterAnswerJsonBraces(value) {
      const lines = String(value || "").split(/\\r?\\n/);
      const first = lines.findIndex((line) => line.trim() !== "");
      const lastFromEnd = [...lines].reverse().findIndex((line) => line.trim() !== "");
      if (first < 0 || lastFromEnd < 0) return value;

      const last = lines.length - 1 - lastFromEnd;
      const inner = lines.slice(first + 1, last).join("\\n");
      const looksLikeAnswerJson = /(^|\\n)\\s*"?(?:problem_statement|solution|solution_code|code|explanation|time_complexity|space_complexity)"?\\s*:/i.test(inner);

      if (lines[first].trim() === "{" && lines[last].trim() === "}" && looksLikeAnswerJson) {
        return [...lines.slice(0, first), ...lines.slice(first + 1, last), ...lines.slice(last + 1)].join("\\n");
      }

      if (lines[first].trim() === "{") {
        return [...lines.slice(0, first), ...lines.slice(first + 1)].join("\\n");
      }

      return value;
    }

    function renderInline(value) {
      return escapeHtml(value).replace(/\`([^\\n\`]+)\`/g, '<code>$1</code>');
    }

    function highlightCode(value) {
      return String(value || "")
        .split("\\n")
        .map(highlightCodeLine)
        .join("\\n");
    }

    function highlightPlainCode(value) {
      const raw = String(value || "");
      const token = /\\b(function|return|const|let|var|if|else|for|while|class|def|import|from|public|private|static|void|int|string|boolean|true|false|null|None|new|try|catch|finally|switch|case|break|continue|async|await)\\b|-?\\b\\d+(?:\\.\\d+)?\\b/g;
      let html = "";
      let last = 0;
      let match;

      while ((match = token.exec(raw)) !== null) {
        if (match.index > last) html += escapeHtml(raw.slice(last, match.index));
        const value = match[0];
        if (/^-?\\d/.test(value)) {
          html += '<span class="num">' + escapeHtml(value) + '</span>';
        } else {
          html += '<span class="kw">' + escapeHtml(value) + '</span>';
        }
        last = token.lastIndex;
      }

      if (last < raw.length) html += escapeHtml(raw.slice(last));
      return html;
    }

    function highlightCodeLine(line) {
      const raw = String(line || "");
      const commentIndex = findCommentIndex(raw);
      const codePart = commentIndex >= 0 ? raw.slice(0, commentIndex) : raw;
      const commentPart = commentIndex >= 0 ? raw.slice(commentIndex) : "";
      const highlightedCode = highlightStringsAndPlainCode(codePart);
      const highlightedComment = commentPart
        ? '<span class="com">' + escapeHtml(commentPart) + '</span>'
        : "";
      return highlightedCode + highlightedComment;
    }

    function findCommentIndex(line) {
      let quote = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const prev = i > 0 ? line[i - 1] : "";
        if (quote) {
          if (ch === quote && prev !== "\\\\") quote = "";
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === "#") return i;
        if (ch === "/" && line[i + 1] === "/") return i;
      }
      return -1;
    }

    function highlightStringsAndPlainCode(value) {
      const raw = String(value || "");
      const pieces = [];
      let quote = "";
      let start = 0;
      let last = 0;

      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        const prev = i > 0 ? raw[i - 1] : "";
        if (!quote && (ch === '"' || ch === "'")) {
          if (i > last) pieces.push({ type: "plain", value: raw.slice(last, i) });
          quote = ch;
          start = i;
          continue;
        }
        if (quote && ch === quote && prev !== "\\\\") {
          pieces.push({ type: "string", value: raw.slice(start, i + 1) });
          quote = "";
          last = i + 1;
        }
      }

      if (quote) {
        pieces.push({ type: "plain", value: raw.slice(last) });
      } else if (last < raw.length) {
        pieces.push({ type: "plain", value: raw.slice(last) });
      }

      return pieces
        .map((piece) => {
          if (piece.type === "string") {
            return '<span class="str">' + escapeHtml(piece.value) + '</span>';
          }
          return highlightPlainCode(piece.value);
        })
        .join("");
    }

    function renderCodeBlock(value, lang) {
      const label = lang ? '<div class="code-lang">' + escapeHtml(lang) + '</div>' : "";
      return label + '<pre><code>' + highlightCode(String(value || "").replace(/^\\n+|\\n+$/g, "")) + '</code></pre>';
    }

    function getHeaderLabel(line) {
      const clean = String(line || "").trim();
      const header = /^(Problem|Explanation|Solution|Complexity|Time Complexity|Space Complexity|Answer \\d+):?$/i.exec(clean);
      return header ? clean.replace(/:$/, "") : "";
    }

    function isLikelyCodeLine(line) {
      const raw = String(line || "");
      const clean = raw.trim();
      if (!clean) return false;
      if (/^\\s{2,}\\S/.test(raw)) return true;
      if (/^(def|class|function|const|let|var|import|from|public|private|static|for|while|if|else|return|try|catch|switch|case)\\b/.test(clean)) return true;
      if (/^[}\\])]+$/.test(clean)) return true;
      if (/[{};]/.test(clean)) return true;
      if (/^[A-Za-z_$][\\w$]*\\s*=/.test(clean)) return true;
      return false;
    }

    function renderTextPart(value) {
      const lines = String(value || "")
        .split(/\\n/)
        .filter((line) => line.trim() !== "");
      let html = "";
      let codeLines = [];
      let inSolution = false;

      const flushCode = () => {
        if (codeLines.length === 0) return;
        html += renderCodeBlock(codeLines.join("\\n"), "");
        codeLines = [];
      };

      for (const rawLine of lines) {
        const clean = rawLine.trim();
        const header = getHeaderLabel(rawLine);
        if (header) {
          flushCode();
          inSolution = /^(Solution|Answer \\d+)/i.test(header);
          html += '<h3>' + escapeHtml(header) + '</h3>';
          continue;
        }

        const kv = /^(Time Complexity|Space Complexity|Time|Space):\\s*(.+)$/i.exec(clean);
        if (kv) {
          flushCode();
          inSolution = false;
          html += '<p class="kv"><strong>' + escapeHtml(kv[1]) + ':</strong> ' + renderInline(kv[2]) + '</p>';
          continue;
        }

        if (isLikelyCodeLine(rawLine) || (inSolution && codeLines.length > 0)) {
          codeLines.push(rawLine);
          continue;
        }

        flushCode();
        html += '<p>' + renderInline(clean) + '</p>';
      }

      flushCode();
      return html;
    }

    function renderAnswer(value) {
      const text = normalizeAnswerText(value);
      if (!text) return '<span class="empty">AI output will appear here.</span>';

      const parts = [];
      const fence = /\`\`\`([^\\n]*)\\n?([\\s\\S]*?)\`\`\`/g;
      let lastIndex = 0;
      let match;
      while ((match = fence.exec(text)) !== null) {
        if (match.index > lastIndex) parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
        parts.push({ type: "code", lang: (match[1] || "").trim(), value: match[2] || "" });
        lastIndex = fence.lastIndex;
      }
      if (lastIndex < text.length) parts.push({ type: "text", value: text.slice(lastIndex) });

      return parts.map((part) => {
        if (part.type === "code") {
          return renderCodeBlock(part.value, part.lang);
        }

        return renderTextPart(part.value);
      }).join("");
    }

    function normalizedCompare(value) {
      return compactInlineText(value).toLowerCase();
    }

    function getSpeechRows() {
      const desktop = state.desktopTranscriptState;
      if (desktop && Array.isArray(desktop.sentences) && desktop.sentences.length) {
        return desktop.sentences.map((item, index) => ({
          id: item.id || String(index),
          text: item.text || "",
          ts: item.ts || 0,
          sourceIndex: index
        }));
      }
      return (state.speechTranscripts || []).map((item, index) => ({
        id: item.id || String(index),
        text: item.text || "",
        ts: item.ts || 0,
        sourceIndex: index
      }));
    }

    function getPointerTextSet(rows) {
      const desktop = state.desktopTranscriptState;
      if (desktop && Array.isArray(desktop.sentences) && desktop.sentences.length) {
        const selected = new Set();
        const pointerPos = Math.max(0, Number(desktop.pointerPos || 0));
        if (pointerPos % 2 === 0) {
          const lineIndex = Math.floor(pointerPos / 2);
          rows.forEach((row, index) => {
            if (row.sourceIndex === lineIndex) selected.add(index);
          });
        } else {
          const before = Math.floor(pointerPos / 2);
          const after = before + 1;
          rows.forEach((row, index) => {
            if (row.sourceIndex === before || row.sourceIndex === after) selected.add(index);
          });
        }
        if (selected.size) return selected;
      }

      const pointerText = state.desktopTranscriptState?.pointerText || "";
      const cleanPointer = normalizedCompare(pointerText);
      if (!cleanPointer) return new Set();

      const selected = new Set();
      rows.forEach((row, index) => {
        const cleanRow = normalizedCompare(row.text);
        if (cleanRow && (cleanPointer === cleanRow || cleanPointer.includes(cleanRow))) {
          selected.add(index);
        }
      });
      return selected;
    }

    function renderTranscriptRows() {
    const speechRows = getSpeechRows().slice(-8);
    const pointerSet = getPointerTextSet(speechRows);
    const sendStart = Math.max(0, speechRows.length - state.sCount);
    const rows = speechRows.map((item, index) => {
      const klass = [
          "speech-row",
        pointerSet.has(index) ? "pointer" : "",
        index >= sendStart ? "in-send-range" : ""
      ].filter(Boolean).join(" ");
      return '<span class="' + klass + '">' + escapeHtml(compactInlineText(item.text)) + '</span>';
    });

    if (state.draftTranscript) {
      rows.push('<span class="speech-row draft">' + escapeHtml(compactInlineText(state.draftTranscript)) + '</span>');
    }

      return rows;
    }

    function setActionStatus(message, kind) {
      state.actionStatus = message || "";
      state.actionStatusKind = kind || "";
      if (actionStatusTimer) clearTimeout(actionStatusTimer);
      if (message) {
        actionStatusTimer = setTimeout(() => {
          state.actionStatus = "";
          state.actionStatusKind = "";
          render();
        }, 5000);
      }
      render();
    }

    function showConnectionLabel() {
      state.connectionLabelVisible = true;
      if (connectionLabelTimer) clearTimeout(connectionLabelTimer);
      connectionLabelTimer = setTimeout(() => {
        state.connectionLabelVisible = false;
        render();
      }, 1800);
      render();
    }

    async function postAction(key) {
      const payload = { key };
      if (key === "S") {
        payload.textMode = "last";
        payload.count = state.sCount;
      }
      const response = await fetch("/action?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({ success: false, error: "Bad response" }));
      if (!result.success) throw new Error(result.error || "Action failed");
      return result;
    }

    async function runAction(key) {
      try {
        if (key === "H") {
          setActionStatus("Capturing...", "");
          await postAction(key);
          return;
        }

        setActionStatus(key + " accepted", "");
        const result = await postAction(key);
        setActionStatus(result.message || key + " accepted", "");
      } catch (error) {
        setActionStatus(error?.message || "Failed", "error");
      }
    }

    function cycleSMode() {
      const modes = [1, 2, 3, 4, 5, 6, 7, 8];
      const index = modes.indexOf(state.sCount);
      state.sCount = modes[(index + 1) % modes.length];
      setActionStatus("S mode: last " + state.sCount, "");
      render();
    }

    function adjustSMode(delta) {
      const next = Math.max(1, Math.min(8, state.sCount + delta));
      if (next === state.sCount) return;
      state.sCount = next;
      setActionStatus("S mode: last " + state.sCount, "");
      render();
    }

    function render() {
      if (statusIndicator) {
        statusIndicator.className = "status" + (state.connectionLabelVisible ? "" : " compact");
      }
      dot.className = "dot" + (state.connected ? " connected" : "") + (state.status === "error" ? " error" : "");
      connection.textContent = state.connected ? "Connected" : "Reconnecting";
      answerState.textContent = statusLabel(state.status);

      const rows = renderTranscriptRows();
      transcriptList.innerHTML = rows.length
        ? '<div class="transcript-flow">' + rows.join(' ') + '</div>'
        : '<div class="empty">Waiting for speech...</div>';
      transcriptList.scrollTop = transcriptList.scrollHeight;

      if (state.status === "error" && state.lastError && !state.answer) {
        answerBody.innerHTML = '<span class="error-text">' + escapeHtml(state.lastError) + '</span>';
      } else if (state.answer) {
        answerBody.innerHTML = renderAnswer(state.answer);
      } else {
        answerBody.innerHTML = '<span class="empty">AI output will appear here.</span>';
      }
      if (state.status === "generating" || state.answerComplete) {
        answerBody.scrollTop = answerBody.scrollHeight;
      }

      if (sCountValue) sCountValue.textContent = String(state.sCount);
      if (actionStatus) {
        actionStatus.textContent = state.actionStatus || "";
        actionStatus.className = "action-status" + (state.actionStatusKind === "error" ? " error" : "");
      }
    }

    function applySnapshot(payload) {
      state.status = payload.status || "idle";
      state.sessionId = payload.sessionId || "";
      state.transcripts = Array.isArray(payload.transcripts) ? payload.transcripts : [];
      state.speechTranscripts = Array.isArray(payload.speechTranscripts) ? payload.speechTranscripts : state.transcripts.filter((item) => item.kind === "speech");
      state.desktopTranscriptState = payload.desktopTranscriptState || null;
      state.draftTranscript = payload.draftTranscript || "";
      state.answer = normalizeAnswerText(payload.answer || "");
      state.answerComplete = !!payload.answerComplete;
      state.lastError = payload.lastError || "";
      render();
    }

    function applyEvent(event) {
      const payload = event.payload || {};
      if (event.type === "connected") {
        const wasConnected = state.connected;
        state.connected = true;
        if (!wasConnected) showConnectionLabel();
      } else if (event.type === "snapshot" || event.type === "reset") {
        applySnapshot(payload);
        return;
      } else if (event.type === "status") {
        state.status = payload.status || state.status;
      } else if (event.type === "transcript") {
        state.draftTranscript = "";
        state.transcripts.push(payload);
        state.transcripts = state.transcripts.slice(-8);
        if (payload.kind === "speech") {
          state.speechTranscripts.push(payload);
          state.speechTranscripts = state.speechTranscripts.slice(-16);
        } else if (payload.kind === "picture") {
          setActionStatus(payload.text || "Picture captured", "");
        }
      } else if (event.type === "transcript-draft") {
        state.draftTranscript = payload.text || "";
      } else if (event.type === "transcript-state") {
        state.desktopTranscriptState = payload || null;
      } else if (event.type === "transcript-clear") {
        state.speechTranscripts = [];
        state.draftTranscript = "";
        state.desktopTranscriptState = {
          sentences: [],
          pointerPos: 0,
          followLatest: true,
          currentDraft: "",
          pointerText: "",
          updatedAt: Date.now()
        };
        state.transcripts = state.transcripts.filter((item) => item.kind !== "speech");
      } else if (event.type === "answer-reset") {
        state.sessionId = payload.sessionId || "";
        state.status = payload.status || "generating";
        state.answer = "";
        state.answerComplete = false;
        state.lastError = "";
      } else if (event.type === "answer") {
        if (payload.sessionId && state.sessionId && payload.sessionId !== state.sessionId) return;
        if (payload.sessionId && !state.sessionId) state.sessionId = payload.sessionId;
        state.status = payload.status || state.status;
        state.answer = normalizeAnswerText(payload.answer || "");
        state.answerComplete = !!payload.answerComplete;
        state.lastError = "";
      } else if (event.type === "error") {
        if (payload.sessionId && state.sessionId && payload.sessionId !== state.sessionId) return;
        state.status = "error";
        state.lastError = payload.message || "Processing failed.";
      }
      render();
    }

    function connect() {
      const source = new EventSource("/events?token=" + encodeURIComponent(token));
      source.onmessage = (message) => {
        try {
          applyEvent(JSON.parse(message.data));
        } catch (error) {
          console.warn("Bad mobile event", error);
        }
      };
      source.onerror = () => {
        const wasConnected = state.connected;
        state.connected = false;
        if (wasConnected) {
          showConnectionLabel();
        } else {
          render();
        }
      };
    }

    render();
    showConnectionLabel();
    keyH.addEventListener("click", () => runAction("H"));
    keyEnter.addEventListener("click", () => runAction("Enter"));

    function clearSModeLongPressTimer() {
      if (sModeLongPressTimer) {
        clearTimeout(sModeLongPressTimer);
        sModeLongPressTimer = null;
      }
    }

    keyS.addEventListener("pointerdown", () => {
      sModeLongPressed = false;
      clearSModeLongPressTimer();
      sModeLongPressTimer = setTimeout(() => {
        sModeLongPressed = true;
        cycleSMode();
      }, 560);
    });
    keyS.addEventListener("pointerup", () => {
      clearSModeLongPressTimer();
      if (!sModeLongPressed) runAction("S");
    });
    keyS.addEventListener("pointerleave", clearSModeLongPressTimer);
    keyS.addEventListener("pointercancel", clearSModeLongPressTimer);
    keyS.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
    sCountUp.addEventListener("click", (event) => {
      event.stopPropagation();
      adjustSMode(1);
    });
    sCountDown.addEventListener("click", (event) => {
      event.stopPropagation();
      adjustSMode(-1);
    });
    keyD.addEventListener("click", () => runAction("D"));
    keyL.addEventListener("click", () => runAction("L"));
    keyR.addEventListener("click", () => runAction("R"));
    connect();
  </script>
</body>
</html>`;
  }
}
exports.MobileBridge = MobileBridge;
