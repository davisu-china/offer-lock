"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShortcutsHelper = void 0;
const electron_1 = require("electron");
const ConfigHelper_1 = require("./ConfigHelper");
const AccessGuard_1 = require("./AccessGuard");
class ShortcutsHelper {
  constructor(deps) {
    this.deps = deps;
  }
  guardLicense() {
    return (0, AccessGuard_1.guardFeatureAccess)().ok;
  }
  adjustOpacity(delta) {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) return;
    let currentOpacity = mainWindow.getOpacity();
    let newOpacity = Math.max(0.1, Math.min(1.0, currentOpacity + delta));
    console.log(`Adjusting opacity from ${currentOpacity} to ${newOpacity}`);
    mainWindow.setOpacity(newOpacity);
    // Save the opacity setting to config without re-initializing the client
    try {
      const config = ConfigHelper_1.configHelper.loadConfig();
      config.opacity = newOpacity;
      ConfigHelper_1.configHelper.saveConfig(config);
    } catch (error) {
      console.error("Error saving opacity to config:", error);
    }
    // If we're making the window visible, also make sure it's shown and interaction is enabled
    if (newOpacity > 0.1 && !this.deps.isVisible()) {
      this.deps.toggleMainWindow();
    }
  }
  registerGlobalShortcuts() {
    electron_1.globalShortcut.register("CommandOrControl+H", async () => {
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow) {
        console.log("Taking screenshot...");
        try {
          if (!this.guardLicense()) return;
          const cfg = ConfigHelper_1.configHelper.loadConfig();
          const mode = cfg?.screenshotMode === "region" ? "region" : "full";
          const path =
            mode === "region"
              ? await this.deps.takeScreenshotWithRegion()
              : await this.deps.takeScreenshot();
          if (!path) return;
          const preview = await this.deps.getImagePreview(path);
          mainWindow.webContents.send("screenshot-taken", {
            path,
            preview,
          });
        } catch (error) {
          console.error("Error capturing screenshot:", error);
        }
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+Enter", async () => {
      console.log("Ctrl+Enter pressed. Sending screenshots only...");
      if (!this.guardLicense()) return;
      await this.deps.processingHelper?.processScreenshots();
    });
    // 🔤 新增：Ctrl+S 发送纯文本
    electron_1.globalShortcut.register("CommandOrControl+S", async () => {
      console.log("Ctrl+S pressed. Sending text only...");
      if (!this.guardLicense()) return;
      await this.deps.processingHelper?.processTextOnly();
    });
    electron_1.globalShortcut.register("CommandOrControl+Shift+S", async () => {
      if (!this.guardLicense()) return;
      try {
        await this.deps
          .getMainWindow()
          ?.webContents.executeJavaScript(
            "window.electronAPI.processTextOnly(undefined, true)",
          );
      } catch (error) {
        console.error("Failed to send recent transcripts:", error);
      }
    });
    // 🔄 新增：Ctrl+D 发送文本+截图组合
    electron_1.globalShortcut.register("CommandOrControl+D", async () => {
      console.log("Ctrl+D pressed. Sending text + screenshots...");
      if (!this.guardLicense()) return;
      await this.deps.processingHelper?.processWithInput();
    });
    electron_1.globalShortcut.register("CommandOrControl+R", () => {
      console.log(
        "Command + R pressed. Canceling requests and resetting queues...",
      );
      const result = this.deps.triggerReset();
      if (!result.success) {
        console.error("Failed to reset via shortcut:", result.error);
      }
    });
    // New shortcuts for moving the window
    electron_1.globalShortcut.register("CommandOrControl+Left", () => {
      console.log("Command/Ctrl + Left pressed. Moving window left.");
      this.deps.moveWindowLeft();
    });
    electron_1.globalShortcut.register("CommandOrControl+Right", () => {
      console.log("Command/Ctrl + Right pressed. Moving window right.");
      this.deps.moveWindowRight();
    });
    electron_1.globalShortcut.register("CommandOrControl+Down", () => {
      console.log("Command/Ctrl + down pressed. Moving window down.");
      this.deps.moveWindowDown();
    });
    electron_1.globalShortcut.register("CommandOrControl+Up", () => {
      console.log("Command/Ctrl + Up pressed. Moving window Up.");
      this.deps.moveWindowUp();
    });
    electron_1.globalShortcut.register("CommandOrControl+Shift+Up", () => {
      console.log(
        "Command/Ctrl + Shift + Up pressed. Scrolling answer content up.",
      );
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("answer-scroll", { direction: "up" });
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+Shift+Down", () => {
      console.log(
        "Command/Ctrl + Shift + Down pressed. Scrolling answer content down.",
      );
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("answer-scroll", { direction: "down" });
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+B", () => {
      console.log("Command/Ctrl + B pressed. Toggling window visibility.");
      this.deps.toggleMainWindow();
    });
    electron_1.globalShortcut.register("CommandOrControl+Q", () => {
      console.log("Command/Ctrl + Q pressed. Quitting application.");
      electron_1.app.quit();
    });
    // Adjust opacity shortcuts
    electron_1.globalShortcut.register("CommandOrControl+[", () => {
      console.log("Command/Ctrl + [ pressed. Decreasing opacity.");
      this.adjustOpacity(-0.1);
    });
    electron_1.globalShortcut.register("CommandOrControl+]", () => {
      console.log("Command/Ctrl + ] pressed. Increasing opacity.");
      this.adjustOpacity(0.1);
    });
    // Zoom controls
    electron_1.globalShortcut.register("CommandOrControl+-", () => {
      console.log("Command/Ctrl + - pressed. Zooming out.");
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel();
        mainWindow.webContents.setZoomLevel(currentZoom - 0.5);
        this.deps.resizeSolutionsForZoom();
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+0", () => {
      console.log("Command/Ctrl + 0 pressed. Resetting zoom.");
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel();
        mainWindow.webContents.setZoomLevel(0);
        this.deps.resizeSolutionsForZoom();
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+=", () => {
      console.log("Command/Ctrl + = pressed. Zooming in.");
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel();
        mainWindow.webContents.setZoomLevel(currentZoom + 0.5);
        this.deps.resizeSolutionsForZoom();
      }
    });
    // Delete last screenshot and clear text shortcut
    electron_1.globalShortcut.register("CommandOrControl+L", () => {
      console.log(
        "Command/Ctrl + L pressed. Deleting last screenshot and clearing text.",
      );
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow) {
        // Send an event to the renderer to delete the last screenshot
        mainWindow.webContents.send("delete-last-screenshot");
        // Send an event to clear text input
        mainWindow.webContents.send("clear-text-input");
      }
    });
    // Switch answer page: prev/next
    electron_1.globalShortcut.register("CommandOrControl+,", () => {
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("switch-page", { direction: "prev" });
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+Shift+,", () => {
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("switch-page", { direction: "prev" });
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+.", () => {
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("switch-page", { direction: "next" });
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+Shift+.", () => {
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("switch-page", { direction: "next" });
      }
    });
    // Answer font size controls
    electron_1.globalShortcut.register("CommandOrControl+Shift+=", () => {
      console.log(
        "Command/Ctrl + Shift + = pressed. Increasing answer font size.",
      );
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("answer-font-size", { delta: 0.2 });
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+Shift+-", () => {
      console.log(
        "Command/Ctrl + Shift + - pressed. Decreasing answer font size.",
      );
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("answer-font-size", { delta: -0.08 });
      }
    });
    electron_1.globalShortcut.register("CommandOrControl+Shift+0", () => {
      console.log(
        "Command/Ctrl + Shift + 0 pressed. Resetting answer font size.",
      );
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("answer-font-size", { reset: true });
      }
    });
    // Unregister shortcuts when quitting
    electron_1.app.on("will-quit", () => {
      electron_1.globalShortcut.unregisterAll();
    });
  }
}
exports.ShortcutsHelper = ShortcutsHelper;
