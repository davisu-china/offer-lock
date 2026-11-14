"use strict";
// ipcHandlers.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeIpcHandlers = initializeIpcHandlers;
const electron_1 = require("electron");
const ConfigHelper_1 = require("./ConfigHelper");
const LicenseHelper_1 = require("./LicenseHelper");
const AuthHelperOverseas_1 = require("./AuthHelperOverseas");
const electron_2 = require("electron");
const paraformerManager_1 = require("./paraformerManager");
const liveTranslateSession_1 = require("./liveTranslateSession");
const AccessGuard_1 = require("./AccessGuard");
const AppRegion_1 = require("./AppRegion");
const DomesticLicenseService_1 = require("./DomesticLicenseService");
function initializeIpcHandlers(deps) {
  console.log("Initializing IPC handlers");
  // 🎤 Voice recording status (authoritative in main process scope of this module)
  let voiceRecordingActive = false;
  const paraformerManager = new paraformerManager_1.ParaformerManager();
  let currentLiveTranslateSession = null;
  function normalizeVoiceProvider(provider) {
    return provider === "gummy" ? "livetranslate" : provider || "ali";
  }
  // 📝 Renderer logging bridge (print renderer logs to main terminal)
  electron_1.ipcMain.on("renderer-log", (_event, message) => {
    console.log(message);
  });
  electron_1.ipcMain.on("mobile-transcript-state", (_event, payload) => {
    try {
      deps.updateMobileTranscriptState?.(payload);
    } catch (error) {
      console.warn("[mobile] failed to receive transcript state:", error);
    }
  });
  function isTrialActive(state) {
    if (!state?.trial_started_at) return false;
    try {
      const started = new Date(state.trial_started_at).getTime();
      const now = Date.now();
      const diffMs = now - started;
      return diffMs >= 0 && diffMs <= 10 * 60 * 1000; // 10 minutes
    } catch {
      return false;
    }
  }
  function guardLicense() {
    const result = (0, AccessGuard_1.guardFeatureAccess)();
    return { ok: result.ok, reason: result.reason };
  }
  // Configuration handlers
  electron_1.ipcMain.handle("get-config", () => {
    return ConfigHelper_1.configHelper.loadConfig();
  });
  electron_1.ipcMain.handle("update-config", (_event, updates) => {
    // All renderer entry points must use the main process's current verified grant.
    // Only gate an explicit custom selection; ordinary settings remain editable.
    if (
      (0, AppRegion_1.getAppRegion)() === "domestic" &&
      (updates?.apiProvider === "custom" ||
        updates?.apiProvider === "custom2") &&
      !DomesticLicenseService_1.domesticLicenseService.access()?.canCustom
    ) {
      return false;
    }
    return ConfigHelper_1.configHelper.updateConfig(updates);
  });
  electron_1.ipcMain.handle("get-app-region", () => {
    return (0, AppRegion_1.getAppRegion)();
  });
  electron_1.ipcMain.handle("mobile-bridge-info", () => {
    try {
      return (
        deps.getMobileBridgeInfo?.() || {
          enabled: false,
          port: null,
          token: "",
          urls: [],
          connectedClients: 0,
        }
      );
    } catch (error) {
      return {
        enabled: false,
        port: null,
        token: "",
        urls: [],
        connectedClients: 0,
        error: String(error),
      };
    }
  });
  electron_1.ipcMain.handle("check-api-key", () => {
    return ConfigHelper_1.configHelper.hasApiKey();
  });
  electron_1.ipcMain.handle("validate-api-key", async (_event, apiKey) => {
    // First check the format
    if (!ConfigHelper_1.configHelper.isValidApiKeyFormat(apiKey)) {
      return {
        valid: false,
        error: "Invalid API key format. OpenAI API keys start with 'sk-'",
      };
    }
    // Then test the API key with OpenAI
    const result = await ConfigHelper_1.configHelper.testApiKey(apiKey);
    return result;
  });
  // Credits handlers
  electron_1.ipcMain.handle("set-initial-credits", async (_event, credits) => {
    const mainWindow = deps.getMainWindow();
    if (!mainWindow) return;
    try {
      // Set the credits in a way that ensures atomicity
      await mainWindow.webContents.executeJavaScript(
        `window.__CREDITS__ = ${credits}`,
      );
      mainWindow.webContents.send("credits-updated", credits);
    } catch (error) {
      console.error("Error setting initial credits:", error);
      throw error;
    }
  });
  electron_1.ipcMain.handle("decrement-credits", async () => {
    const mainWindow = deps.getMainWindow();
    if (!mainWindow) return;
    try {
      const currentCredits =
        await mainWindow.webContents.executeJavaScript("window.__CREDITS__");
      if (currentCredits > 0) {
        const newCredits = currentCredits - 1;
        await mainWindow.webContents.executeJavaScript(
          `window.__CREDITS__ = ${newCredits}`,
        );
        mainWindow.webContents.send("credits-updated", newCredits);
      }
    } catch (error) {
      console.error("Error decrementing credits:", error);
    }
  });
  // Screenshot queue handlers
  electron_1.ipcMain.handle("get-screenshot-queue", () => {
    return deps.getScreenshotQueue();
  });
  electron_1.ipcMain.handle("get-extra-screenshot-queue", () => {
    return deps.getExtraScreenshotQueue();
  });
  electron_1.ipcMain.handle("delete-screenshot", async (event, path) => {
    return deps.deleteScreenshot(path);
  });
  electron_1.ipcMain.handle("get-image-preview", async (event, path) => {
    return deps.getImagePreview(path);
  });
  // Screenshot processing handlers
  electron_1.ipcMain.handle("process-screenshots", async () => {
    // Check for API key before processing
    if (!ConfigHelper_1.configHelper.hasApiKey()) {
      const mainWindow = deps.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
      }
      return;
    }
    await deps.processingHelper?.processScreenshots();
  });
  // Window dimension handlers
  electron_1.ipcMain.handle(
    "update-content-dimensions",
    async (event, { width, height }) => {
      try {
        const now = Date.now();
        // console.log(`[WM][IPC] dims recv t=${now} w=${width} h=${height}`)
      } catch {}
      if (width && height) {
        deps.setWindowDimensions(width, height);
      }
    },
  );
  // Allow renderer to trigger text-only processing (equivalent to Ctrl+S)
  electron_1.ipcMain.handle("process-text-only", async (_event, payload) => {
    try {
      const textArg =
        typeof payload === "string"
          ? payload
          : payload && typeof payload.text === "string"
            ? payload.text
            : undefined;
      if (typeof payload === "object" && payload?.recent === true) {
        await deps.processingHelper?.processRecentVoiceText();
      } else {
        await deps.processingHelper?.processTextOnly(textArg);
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  // Voice-triggered screenshot (equivalent to Ctrl+H, respects screenshotMode config)
  electron_1.ipcMain.handle("take-screenshot-by-voice", async () => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow) {
        return { success: false, error: "No main window" };
      }
      // Check screenshot mode from config (same as Ctrl+H shortcut)
      const cfg = ConfigHelper_1.configHelper.loadConfig();
      const mode = cfg?.screenshotMode === "region" ? "region" : "full";
      let path = null;
      if (mode === "region") {
        path = await deps.takeScreenshotWithRegion();
      } else {
        path = await deps.takeScreenshot();
      }
      if (!path) {
        return { success: false, error: "Screenshot failed or cancelled" };
      }
      const preview = await deps.getImagePreview(path);
      mainWindow.webContents.send("screenshot-taken", { path, preview });
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  // Suspend or resume main window resizing (e.g., when settings dialog is open)
  electron_1.ipcMain.handle("set-suspend-resize", (_event, suspend) => {
    try {
      deps.setSuspendResize(Boolean(suspend));
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  // New: control mouse event ignore (click-through)
  electron_1.ipcMain.handle("set-mouse-ignore", (event, ignore) => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
    return { success: false, error: "no-window" };
  });
  // New: control focusable (allow text inputs)
  electron_1.ipcMain.handle("set-focusable", (_event, focusable) => {
    try {
      const win = deps.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.setFocusable(Boolean(focusable));
        return { success: true };
      }
      return { success: false, error: "no-window" };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  // New: focus main window explicitly
  electron_1.ipcMain.handle("focus-window", () => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.focus();
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
    return { success: false, error: "no-window" };
  });
  electron_1.ipcMain.handle("set-window-dimensions", (event, width, height) => {
    deps.setWindowDimensions(width, height);
  });
  // Zoom level handlers
  electron_1.ipcMain.handle("get-zoom-level", () => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        return { success: true, level: win.webContents.getZoomLevel() };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
    return { success: false, error: "no-window" };
  });
  electron_1.ipcMain.handle("set-zoom-level", (_event, level) => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.setZoomLevel(Number(level) || 0);
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
    return { success: false, error: "no-window" };
  });
  // Screenshot management handlers
  electron_1.ipcMain.handle("get-screenshots", async () => {
    const listStarted = performance.now();
    try {
      let previews = [];
      const currentView = deps.getView();
      if (currentView === "queue") {
        const queue = deps.getScreenshotQueue();
        previews = await Promise.all(
          queue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path),
          })),
        );
      } else {
        const extraQueue = deps.getExtraScreenshotQueue();
        previews = await Promise.all(
          extraQueue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path),
          })),
        );
      }
      console.log(
        `[ScreenshotTiming][list] view=${currentView} count=${previews.length} read_all_previews=${(performance.now() - listStarted).toFixed(1)}ms`,
      );
      return previews;
    } catch (error) {
      console.error("Error getting screenshots:", error);
      throw error;
    }
  });
  // Screenshot trigger handlers
  electron_1.ipcMain.handle("trigger-screenshot", async () => {
    const g = guardLicense();
    if (!g.ok)
      return { success: false, error: "license_invalid", reason: g.reason };
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      try {
        // Respect screenshot mode (full | region)
        const cfg = ConfigHelper_1.configHelper.loadConfig();
        const mode = cfg?.screenshotMode === "region" ? "region" : "full";
        let screenshotPath = null;
        if (mode === "region") {
          try {
            screenshotPath = await deps.takeScreenshotWithRegion?.();
          } catch (e) {
            screenshotPath = null;
          }
          if (!screenshotPath) {
            // Try to fetch RegionSelector last reason if exposed on main
            try {
              const rs = require("./main").state?.regionSelector;
              const reason =
                rs && typeof rs.getLastReason === "function"
                  ? rs.getLastReason()
                  : null;
              return {
                success: false,
                error: "cancelled",
                reason: reason || null,
              };
            } catch {}
            return { success: false, error: "cancelled" };
          }
        } else {
          screenshotPath = await deps.takeScreenshot();
        }
        const preview = await deps.getImagePreview(screenshotPath);
        mainWindow.webContents.send("screenshot-taken", {
          path: screenshotPath,
          preview,
        });
        return { success: true };
      } catch (error) {
        console.error("Error triggering screenshot:", error);
        return { error: "Failed to trigger screenshot" };
      }
    }
    return { error: "No main window available" };
  });
  electron_1.ipcMain.handle("take-screenshot", async () => {
    const g = guardLicense();
    if (!g.ok)
      return { success: false, error: "license_invalid", reason: g.reason };
    try {
      const screenshotPath = await deps.takeScreenshot();
      const preview = await deps.getImagePreview(screenshotPath);
      return { path: screenshotPath, preview };
    } catch (error) {
      console.error("Error taking screenshot:", error);
      return { error: "Failed to take screenshot" };
    }
  });
  // Auth-related handlers removed
  electron_1.ipcMain.handle("open-external-url", (event, url) => {
    electron_1.shell.openExternal(url);
  });
  electron_1.ipcMain.handle("history-list", async () => {
    return deps.historyHelper?.listRecent(20) || [];
  });
  electron_1.ipcMain.handle("history-open-html", async (_event, id) => {
    if (!deps.historyHelper) {
      return { success: false, error: "history_helper_unavailable" };
    }
    return deps.historyHelper.openHtml(id);
  });
  electron_1.ipcMain.handle("history-open-folder", async (_event, id) => {
    if (!deps.historyHelper) {
      return { success: false, error: "history_helper_unavailable" };
    }
    return deps.historyHelper.openFolder(id);
  });
  electron_1.ipcMain.handle("history-delete", async (_event, id) => {
    if (!deps.historyHelper) {
      return { success: false, error: "history_helper_unavailable" };
    }
    return deps.historyHelper.deleteRecord(id);
  });
  electron_1.ipcMain.handle(
    "history-record-transcript",
    async (_event, text) => {
      if (!deps.historyHelper) {
        return { success: false, error: "history_helper_unavailable" };
      }
      await deps.historyHelper.recordTranscript(text);
      return { success: true };
    },
  );
  electron_1.ipcMain.handle(
    "history-record-answer",
    async (_event, payload) => {
      if (!deps.historyHelper) {
        return { success: false, error: "history_helper_unavailable" };
      }
      await deps.historyHelper.recordAiAnswer(payload || {});
      return { success: true };
    },
  );
  // Clipboard: write text
  electron_1.ipcMain.handle("copy-text", (_event, text) => {
    try {
      const { clipboard } = require("electron");
      clipboard.writeText(String(text ?? ""));
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  // Open external URL handler
  electron_1.ipcMain.handle("openLink", (event, url) => {
    try {
      console.log(`Opening external URL: ${url}`);
      electron_1.shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error(`Error opening URL ${url}:`, error);
      return { success: false, error: `Failed to open URL: ${error}` };
    }
  });
  // Settings portal handler
  electron_1.ipcMain.handle("open-settings-portal", () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      // Ensure the settings UI can accept inputs: allow clicks and focus
      try {
        mainWindow.setIgnoreMouseEvents(false, { forward: true });
      } catch {}
      try {
        mainWindow.setFocusable(true);
      } catch {}
      try {
        mainWindow.focus();
      } catch {}
      mainWindow.webContents.send("show-settings-dialog");
      return { success: true };
    }
    return { success: false, error: "Main window not available" };
  });
  // Window management handlers
  electron_1.ipcMain.handle("toggle-window", () => {
    try {
      deps.toggleMainWindow();
      return { success: true };
    } catch (error) {
      console.error("Error toggling window:", error);
      return { error: "Failed to toggle window" };
    }
  });
  electron_1.ipcMain.handle("reset-queues", async () => {
    try {
      deps.clearQueues();
      return { success: true };
    } catch (error) {
      console.error("Error resetting queues:", error);
      return { error: "Failed to reset queues" };
    }
  });
  // Process screenshot handlers
  electron_1.ipcMain.handle("trigger-process-screenshots", async () => {
    try {
      const g = guardLicense();
      if (!g.ok)
        return { success: false, error: "license_invalid", reason: g.reason };
      // Check for API key before processing
      if (!ConfigHelper_1.configHelper.hasApiKey()) {
        const mainWindow = deps.getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
        }
        return { success: false, error: "API key required" };
      }
      await deps.processingHelper?.processScreenshots();
      return { success: true };
    } catch (error) {
      console.error("Error processing screenshots:", error);
      return { error: "Failed to process screenshots" };
    }
  });
  electron_1.ipcMain.handle("trigger-process-with-input", async () => {
    try {
      const g = guardLicense();
      if (!g.ok)
        return { success: false, error: "license_invalid", reason: g.reason };
      if (!ConfigHelper_1.configHelper.hasApiKey()) {
        const mainWindow = deps.getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
        }
        return { success: false, error: "API key required" };
      }
      await deps.processingHelper?.processWithInput();
      return { success: true };
    } catch (error) {
      console.error("Error processing with input:", error);
      return { error: "Failed to process with input" };
    }
  });
  // Auth handlers (Overseas - 账号登录系统)
  electron_1.ipcMain.handle("auth-get-device", async () => {
    try {
      const deviceId = AuthHelperOverseas_1.authHelper.getOrCreateDeviceId();
      return { success: true, device_id: deviceId };
    } catch (e) {
      console.error("auth-get-device error:", e);
      return { success: false, error: "failed_to_get_device_id" };
    }
  });
  electron_1.ipcMain.handle("auth-load-state", async () => {
    try {
      const deviceId = AuthHelperOverseas_1.authHelper.getOrCreateDeviceId();
      const state = AuthHelperOverseas_1.authHelper.load(deviceId) || {
        device_id: deviceId,
      };
      return { success: true, state };
    } catch (e) {
      console.error("auth-load-state error:", e);
      return { success: false, error: "failed_to_load" };
    }
  });
  electron_1.ipcMain.handle("auth-save-state", async (_event, updates) => {
    try {
      const deviceId = AuthHelperOverseas_1.authHelper.getOrCreateDeviceId();
      const current = AuthHelperOverseas_1.authHelper.load(deviceId) || {
        device_id: deviceId,
      };
      const merged = { ...current, ...updates, device_id: deviceId };
      AuthHelperOverseas_1.authHelper.save(merged);
      return { success: true };
    } catch (e) {
      console.error("auth-save-state error:", e);
      return { success: false, error: "failed_to_save" };
    }
  });
  electron_1.ipcMain.handle("auth-clear", async () => {
    try {
      AuthHelperOverseas_1.authHelper.clear();
      return { success: true };
    } catch (e) {
      console.error("auth-clear error:", e);
      return { success: false, error: "failed_to_clear" };
    }
  });
  // License handlers
  electron_1.ipcMain.handle("license-get-device", async () => {
    try {
      const deviceId = LicenseHelper_1.licenseHelper.getOrCreateDeviceId();
      return { success: true, device_id: deviceId };
    } catch (e) {
      console.error("license-get-device error:", e);
      return { success: false, error: "failed_to_get_device_id" };
    }
  });
  electron_1.ipcMain.handle("license-load-state", async () => {
    try {
      const deviceId = LicenseHelper_1.licenseHelper.getOrCreateDeviceId();
      const state = LicenseHelper_1.licenseHelper.load(deviceId) || {
        device_id: deviceId,
      };
      const access = DomesticLicenseService_1.domesticLicenseService.access();
      return {
        success: true,
        state: {
          ...state,
          tier: access?.tier,
          can_custom: access?.canCustom === true,
        },
      };
    } catch (e) {
      console.error("license-load-state error:", e);
      return { success: false, error: "failed_to_load" };
    }
  });
  electron_1.ipcMain.handle("license-refresh", async (_event, code) => {
    if (
      code !== undefined &&
      (typeof code !== "string" || !code.trim() || code.length > 64)
    ) {
      return { ok: false, error: "invalid_card" };
    }
    return DomesticLicenseService_1.domesticLicenseService.refresh(code);
  });
  electron_1.ipcMain.handle("license-save-state", async (_event, updates) => {
    // Compatibility only. Renderer cannot overwrite identity/status/grants after main verification.
    if (
      !updates ||
      Object.keys(updates).some((key) => key !== "serverBaseUrl")
    ) {
      return { success: false, error: "use_license_refresh" };
    }
    return { success: true };
  });
  // Reset handlers
  electron_1.ipcMain.handle("trigger-reset", () => {
    return deps.triggerReset();
  });
  // Window movement handlers
  electron_1.ipcMain.handle("trigger-move-left", () => {
    try {
      deps.moveWindowLeft();
      return { success: true };
    } catch (error) {
      console.error("Error moving window left:", error);
      return { error: "Failed to move window left" };
    }
  });
  electron_1.ipcMain.handle("trigger-move-right", () => {
    try {
      deps.moveWindowRight();
      return { success: true };
    } catch (error) {
      console.error("Error moving window right:", error);
      return { error: "Failed to move window right" };
    }
  });
  electron_1.ipcMain.handle("trigger-move-up", () => {
    try {
      deps.moveWindowUp();
      return { success: true };
    } catch (error) {
      console.error("Error moving window up:", error);
      return { error: "Failed to move window up" };
    }
  });
  electron_1.ipcMain.handle("trigger-move-down", () => {
    try {
      deps.moveWindowDown();
      return { success: true };
    } catch (error) {
      console.error("Error moving window down:", error);
      return { error: "Failed to move window down" };
    }
  });
  // Delete last screenshot handler
  electron_1.ipcMain.handle("delete-last-screenshot", async () => {
    try {
      const queue =
        deps.getView() === "queue"
          ? deps.getScreenshotQueue()
          : deps.getExtraScreenshotQueue();
      if (queue.length === 0) {
        return { success: false, error: "No screenshots to delete" };
      }
      // Get the last screenshot in the queue
      const lastScreenshot = queue[queue.length - 1];
      // Delete it
      const result = await deps.deleteScreenshot(lastScreenshot);
      // Notify the renderer about the change
      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("screenshot-deleted", {
          path: lastScreenshot,
        });
      }
      return result;
    } catch (error) {
      console.error("Error deleting last screenshot:", error);
      return { success: false, error: "Failed to delete last screenshot" };
    }
  });
  // 🎤 Voice Recognition handlers
  // Handle Qwen-LiveTranslate realtime events.
  function handleLiveTranslateEvent(event, window) {
    const raw = event.raw || {};
    const eventType = event.event || raw.type;
    const sentenceId = raw.item_id || raw.response_id || raw.event_id || null;
    if (eventType === "response.text.text") {
      const draftText = `${raw.text || ""}${raw.stash || ""}`.trim();
      if (draftText) {
        window.webContents.send("voice-transcript-delta", {
          text: draftText,
          sentenceEnd: false,
          sentenceId,
          isTranslation: true,
          language: raw.language,
        });
      }
      return;
    }
    if (eventType === "response.text.done") {
      const translatedText = (raw.text || "").trim();
      if (translatedText) {
        console.log("[livetranslate] final translation", {
          sentenceId,
          chars: translatedText.length,
        });
        window.webContents.send("voice-transcript-delta", {
          text: translatedText,
          sentenceEnd: true,
          sentenceId,
          isTranslation: true,
          language: raw.language,
        });
      }
      return;
    }
    if (eventType === "conversation.item.input_audio_transcription.completed") {
      const transcript = (raw.transcript || "").trim();
      if (transcript) {
        window.webContents.send("voice-transcript-delta", {
          text: transcript,
          sentenceEnd: true,
          sentenceId,
          isTranslation: false,
          language: raw.language,
        });
      }
      return;
    }
    if (eventType === "error") {
      const message = raw?.error?.message || "Translation session error";
      console.error("[livetranslate] session error:", raw);
      window.webContents.send("voice-error", { error: message });
      return;
    }
    if (eventType === "closed") {
      console.warn("[livetranslate] session closed", raw);
      return;
    }
    console.log("[livetranslate] ignored event", { eventType, sentenceId });
    return;
    if (event.event === "result-generated") {
      const payload = event.raw?.payload?.output;
      // 发送识别结果
      if (payload?.transcription && payload.transcription.sentence_end) {
        window.webContents.send("voice-transcript-delta", {
          text: payload.transcription.text,
          sentenceEnd: true,
          sentenceId: payload.transcription.sentence_id,
          isTranslation: false,
        });
      }
      // 发送翻译结果
      if (payload?.translations && payload.translations.length > 0) {
        const translation = payload.translations[0];
        if (translation.sentence_end) {
          window.webContents.send("voice-transcript-delta", {
            text: translation.text,
            sentenceEnd: true,
            sentenceId: translation.sentence_id,
            isTranslation: true,
            language: translation.lang,
          });
        }
      }
    } else if (event.event === "task-failed") {
      console.error(
        "[livetranslate-legacy] task failed:",
        event.raw?.header?.error_message,
      );
      window.webContents.send("voice-error", {
        error: event.raw?.header?.error_message || "Translation task failed",
      });
    } else if (event.event === "error") {
      console.error("[livetranslate-legacy] session error:", event.raw);
      window.webContents.send("voice-error", {
        error: "Translation session error",
      });
    }
  }
  electron_1.ipcMain.handle("start-voice-recognition", async () => {
    const g = guardLicense();
    if (!g.ok)
      return { success: false, error: "license_invalid", reason: g.reason };
    try {
      const config = ConfigHelper_1.configHelper.loadConfig();
      const provider = normalizeVoiceProvider(
        config.voiceAsrProvider || config.voiceProvider || "ali",
      );
      console.log("[voice] start requested, provider=", provider);
      // Handle Qwen-LiveTranslate provider.
      if (provider === "livetranslate") {
        console.log("[voice] Handling livetranslate provider");
        const mainWindow = deps.getMainWindow();
        if (!mainWindow) {
          console.error("[voice] main window missing");
          throw new Error("main_window_missing");
        }
        // Gummy 使用阿里云的 API Key（因为都是 DashScope 服务）
        const liveTranslateApiKey =
          config.liveTranslateApiKey ||
          config.gummyApiKey ||
          config.aliAsrApiKey ||
          config.paraformerApiKey ||
          config.apiKey;
        console.log(
          "[voice] liveTranslateApiKey exists:",
          !!liveTranslateApiKey,
        );
        if (!liveTranslateApiKey) {
          console.error("[voice] LiveTranslate API key missing");
          throw new Error("livetranslate_api_key_missing");
        }
        const sourceLanguage =
          config.liveTranslateSourceLang || config.gummySourceLang || "auto";
        const targetLanguage =
          config.liveTranslateTargetLang || config.gummyTargetLang || "zh";
        console.log("[voice] LiveTranslate config:", {
          sourceLanguage,
          targetLanguage,
        });
        console.log("[voice] Creating LiveTranslateSession...");
        currentLiveTranslateSession =
          new liveTranslateSession_1.LiveTranslateSession({
            apiKey: liveTranslateApiKey,
            sourceLanguage,
            targetLanguage,
            enableSourceTranscription: false,
            onEvent: (event) => {
              handleLiveTranslateEvent(event, mainWindow);
            },
          });
        // ✅ 异步启动，不阻塞按钮状态更新
        console.log("[voice] Starting LiveTranslateSession (async)...");
        currentLiveTranslateSession.start().catch((error) => {
          console.error("[voice] LiveTranslateSession start failed:", error);
          mainWindow.webContents.send("voice-error", {
            error: "Failed to connect to translation service",
          });
        });
        // ✅ 立即返回，不等待连接
        voiceRecordingActive = true;
        mainWindow.webContents.send("voice-status", {
          recording: true,
          mode: "livetranslate",
        });
        console.log("[voice] Returning success with mode: livetranslate");
        return { success: true, mode: "livetranslate" };
      }
      // Handle OpenAI Whisper provider
      if (provider === "openai") {
        const mainWindow = deps.getMainWindow();
        if (!mainWindow) throw new Error("main_window_missing");
        console.log("[voice] Handling openai provider");
        voiceRecordingActive = true;
        mainWindow.webContents.send("voice-status", {
          recording: true,
          mode: "openai",
        });
        return { success: true, mode: "openai" };
      }
      if (
        provider === "paraformer" ||
        provider === "ali" ||
        provider === "doubao" ||
        provider === "deepgram"
      ) {
        const mainWindow = deps.getMainWindow();
        if (!mainWindow) throw new Error("main_window_missing");
        voiceRecordingActive = true;
        mainWindow.webContents.send("voice-status", {
          recording: true,
          mode: provider,
        });
        return { success: true, mode: provider };
      }
      deps.createVoiceWindow();
      voiceRecordingActive = true;
      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("voice-status", {
          recording: true,
          mode: provider,
        });
      }
      return { success: true, mode: provider };
    } catch (error) {
      console.error("Error starting voice recognition:", error);
      return { success: false, error: error.message };
    }
  });
  electron_1.ipcMain.handle("stop-voice-recognition", async () => {
    const g = guardLicense();
    if (!g.ok)
      return { success: false, error: "license_invalid", reason: g.reason };
    try {
      const config = ConfigHelper_1.configHelper.loadConfig();
      const provider = normalizeVoiceProvider(
        config.voiceAsrProvider || config.voiceProvider || "ali",
      );
      console.log("[voice] stop requested, provider=", provider);
      const mainWindow = deps.getMainWindow();
      // Handle LiveTranslate session stop
      if (provider === "livetranslate" && currentLiveTranslateSession) {
        await currentLiveTranslateSession.stop();
        currentLiveTranslateSession = null;
      } else if (
        provider === "paraformer" ||
        provider === "ali" ||
        provider === "doubao" ||
        provider === "deepgram" ||
        provider === "openai"
      ) {
        await paraformerManager.stopAll();
      } else {
        await deps.stopVoiceWindow();
      }
      voiceRecordingActive = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("voice-status", {
          recording: false,
          mode: provider,
        });
      }
      return { success: true };
    } catch (error) {
      console.error("Error stopping voice recognition:", error);
      return { success: false, error: error.message };
    }
  });
  // 🎤 查询当前语音识别状态
  electron_1.ipcMain.handle("get-voice-status", async () => {
    const config = ConfigHelper_1.configHelper.loadConfig();
    const provider = normalizeVoiceProvider(
      config.voiceAsrProvider || config.voiceProvider || "ali",
    );
    return { recording: voiceRecordingActive, mode: provider };
  });
  electron_1.ipcMain.handle("get-desktop-audio-source-id", async () => {
    const { desktopCapturer } = require("electron");
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        fetchWindowIcons: false,
      });
      const systemSource =
        sources.find((source) => source.id?.startsWith("screen:")) ||
        sources[0];
      return systemSource?.id;
    } catch (error) {
      console.warn("[paraformer] get system audio id failed", error);
      return null;
    }
  });
  // Paraformer session IPC handlers (serves all unified WebSocket providers now)
  electron_1.ipcMain.handle(
    "paraformer-session-start",
    async (event, options) => {
      try {
        const config = ConfigHelper_1.configHelper.loadConfig();
        const provider = normalizeVoiceProvider(
          config.voiceAsrProvider || config.voiceProvider || "ali",
        );
        const apiKey = config.paraformerApiKey || config.apiKey;
        if ((provider === "ali" || provider === "paraformer") && !apiKey) {
          throw new Error("missing_dashscope_api_key");
        }
        const result = await paraformerManager.startSession({
          apiKey: apiKey || "",
          model: options?.model,
          format: options?.format,
          sampleRate: options?.sampleRate,
          language: options?.language,
          sender: event.sender,
        });
        return { success: true, ...result };
      } catch (error) {
        console.error("paraformer-session-start error", error);
        return { success: false, error: String(error?.message || error) };
      }
    },
  );
  electron_1.ipcMain.handle(
    "paraformer-session-send",
    async (_event, payload) => {
      try {
        await paraformerManager.sendAudio(
          payload.sessionId,
          payload.taskId,
          Buffer.from(payload.audio, "base64"),
        );
        return { success: true };
      } catch (error) {
        console.error("paraformer-session-send error", error);
        return { success: false, error: String(error?.message || error) };
      }
    },
  );
  electron_1.ipcMain.handle(
    "paraformer-session-finish",
    async (_event, payload) => {
      try {
        await paraformerManager.finishTask(payload.sessionId, payload.taskId);
        return { success: true };
      } catch (error) {
        console.error("paraformer-session-finish error", error);
        return { success: false, error: String(error?.message || error) };
      }
    },
  );
  electron_1.ipcMain.handle(
    "paraformer-session-stop",
    async (_event, payload) => {
      try {
        await paraformerManager.stopSession(payload.sessionId);
        return { success: true };
      } catch (error) {
        console.error("paraformer-session-stop error", error);
        return { success: false, error: String(error?.message || error) };
      }
    },
  );
  async function sendLiveTranslateAudio(payload) {
    try {
      if (!currentLiveTranslateSession) {
        throw new Error("no_active_livetranslate_session");
      }
      await currentLiveTranslateSession.sendAudioChunk(
        Buffer.from(payload.audio, "base64"),
      );
      return { success: true };
    } catch (error) {
      console.error("live-translate-session-send error", error);
      return { success: false, error: String(error?.message || error) };
    }
  }
  // LiveTranslate session IPC handlers.
  electron_1.ipcMain.handle(
    "live-translate-session-send",
    async (_event, payload) => {
      return sendLiveTranslateAudio(payload);
    },
  );
  // Backward-compatible alias for older renderer code during migration.
  electron_1.ipcMain.handle("gummy-session-send", async (_event, payload) => {
    return sendLiveTranslateAudio(payload);
  });
  // 🎤 处理语音识别结果 (FunASR legacy)
  electron_1.ipcMain.on("voice-transcript", (event, text) => {
    const mainWindow = deps.getMainWindow();
    if (!mainWindow) return;
    console.log("Voice transcript received:", text);
    mainWindow.webContents.send("voice-transcript-result", text);
  });
  electron_1.ipcMain.handle("kb-import-files", async () => {
    try {
      const res = await electron_1.dialog.showOpenDialog({
        title: "选择要导入的知识库文件",
        filters: [{ name: "Text/Markdown", extensions: ["txt", "md"] }],
        properties: ["openFile", "multiSelections"],
      });
      if (res.canceled || !res.filePaths?.length)
        return { success: false, canceled: true };
      const fs = require("node:fs");
      const path = require("node:path");
      const dstDir = path.join(electron_2.app.getPath("userData"), "knowledge");
      fs.mkdirSync(dstDir, { recursive: true });
      for (const f of res.filePaths) {
        const base = path.basename(f);
        const dst = path.join(dstDir, base);
        fs.copyFileSync(f, dst);
      }
      await deps.processingHelper?.kbRebuild?.();
      return { success: true, imported: res.filePaths.length };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  electron_1.ipcMain.handle("kb-clear", async () => {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = path.join(electron_2.app.getPath("userData"), "knowledge");
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          try {
            fs.unlinkSync(p);
          } catch {}
        }
      }
      // also remove index file
      const storeLegacy = path.join(
        electron_2.app.getPath("userData"),
        "kb_bm25.json",
      );
      const storeVector = path.join(
        electron_2.app.getPath("userData"),
        "orama_kb.json",
      );
      try {
        fs.unlinkSync(storeLegacy);
      } catch {}
      try {
        fs.unlinkSync(storeVector);
      } catch {}
      await deps.processingHelper?.kbRebuild?.();
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  electron_1.ipcMain.handle("kb-stats", () => {
    try {
      const stats = deps.processingHelper?.kbGetStats?.();
      return { success: true, stats: stats || { chunks: 0, lastBuiltAt: 0 } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
  electron_1.ipcMain.handle("kb-rebuild", async () => {
    try {
      await deps.processingHelper?.kbRebuild?.();
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });
}
