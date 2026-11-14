"use strict";
/**
 * AuthHelper - Electron 端认证辅助
 * 管理认证状态的本地存储
 */
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.authHelper = exports.AuthHelper = void 0;
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
function getAuthPath() {
  return node_path_1.default.join(getUserDataPath(), "auth.json");
}
function ensureDirExists(filePath) {
  const dir = node_path_1.default.dirname(filePath);
  if (!node_fs_1.default.existsSync(dir)) {
    node_fs_1.default.mkdirSync(dir, { recursive: true });
  }
}
function generateDeviceId() {
  try {
    const originalMachineId = (0, node_machine_id_1.machineIdSync)(true);
    return node_crypto_1.default
      .createHash("sha256")
      .update(originalMachineId)
      .digest("hex");
  } catch {
    return node_crypto_1.default.randomUUID();
  }
}
class AuthHelper {
  constructor() {
    this.authPath = getAuthPath();
  }
  /**
   * 加载原始状态
   */
  loadRaw() {
    if (!node_fs_1.default.existsSync(this.authPath)) return null;
    try {
      const text = node_fs_1.default.readFileSync(this.authPath, "utf8");
      return JSON.parse(text);
    } catch (e) {
      console.error("Failed to read auth.json:", e);
      return null;
    }
  }
  /**
   * 获取或创建设备 ID
   */
  getOrCreateDeviceId() {
    const current = this.loadRaw();
    if (current?.device_id) return current.device_id;
    const did = generateDeviceId();
    const state = { device_id: did };
    this.save(state);
    return did;
  }
  /**
   * 加载认证状态
   */
  load(deviceId) {
    const raw = this.loadRaw();
    if (!raw) return null;
    const state = {
      device_id: raw.device_id || deviceId || this.getOrCreateDeviceId(),
      token: raw.token,
      user: raw.user,
      subscription: raw.subscription,
      last_validated_at: raw.last_validated_at,
    };
    return state;
  }
  /**
   * 保存认证状态
   */
  save(state) {
    try {
      ensureDirExists(this.authPath);
      node_fs_1.default.writeFileSync(
        this.authPath,
        JSON.stringify(state, null, 2),
        "utf8",
      );
    } catch (e) {
      console.error("Failed to save auth.json:", e);
    }
  }
  /**
   * 清除认证状态（保留 device_id）
   */
  clear() {
    const current = this.loadRaw();
    const deviceId = current?.device_id || this.getOrCreateDeviceId();
    this.save({ device_id: deviceId });
  }
}
exports.AuthHelper = AuthHelper;
exports.authHelper = new AuthHelper();
