"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.configBackupHelper = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_util_1 = require("node:util");
const node_crypto_1 = require("node:crypto");
const electron_1 = require("electron");
const ConfigHelper_1 = require("./ConfigHelper");
const DomesticLicenseService_1 = require("./DomesticLicenseService");
const AppRegion_1 = require("./AppRegion");
const ClientServiceHttp_1 = require("./ClientServiceHttp");
const MAX_CONFIG = 512 * 1024;
const MAX_BODY = 1024 * 1024;
const RETRIES = [30000, 120000, 600000];
// One coalesced task, one bounded snapshot and one request; never awaits from config save.
class ConfigBackupHelper {
  constructor() {
    this.started = false;
    this.timer = null;
    this.controller = null;
    this.pending = false;
    this.generation = 0;
    this.retries = 0;
    this.lastSuccess = "";
    this.lastLog = 0;
  }
  start() {
    if (this.started || (0, AppRegion_1.getAppRegion)() !== "domestic") return;
    this.started = true;
    ConfigHelper_1.configHelper.on("config-saved", () => this.schedule());
    DomesticLicenseService_1.domesticLicenseService.on("changed", () => {
      ++this.generation;
      this.controller?.abort();
      this.lastSuccess = "";
      this.schedule();
    });
    electron_1.app.once("before-quit", () => {
      this.started = false;
      if (this.timer) clearTimeout(this.timer);
      this.controller?.abort();
    });
    this.schedule();
  }
  schedule(delay = 5000, retry = false) {
    if (!this.started) return;
    if (!retry) this.retries = 0;
    this.pending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.controller) void this.upload();
    }, delay);
    this.timer.unref();
  }
  async upload() {
    const access = DomesticLicenseService_1.domesticLicenseService.access();
    if (!this.started || !access || !this.pending) return;
    this.pending = false;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    let retryDelay;
    try {
      const file = await promises_1.default.open(
        ConfigHelper_1.configHelper.getConfigPath(),
        "r",
      );
      let bytes;
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size === 0 || before.size > MAX_CONFIG)
          return;
        const buffer = Buffer.alloc(MAX_CONFIG + 1);
        let total = 0;
        while (total < buffer.length) {
          const read = await file.read(
            buffer,
            total,
            buffer.length - total,
            null,
          );
          if (!read.bytesRead) break;
          total += read.bytesRead;
        }
        const after = await file.stat();
        if (
          total > MAX_CONFIG ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          return;
        bytes = buffer.subarray(0, total);
      } finally {
        await file.close();
      }
      if (generation !== this.generation || controller.signal.aborted) return;
      let text;
      try {
        text = new node_util_1.TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        return;
      } // Invalid file encoding is permanent until the next local change.
      if (!text.trim() || text.includes("\0")) return;
      const hash = (0, node_crypto_1.createHash)("sha256")
        .update(bytes)
        .digest("hex");
      const identity = access.code + ":" + hash;
      if (identity === this.lastSuccess) return;
      const body = {
        code: access.code,
        config_text: text,
        client_version: electron_1.app.getVersion(),
      };
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY) return;
      // Reading may outlive expiration/revocation. Recheck identity immediately before sending.
      if (
        DomesticLicenseService_1.domesticLicenseService.access()?.code !==
        access.code
      )
        return;
      const response = await (0, ClientServiceHttp_1.serviceRequest)(
        "/api/client-backups/config",
        body,
        controller.signal,
      );
      if (generation !== this.generation) return;
      if (response.status === 200 && response.data?.content_sha256 === hash) {
        this.lastSuccess = identity;
        this.retries = 0;
      } else if (response.status === 429 || response.status >= 500) {
        const seconds = Number(response.retryAfter);
        retryDelay =
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds * 1000, 600000)
            : undefined;
        this.retry(retryDelay);
      }
      // Permanent 4xx, redirects and malformed success are silent; await a new change/start.
    } catch {
      if (!controller.signal.aborted && generation === this.generation) {
        // Throttled internal diagnostic, no response body, card or configuration.
        if (Date.now() - this.lastLog > 60000) {
          console.warn("[config-backup] background transfer deferred");
          this.lastLog = Date.now();
        }
        this.retry();
      }
    } finally {
      this.controller = null;
      if (this.pending && !this.timer && this.started)
        this.schedule(5000, true);
    }
  }
  retry(minimum) {
    if (this.retries >= RETRIES.length) return;
    const delay =
      Math.max(RETRIES[this.retries++], minimum || 0) +
      Math.floor(Math.random() * 1000);
    this.schedule(delay, true);
  }
}
exports.configBackupHelper = new ConfigBackupHelper();
