"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLIENT_SERVICE_ORIGIN = void 0;
exports.serviceRequest = serviceRequest;
const node_https_1 = __importDefault(require("node:https"));
const node_http_1 = __importDefault(require("node:http"));
const electron_1 = require("electron");
// 本地联调：npm run dev:local。仅未打包的开发进程可连接本机 8888。
// One trusted destination for licenses and backups. Never use a model Base URL.
exports.CLIENT_SERVICE_ORIGIN =
  !electron_1.app.isPackaged &&
  process.env.NODE_ENV === "development" &&
  process.env.CLIENT_SERVICE_LOCAL === "1"
    ? "http://127.0.0.1:8888"
    : "https://mianshiguodong.top";
function serviceRequest(path, body, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseBytes = 0;
    const payload =
      body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(body), "utf8");
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const target = new URL(path, exports.CLIENT_SERVICE_ORIGIN);
    if (target.origin !== exports.CLIENT_SERVICE_ORIGIN) {
      reject(new Error("untrusted_destination"));
      return;
    }
    const transport =
      target.protocol === "http:" ? node_http_1.default : node_https_1.default;
    const req = transport.request(
      target,
      {
        rejectUnauthorized: true,
        method: payload ? "POST" : "GET",
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": payload.length,
            }
          : {},
      },
      (res) => {
        // Native https does not follow redirects: credentials/content stay on the trusted host.
        const chunks = [];
        res.on("data", (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > 32 * 1024) {
            req.destroy(new Error("response_too_large"));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on("error", (error) => finish(error));
        res.on("aborted", () => finish(new Error("response_aborted")));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* bounded non-JSON failure */
          }
          finish(undefined, {
            status: res.statusCode || 0,
            data,
            retryAfter: res.headers["retry-after"],
          });
        });
      },
    );
    const abort = () => req.destroy(new Error("request_cancelled"));
    const timer = setTimeout(
      () => req.destroy(new Error("request_timeout")),
      10000,
    );
    req.on("error", (error) => finish(error));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    req.end(payload);
  });
}
