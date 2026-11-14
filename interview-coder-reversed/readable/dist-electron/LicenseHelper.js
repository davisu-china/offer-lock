"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.licenseHelper = exports.LicenseHelper = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_machine_id_1 = require("node-machine-id");
function getUserDataPath() {
  try {
    return electron_1.app.getPath("userData");
  } catch {
    return node_path_1.default.join(process.cwd(), ".userData");
  }
}
function getLicensePath() {
  return node_path_1.default.join(getUserDataPath(), "license.json");
}
function deriveKey(deviceId) {
  return node_crypto_1.default.createHash("sha256").update(deviceId).digest();
}
function xor(data, key) {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ key[i % key.length];
  }
  return out;
}
function encryptJson(obj, key) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf8");
  const x = xor(buf, key);
  return x.toString("base64");
}
function decryptJson(text, key) {
  try {
    const buf = Buffer.from(text, "base64");
    const d = xor(buf, key);
    const json = d.toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
function ensureDirExists(filePath) {
  const dir = node_path_1.default.dirname(filePath);
  if (!node_fs_1.default.existsSync(dir)) {
    node_fs_1.default.mkdirSync(dir, { recursive: true });
  }
}
function generateDeviceId() {
  // Prefer a stable machine identifier across reinstalls
  try {
    const originalMachineId = (0, node_machine_id_1.machineIdSync)(true); // original: true returns raw OS machine id
    // Hash to avoid leaking the raw machine identifier; keep format simple hex
    return node_crypto_1.default
      .createHash("sha256")
      .update(originalMachineId)
      .digest("hex");
  } catch {
    // Fallback to random UUID if machine id retrieval fails
    return node_crypto_1.default.randomUUID();
  }
}
class LicenseHelper {
  constructor() {
    this.licensePath = getLicensePath();
  }
  loadRaw() {
    if (!node_fs_1.default.existsSync(this.licensePath)) return null;
    try {
      const text = node_fs_1.default.readFileSync(this.licensePath, "utf8");
      // Try parse plaintext first for backward-compat
      try {
        const obj = JSON.parse(text);
        return obj;
      } catch {
        // If not JSON, might be obfuscated
        return null;
      }
    } catch (e) {
      console.error("Failed to read license.json:", e);
      return null;
    }
  }
  getOrCreateDeviceId() {
    const current = this.loadRaw();
    if (current?.device_id) return current.device_id;
    const did = generateDeviceId();
    const state = {
      device_id: did,
      trial_started_at: new Date().toISOString(),
    };
    this.save(state);
    return did;
  }
  load(deviceId) {
    const raw = this.loadRaw();
    if (!raw) return null;
    const state = {
      device_id: raw.device_id || deviceId || this.getOrCreateDeviceId(),
      code: raw.code,
      status: raw.status,
      expires_at: raw.expires_at,
      remaining_seconds: raw.remaining_seconds,
      last_validated_at: raw.last_validated_at,
      serverBaseUrl: raw.serverBaseUrl,
      trial_started_at: raw.trial_started_at,
    };
    return state;
  }
  save(state) {
    try {
      ensureDirExists(this.licensePath);
      node_fs_1.default.writeFileSync(
        this.licensePath,
        JSON.stringify(state, null, 2),
        "utf8",
      );
    } catch (e) {
      console.error("Failed to save license.json:", e);
    }
  }
}
exports.LicenseHelper = LicenseHelper;
exports.licenseHelper = new LicenseHelper();
