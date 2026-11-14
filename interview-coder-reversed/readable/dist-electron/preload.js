"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROCESSING_EVENTS = void 0;
console.log("Preload script starting...");
const electron_1 = require("electron");
const electron_2 = require("electron");
const { shell } = require("electron");
exports.PROCESSING_EVENTS = {
  //global states
  UNAUTHORIZED: "procesing-unauthorized",
  NO_SCREENSHOTS: "processing-no-screenshots",
  OUT_OF_CREDITS: "out-of-credits",
  API_KEY_INVALID: "api-key-invalid",
  //states for generating the initial solution
  INITIAL_START: "initial-start",
  PROBLEM_EXTRACTED: "problem-extracted",
  SOLUTION_PROGRESS: "solution-progress", // 🚀 新增：流式响应进度事件
  SOLUTION_SUCCESS: "solution-success",
  INITIAL_SOLUTION_ERROR: "solution-error",
  RESET: "reset",
  //states for processing the debugging
  DEBUG_START: "debug-start",
  DEBUG_SUCCESS: "debug-success",
  DEBUG_ERROR: "debug-error",
};
// At the top of the file
console.log("Preload script is running");
const electronAPI = {
  // Original methods
  openSubscriptionPortal: async (authData) => {
    return electron_1.ipcRenderer.invoke("open-subscription-portal", authData);
  },
  openSettingsPortal: () =>
    electron_1.ipcRenderer.invoke("open-settings-portal"),
  updateContentDimensions: (dimensions) =>
    electron_1.ipcRenderer.invoke("update-content-dimensions", dimensions),
  setSuspendResize: (suspend) =>
    electron_1.ipcRenderer.invoke("set-suspend-resize", suspend),
  processTextOnly: (text, recent = false) =>
    electron_1.ipcRenderer.invoke("process-text-only", { text, recent }),
  takeScreenshotByVoice: () =>
    electron_1.ipcRenderer.invoke("take-screenshot-by-voice"),
  getZoomLevel: () => electron_1.ipcRenderer.invoke("get-zoom-level"),
  setZoomLevel: (level) =>
    electron_1.ipcRenderer.invoke("set-zoom-level", level),
  setMouseIgnore: (ignore) =>
    electron_1.ipcRenderer.invoke("set-mouse-ignore", ignore),
  clearStore: () => electron_1.ipcRenderer.invoke("clear-store"),
  getScreenshots: () => electron_1.ipcRenderer.invoke("get-screenshots"),
  deleteScreenshot: (path) =>
    electron_1.ipcRenderer.invoke("delete-screenshot", path),
  toggleMainWindow: async () => {
    console.log("toggleMainWindow called from preload");
    try {
      const result = await electron_1.ipcRenderer.invoke("toggle-window");
      console.log("toggle-window result:", result);
      return result;
    } catch (error) {
      console.error("Error in toggleMainWindow:", error);
      throw error;
    }
  },
  // Event listeners
  onQueueScreenshotRestored: (callback) => {
    const subscription = (_, point) => callback(point);
    electron_1.ipcRenderer.on("queue-screenshot-restored", subscription);
    return () =>
      electron_1.ipcRenderer.removeListener(
        "queue-screenshot-restored",
        subscription,
      );
  },
  onScreenshotTaken: (callback) => {
    const subscription = (_, data) => callback(data);
    electron_1.ipcRenderer.on("screenshot-taken", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("screenshot-taken", subscription);
    };
  },
  onResetView: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on("reset-view", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("reset-view", subscription);
    };
  },
  onClearTextInput: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on("clear-text-input", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("clear-text-input", subscription);
    };
  },
  onAnswerFontSize: (callback) => {
    const subscription = (_, data) => callback(data);
    electron_1.ipcRenderer.on("answer-font-size", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("answer-font-size", subscription);
    };
  },
  onSolutionStart: (callback) => {
    const subscription = (_, data) => callback(data);
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.INITIAL_START,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.INITIAL_START,
        subscription,
      );
    };
  },
  onDebugStart: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.DEBUG_START,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.DEBUG_START,
        subscription,
      );
    };
  },
  onDebugSuccess: (callback) => {
    electron_1.ipcRenderer.on("debug-success", (_event, data) =>
      callback(data),
    );
    return () => {
      electron_1.ipcRenderer.removeListener("debug-success", (_event, data) =>
        callback(data),
      );
    };
  },
  onDebugError: (callback) => {
    const subscription = (_, error) => callback(error);
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.DEBUG_ERROR,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.DEBUG_ERROR,
        subscription,
      );
    };
  },
  onSolutionError: (callback) => {
    const subscription = (_, error) => callback(error);
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        subscription,
      );
    };
  },
  onSwitchPage: (callback) => {
    const subscription = (_, payload) => callback(payload);
    electron_1.ipcRenderer.on("switch-page", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("switch-page", subscription);
    };
  },
  onAnswerScroll: (callback) => {
    const subscription = (_, payload) => callback(payload);
    electron_1.ipcRenderer.on("answer-scroll", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("answer-scroll", subscription);
    };
  },
  onProcessingNoScreenshots: (callback) => {
    const subscription = (_, message) => callback(message);
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.NO_SCREENSHOTS,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.NO_SCREENSHOTS,
        subscription,
      );
    };
  },
  onOutOfCredits: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.OUT_OF_CREDITS,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.OUT_OF_CREDITS,
        subscription,
      );
    };
  },
  onProblemExtracted: (callback) => {
    const subscription = (_, data) => callback(data);
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
        subscription,
      );
    };
  },
  onSolutionSuccess: (callback) => {
    const subscription = (_, data) => callback(data);
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.SOLUTION_SUCCESS,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.SOLUTION_SUCCESS,
        subscription,
      );
    };
  },
  // 🚀 新增：流式响应进度监听
  onSolutionProgress: (callback) => {
    const subscription = (_, data) => callback(data);
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.SOLUTION_PROGRESS,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.SOLUTION_PROGRESS,
        subscription,
      );
    };
  },
  onUnauthorized: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.UNAUTHORIZED,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.UNAUTHORIZED,
        subscription,
      );
    };
  },
  // External URL handler
  openLink: (url) => electron_1.ipcRenderer.invoke("openLink", url),
  triggerScreenshot: () => electron_1.ipcRenderer.invoke("trigger-screenshot"),
  triggerProcessScreenshots: () =>
    electron_1.ipcRenderer.invoke("trigger-process-screenshots"),
  triggerProcessWithInput: () =>
    electron_1.ipcRenderer.invoke("trigger-process-with-input"),
  triggerReset: () => electron_1.ipcRenderer.invoke("trigger-reset"),
  setFocusable: (focusable) =>
    electron_1.ipcRenderer.invoke("set-focusable", focusable),
  focusWindow: () => electron_1.ipcRenderer.invoke("focus-window"),
  triggerMoveLeft: () => electron_1.ipcRenderer.invoke("trigger-move-left"),
  triggerMoveRight: () => electron_1.ipcRenderer.invoke("trigger-move-right"),
  triggerMoveUp: () => electron_1.ipcRenderer.invoke("trigger-move-up"),
  triggerMoveDown: () => electron_1.ipcRenderer.invoke("trigger-move-down"),
  onSubscriptionUpdated: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on("subscription-updated", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener(
        "subscription-updated",
        subscription,
      );
    };
  },
  onSubscriptionPortalClosed: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on("subscription-portal-closed", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener(
        "subscription-portal-closed",
        subscription,
      );
    };
  },
  onReset: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on(exports.PROCESSING_EVENTS.RESET, subscription);
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.RESET,
        subscription,
      );
    };
  },
  startUpdate: () => electron_1.ipcRenderer.invoke("start-update"),
  installUpdate: () => electron_1.ipcRenderer.invoke("install-update"),
  onUpdateAvailable: (callback) => {
    const subscription = (_, info) => callback(info);
    electron_1.ipcRenderer.on("update-available", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("update-available", subscription);
    };
  },
  onUpdateDownloaded: (callback) => {
    const subscription = (_, info) => callback(info);
    electron_1.ipcRenderer.on("update-downloaded", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("update-downloaded", subscription);
    };
  },
  // Clipboard helper
  copyText: (text) => electron_1.ipcRenderer.invoke("copy-text", text),
  decrementCredits: () => electron_1.ipcRenderer.invoke("decrement-credits"),
  onCreditsUpdated: (callback) => {
    const subscription = (_event, credits) => callback(credits);
    electron_1.ipcRenderer.on("credits-updated", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("credits-updated", subscription);
    };
  },
  getPlatform: () => process.platform,
  // Helper: return desktop audio source id (Windows/Chromium)
  getDesktopAudioSourceId: async () => {
    try {
      const sources = await electron_2.desktopCapturer.getSources({
        types: ["screen", "window"],
      });
      const screen =
        sources.find((s) => s.id.startsWith("screen:")) || sources[0];
      return screen ? screen.id : null;
    } catch (e) {
      console.error("getDesktopAudioSourceId failed", e);
      return null;
    }
  },
  // Config and provider settings
  getAppRegion: () => electron_1.ipcRenderer.invoke("get-app-region"),
  getMobileBridgeInfo: () =>
    electron_1.ipcRenderer.invoke("mobile-bridge-info"),
  getConfig: () => electron_1.ipcRenderer.invoke("get-config"),
  historyList: () => electron_1.ipcRenderer.invoke("history-list"),
  historyOpenHtml: (id) =>
    electron_1.ipcRenderer.invoke("history-open-html", id),
  historyOpenFolder: (id) =>
    electron_1.ipcRenderer.invoke("history-open-folder", id),
  historyDelete: (id) => electron_1.ipcRenderer.invoke("history-delete", id),
  historyRecordTranscript: (text) =>
    electron_1.ipcRenderer.invoke("history-record-transcript", text),
  historyRecordAnswer: (payload) =>
    electron_1.ipcRenderer.invoke("history-record-answer", payload),
  updateConfig: (config) =>
    electron_1.ipcRenderer.invoke("update-config", config),
  onShowSettings: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on("show-settings-dialog", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener(
        "show-settings-dialog",
        subscription,
      );
    };
  },
  checkApiKey: () => electron_1.ipcRenderer.invoke("check-api-key"),
  validateApiKey: (apiKey) =>
    electron_1.ipcRenderer.invoke("validate-api-key", apiKey),
  openExternal: (url) => electron_1.ipcRenderer.invoke("openExternal", url),
  onApiKeyInvalid: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on(
      exports.PROCESSING_EVENTS.API_KEY_INVALID,
      subscription,
    );
    return () => {
      electron_1.ipcRenderer.removeListener(
        exports.PROCESSING_EVENTS.API_KEY_INVALID,
        subscription,
      );
    };
  },
  // Auth Methods (Overseas)
  authGetDevice: async () => electron_1.ipcRenderer.invoke("auth-get-device"),
  authLoadState: async () => electron_1.ipcRenderer.invoke("auth-load-state"),
  authSaveState: async (updates) =>
    electron_1.ipcRenderer.invoke("auth-save-state", updates),
  onAuthCallback: (callback) => {
    const subscription = (_, data) => callback(data);
    electron_1.ipcRenderer.on("auth-callback", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener("auth-callback", subscription);
    };
  },
  authClear: async () => electron_1.ipcRenderer.invoke("auth-clear"),
  // License methods
  licenseRefresh: (code) =>
    electron_1.ipcRenderer.invoke("license-refresh", code),
  licenseGetDevice: async () =>
    electron_1.ipcRenderer.invoke("license-get-device"),
  licenseLoadState: async () =>
    electron_1.ipcRenderer.invoke("license-load-state"),
  licenseSaveState: async (updates) =>
    electron_1.ipcRenderer.invoke("license-save-state", updates),
  removeListener: (eventName, callback) => {
    electron_1.ipcRenderer.removeListener(eventName, callback);
  },
  onDeleteLastScreenshot: (callback) => {
    const subscription = () => callback();
    electron_1.ipcRenderer.on("delete-last-screenshot", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener(
        "delete-last-screenshot",
        subscription,
      );
    };
  },
  deleteLastScreenshot: () =>
    electron_1.ipcRenderer.invoke("delete-last-screenshot"),
  // 🎤 Voice Recognition API
  startVoiceRecognition: () =>
    electron_1.ipcRenderer.invoke("start-voice-recognition"),
  stopVoiceRecognition: () =>
    electron_1.ipcRenderer.invoke("stop-voice-recognition"),
  onVoiceTranscript: (callback) => {
    const subscription = (_event, text) => callback(text);
    electron_1.ipcRenderer.on("voice-transcript-result", subscription);
    return () => {
      electron_1.ipcRenderer.removeListener(
        "voice-transcript-result",
        subscription,
      );
    };
  },
  onVoiceStatus: (callback) => {
    const subscription = (_event, status) => callback(status);
    electron_1.ipcRenderer.on("voice-status", subscription);
    return () =>
      electron_1.ipcRenderer.removeListener("voice-status", subscription);
  },
  getVoiceStatus: () => electron_1.ipcRenderer.invoke("get-voice-status"),
  onVoiceTranscriptResult: (callback) => {
    const subscription = (_event, text) => callback(text);
    electron_1.ipcRenderer.on("voice-transcript-result", subscription);
    return () =>
      electron_1.ipcRenderer.removeListener(
        "voice-transcript-result",
        subscription,
      );
  },
  onVoiceTranscriptDelta: (callback) => {
    const subscription = (_event, data) => callback(data);
    electron_1.ipcRenderer.on("voice-transcript-delta", subscription);
    return () =>
      electron_1.ipcRenderer.removeListener(
        "voice-transcript-delta",
        subscription,
      );
  },
  // Paraformer realtime APIs
  paraformerSessionStart: (options) =>
    electron_1.ipcRenderer.invoke("paraformer-session-start", options),
  paraformerSessionSend: (payload) =>
    electron_1.ipcRenderer.invoke("paraformer-session-send", payload),
  paraformerSessionFinish: (payload) =>
    electron_1.ipcRenderer.invoke("paraformer-session-finish", payload),
  paraformerSessionStop: (payload) =>
    electron_1.ipcRenderer.invoke("paraformer-session-stop", payload),
  onParaformerEvent: (callback) => {
    const subscription = (_event, data) => callback(data);
    electron_1.ipcRenderer.on("paraformer-event", subscription);
    return () =>
      electron_1.ipcRenderer.removeListener("paraformer-event", subscription);
  },
  // LiveTranslate realtime APIs
  liveTranslateSessionSend: (payload) =>
    electron_1.ipcRenderer.invoke("live-translate-session-send", payload),
  // Backward-compatible alias for older renderer code.
  gummySessionSend: (payload) =>
    electron_1.ipcRenderer.invoke("live-translate-session-send", payload),
  send: (channel, data) => {
    electron_1.ipcRenderer.send(channel, data);
  },
  onScreenshotCaptureLog: (callback) => {
    const listener = (_event, payload) => {
      callback(payload);
    };
    electron_1.ipcRenderer.on("screenshot-capture-log", listener);
    return () => {
      electron_1.ipcRenderer.removeListener("screenshot-capture-log", listener);
    };
  },
  // Knowledge Base (local BM25) utilities
  kbImportFiles: () => electron_1.ipcRenderer.invoke("kb-import-files"),
  kbClear: () => electron_1.ipcRenderer.invoke("kb-clear"),
  kbStats: () => electron_1.ipcRenderer.invoke("kb-stats"),
  kbRebuild: () => electron_1.ipcRenderer.invoke("kb-rebuild"),
  logToMain: (message) => electron_1.ipcRenderer.send("renderer-log", message),
};
// Before exposing the API
console.log(
  "About to expose electronAPI with methods:",
  Object.keys(electronAPI),
);
// Timing diagnostics use the existing bridge so run-prod prints them in its terminal.
electron_1.ipcRenderer.on("screenshot-taken", (_event, data) => {
  const id = data.path
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.png$/i, "");
  electron_1.ipcRenderer.send(
    "renderer-log",
    `[ScreenshotTiming][${id}] renderer_event at=${Date.now()}`,
  );
});
// Expose the API
electron_1.contextBridge.exposeInMainWorld("electronAPI", electronAPI);
console.log("electronAPI exposed to window");
// Add this focus restoration handler
electron_1.ipcRenderer.on("restore-focus", () => {
  // Try to focus the active element if it exists
  const activeElement = document.activeElement;
  if (activeElement && typeof activeElement.focus === "function") {
    activeElement.focus();
  }
});
// Remove auth-callback handling - no longer needed
