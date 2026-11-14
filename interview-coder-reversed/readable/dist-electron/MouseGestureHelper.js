"use strict";
// MouseGestureHelper.ts
//
// Persistent global mouse listener shared with region selection.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MouseGestureHelper = void 0;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uIOhook } = require("uiohook-napi");
class MouseGestureHelper {
  constructor(deps) {
    this.CLICK_INTERVAL_MS = 450;
    this.MAX_CLICK_DISTANCE_PX = 12;
    this.clicks = [];
    this.isListening = false;
    this.isCapturing = false;
    this.isPaused = false;
    this.onMouseUp = (event) => {
      // uiohook-napi uses button value 1 for the primary (left) mouse button.
      if (this.isPaused || this.isCapturing || event?.button !== 1) return;
      const now = Date.now();
      this.clicks.push({
        at: now,
        x: Number(event.x) || 0,
        y: Number(event.y) || 0,
      });
      this.clicks = this.clicks.filter(
        (click) => now - click.at <= this.CLICK_INTERVAL_MS,
      );
      if (this.clicks.length < 3) return;
      const first = this.clicks[0];
      const isSameLocation = this.clicks.every(
        (click) =>
          Math.abs(click.x - first.x) <= this.MAX_CLICK_DISTANCE_PX &&
          Math.abs(click.y - first.y) <= this.MAX_CLICK_DISTANCE_PX,
      );
      this.clicks = [];
      if (!isSameLocation) return;
      void this.triggerScreenshot();
    };
    this.deps = deps;
  }
  /** Starts the shared native hook once; region selection reuses it. */
  start() {
    if (this.isListening) return true;
    if (!this.isHookAvailable()) return false;
    try {
      uIOhook.on("mouseup", this.onMouseUp);
      uIOhook.start();
      this.isListening = true;
      console.log("[MouseGesture] Global triple-click listener started");
      return true;
    } catch (error) {
      // A failed native hook must not prevent the rest of the Electron app from starting.
      try {
        uIOhook.removeListener("mouseup", this.onMouseUp);
      } catch {}
      console.warn(
        "[MouseGesture] Failed to start global mouse listener:",
        error,
      );
      return false;
    }
  }
  pause() {
    this.isPaused = true;
    this.clicks = [];
  }
  resume() {
    this.clicks = [];
    this.isPaused = false;
  }
  /** Releases the shared native hook when the application shuts down. */
  stop() {
    this.clicks = [];
    if (!this.isListening) return;
    try {
      uIOhook.removeListener("mouseup", this.onMouseUp);
    } catch {}
    try {
      uIOhook.stop();
    } catch {}
    this.isListening = false;
    console.log("[MouseGesture] Global triple-click listener stopped");
  }
  isHookAvailable() {
    if (
      uIOhook &&
      typeof uIOhook.on === "function" &&
      typeof uIOhook.start === "function"
    ) {
      return true;
    }
    console.warn(
      "[MouseGesture] uIOhook is unavailable; triple-click screenshot disabled",
    );
    return false;
  }
  async triggerScreenshot() {
    if (this.isCapturing) return;
    this.isCapturing = true;
    try {
      await this.deps.triggerScreenshot();
    } catch (error) {
      console.error("[MouseGesture] Screenshot trigger failed:", error);
    } finally {
      this.clicks = [];
      this.isCapturing = false;
    }
  }
}
exports.MouseGestureHelper = MouseGestureHelper;
