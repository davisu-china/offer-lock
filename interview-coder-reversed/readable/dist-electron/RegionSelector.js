"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegionSelector = void 0;
const electron_1 = require("electron");
// Canonical CommonJS import for uiohook-napi
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uIOhook } = require("uiohook-napi");
class RegionSelector {
  constructor(deps) {
    this.deps = deps;
    this.isSelecting = false;
    this.lastReason = null;
  }
  getLastReason() {
    return this.lastReason;
  }
  getPhysicalDisplays() {
    const displays = electron_1.screen.getAllDisplays();
    return displays.map((d) => {
      const sf = d.scaleFactor || 1;
      const leftPx = Math.floor(d.bounds.x * sf);
      const topPx = Math.floor(d.bounds.y * sf);
      const rightPx = Math.floor((d.bounds.x + d.bounds.width) * sf);
      const bottomPx = Math.floor((d.bounds.y + d.bounds.height) * sf);
      return {
        id: d.id,
        leftPx,
        topPx,
        rightPx,
        bottomPx,
        scaleFactor: sf,
        bounds: d.bounds,
      };
    });
  }
  findDisplayAtPx(x, y) {
    const list = this.getPhysicalDisplays();
    for (const pd of list) {
      if (x >= pd.leftPx && x < pd.rightPx && y >= pd.topPx && y < pd.bottomPx)
        return pd;
    }
    return null;
  }
  getVirtualOriginPx() {
    const list = this.getPhysicalDisplays();
    const leftPx = Math.min(...list.map((d) => d.leftPx));
    const topPx = Math.min(...list.map((d) => d.topPx));
    return { leftPx, topPx };
  }
  async selectRegion(timeoutMs = 15000) {
    if (this.isSelecting) return null;
    this.isSelecting = true;
    this.lastReason = null;
    // Minimal guard: ensure uIOhook has expected API
    if (
      !uIOhook ||
      typeof uIOhook.on !== "function" ||
      typeof uIOhook.start !== "function"
    ) {
      this.lastReason = "module_invalid";
      console.error(
        "[RegionSelector] uIOhook invalid. Ensure electron-rebuild for uiohook-napi.",
      );
      this.isSelecting = false;
      return null;
    }
    let resolveFn;
    const result = new Promise((resolve) => (resolveFn = resolve));
    let first = null;
    const cleanup = () => {
      try {
        uIOhook.removeListener("mouseup", onMouseUp);
      } catch {}
      try {
        uIOhook.removeListener("keydown", onKeyDown);
      } catch {}
      this.isSelecting = false;
    };
    const onMouseUp = (e) => {
      try {
        if (e?.button !== 1) return; // left only
        const px = Number(e.x) || 0;
        const py = Number(e.y) || 0;
        const disp = this.findDisplayAtPx(px, py);
        if (!first) {
          first = { x: px, y: py, disp };
          return;
        }
        // second point
        if (!disp || !first.disp || disp.id !== first.disp.id) {
          this.lastReason = "cross_display";
          cleanup();
          resolveFn(null);
          return;
        }
        const x1 = Math.min(first.x, px);
        const y1 = Math.min(first.y, py);
        const w = Math.max(1, Math.abs(px - first.x));
        const h = Math.max(1, Math.abs(py - first.y));
        const { leftPx: virtLeftPhysical, topPx: virtTopPhysical } =
          this.getVirtualOriginPx();
        const normX = Math.max(0, x1 - virtLeftPhysical);
        const normY = Math.max(0, y1 - virtTopPhysical);
        const display = first.disp;
        const displayId = display?.id ?? -1;
        const scaleFactor = display?.scaleFactor ?? 1;
        cleanup();
        resolveFn({
          x: Math.floor(normX),
          y: Math.floor(normY),
          width: Math.floor(w),
          height: Math.floor(h),
          absoluteX: Math.floor(x1),
          absoluteY: Math.floor(y1),
          displayId,
          scaleFactor,
        });
      } catch (err) {
        console.error("[RegionSelector] mouseup handler error:", err);
      }
    };
    const onKeyDown = (e) => {
      if (e && (e.keycode === 41 || e.keycode === 1)) {
        // ESC
        this.lastReason = "esc_cancelled";
        cleanup();
        resolveFn(null);
      }
    };
    try {
      uIOhook.on("mouseup", onMouseUp);
      uIOhook.on("keydown", onKeyDown);
      if (!this.deps.ensureHookStarted()) {
        throw new Error("Shared mouse hook could not be started");
      }
    } catch (err) {
      this.lastReason = "start_failed";
      console.error("[RegionSelector] Shared mouse hook failed:", err);
      cleanup();
      resolveFn(null);
    }
    const timer = setTimeout(
      () => {
        this.lastReason = "timeout";
        cleanup();
        resolveFn(null);
      },
      Math.max(3000, timeoutMs),
    );
    return result.finally(() => clearTimeout(timer));
  }
}
exports.RegionSelector = RegionSelector;
