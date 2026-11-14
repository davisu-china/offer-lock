"use strict";
// ScreenshotHelper.ts
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScreenshotHelper = void 0;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const electron_1 = require("electron");
const uuid_1 = require("uuid");
const child_process_1 = require("child_process");
const util_1 = require("util");
const screenshot_desktop_1 = __importDefault(require("screenshot-desktop"));
const WindowsScreenshotWorker_1 = require("./WindowsScreenshotWorker");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
class ScreenshotHelper {
  dispose() {
    this.disposed = true;
    this.windowsWorker?.dispose();
  }
  constructor(view = "queue", captureLogFn) {
    this.screenshotQueue = [];
    this.extraScreenshotQueue = [];
    this.MAX_SCREENSHOTS = 5;
    this.windowsWorker =
      process.platform === "win32"
        ? new WindowsScreenshotWorker_1.WindowsScreenshotWorker()
        : null;
    this.disposed = false;
    this.view = "queue";
    this.view = view;
    this.captureLogFn = captureLogFn;
    // Initialize directories
    this.screenshotDir = node_path_1.default.join(
      electron_1.app.getPath("userData"),
      "screenshots",
    );
    this.extraScreenshotDir = node_path_1.default.join(
      electron_1.app.getPath("userData"),
      "extra_screenshots",
    );
    this.tempDir = node_path_1.default.join(
      electron_1.app.getPath("temp"),
      "interview-coder-screenshots",
    );
    // Create directories if they don't exist
    this.ensureDirectoriesExist();
    // Clean existing screenshot directories when starting the app
    this.cleanScreenshotDirectories();
  }
  emitCapturePath(path) {
    try {
      this.captureLogFn?.(path);
    } catch (err) {
      console.warn("captureLogFn failed", err);
    }
  }
  ensureDirectoriesExist() {
    const directories = [
      this.screenshotDir,
      this.extraScreenshotDir,
      this.tempDir,
    ];
    for (const dir of directories) {
      if (!node_fs_1.default.existsSync(dir)) {
        try {
          node_fs_1.default.mkdirSync(dir, { recursive: true });
          console.log(`Created directory: ${dir}`);
        } catch (err) {
          console.error(`Error creating directory ${dir}:`, err);
        }
      }
    }
  }
  // This method replaces loadExistingScreenshots() to ensure we start with empty queues
  cleanScreenshotDirectories() {
    try {
      // Clean main screenshots directory
      if (node_fs_1.default.existsSync(this.screenshotDir)) {
        const files = node_fs_1.default
          .readdirSync(this.screenshotDir)
          .filter((file) => file.endsWith(".png"))
          .map((file) => node_path_1.default.join(this.screenshotDir, file));
        // Delete each screenshot file
        for (const file of files) {
          try {
            node_fs_1.default.unlinkSync(file);
            console.log(`Deleted existing screenshot: ${file}`);
          } catch (err) {
            console.error(`Error deleting screenshot ${file}:`, err);
          }
        }
      }
      // Clean extra screenshots directory
      if (node_fs_1.default.existsSync(this.extraScreenshotDir)) {
        const files = node_fs_1.default
          .readdirSync(this.extraScreenshotDir)
          .filter((file) => file.endsWith(".png"))
          .map((file) =>
            node_path_1.default.join(this.extraScreenshotDir, file),
          );
        // Delete each screenshot file
        for (const file of files) {
          try {
            node_fs_1.default.unlinkSync(file);
            console.log(`Deleted existing extra screenshot: ${file}`);
          } catch (err) {
            console.error(`Error deleting extra screenshot ${file}:`, err);
          }
        }
      }
      console.log("Screenshot directories cleaned successfully");
    } catch (err) {
      console.error("Error cleaning screenshot directories:", err);
    }
  }
  getView() {
    return this.view;
  }
  setView(view) {
    console.log("Setting view in ScreenshotHelper:", view);
    console.log(
      "Current queues - Main:",
      this.screenshotQueue,
      "Extra:",
      this.extraScreenshotQueue,
    );
    this.view = view;
  }
  getScreenshotQueue() {
    return this.screenshotQueue;
  }
  getExtraScreenshotQueue() {
    console.log("Getting extra screenshot queue:", this.extraScreenshotQueue);
    return this.extraScreenshotQueue;
  }
  clearQueues() {
    // Clear screenshotQueue
    this.screenshotQueue.forEach((screenshotPath) => {
      node_fs_1.default.unlink(screenshotPath, (err) => {
        if (err)
          console.error(`Error deleting screenshot at ${screenshotPath}:`, err);
      });
    });
    this.screenshotQueue = [];
    // Clear extraScreenshotQueue
    this.extraScreenshotQueue.forEach((screenshotPath) => {
      node_fs_1.default.unlink(screenshotPath, (err) => {
        if (err)
          console.error(
            `Error deleting extra screenshot at ${screenshotPath}:`,
            err,
          );
      });
    });
    this.extraScreenshotQueue = [];
  }
  async captureScreenshot(region, traceId) {
    try {
      console.log("Starting screenshot capture...");
      if (process.platform === "win32") {
        return await this.captureWindowsScreenshot(region, traceId);
      }
      // macOS / Linux path: capture full screen, crop if region provided
      const buffer = await (0, screenshot_desktop_1.default)({ format: "png" });
      console.log(
        `Screenshot captured successfully, size: ${buffer.length} bytes`,
      );
      if (region) {
        return this.cropBufferToRegion(buffer, region);
      }
      return buffer;
    } catch (error) {
      console.error("Error capturing screenshot:", error);
      throw new Error(
        `Failed to capture screenshot: ${error?.message || error}`,
      );
    }
  }
  getVirtualDesktopPhysicalBounds() {
    const displays = electron_1.screen.getAllDisplays();
    if (!displays.length) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }
    const left = Math.min(
      ...displays.map((d) =>
        Math.floor((d.bounds.x || 0) * (d.scaleFactor || 1)),
      ),
    );
    const top = Math.min(
      ...displays.map((d) =>
        Math.floor((d.bounds.y || 0) * (d.scaleFactor || 1)),
      ),
    );
    const right = Math.max(
      ...displays.map((d) =>
        Math.floor((d.bounds.x + d.bounds.width) * (d.scaleFactor || 1)),
      ),
    );
    const bottom = Math.max(
      ...displays.map((d) =>
        Math.floor((d.bounds.y + d.bounds.height) * (d.scaleFactor || 1)),
      ),
    );
    return {
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }
  // Windows warm-worker optimization. Keep the original one-shot method below as
  // fallback. Rollback: call captureWindowsDpiAwareOnce directly, then remove the
  // worker import/fields/dispose hook and the main.ts Windows task wrappers.
  async captureWindowsDpiAware(bounds, traceId) {
    if (!this.windowsWorker)
      return this.captureWindowsDpiAwareOnce(bounds, traceId);
    const tempFile = node_path_1.default.join(
      this.tempDir,
      `worker-${(0, uuid_1.v4)()}.png`,
    );
    try {
      await this.windowsWorker.capture(
        {
          left: Math.floor(bounds.left),
          top: Math.floor(bounds.top),
          width: Math.max(1, Math.floor(bounds.width)),
          height: Math.max(1, Math.floor(bounds.height)),
        },
        tempFile,
        traceId || "unknown",
      );
      const started = performance.now();
      const buffer = await node_fs_1.default.promises.readFile(tempFile);
      if (!buffer.length)
        throw new Error("Screenshot worker returned an empty image");
      console.log(
        `[ScreenshotTiming][${traceId || "unknown"}] worker_read=${(performance.now() - started).toFixed(1)}ms bytes=${buffer.length}`,
      );
      return buffer;
    } catch (error) {
      if (this.disposed) throw error; // Do not spawn a fallback process while quitting.
      console.warn(
        `[ScreenshotTiming][${traceId || "unknown"}] worker failed; using original one-shot capture`,
        error,
      );
      return await this.captureWindowsDpiAwareOnce(bounds, traceId);
    } finally {
      try {
        await node_fs_1.default.promises.unlink(tempFile);
      } catch {
        /* No file if worker failed before saving. */
      }
    }
  }
  async captureWindowsDpiAwareOnce(bounds, traceId) {
    const normalized = {
      left: Math.floor(bounds.left),
      top: Math.floor(bounds.top),
      width: Math.max(1, Math.floor(bounds.width)),
      height: Math.max(1, Math.floor(bounds.height)),
    };
    const tempFile = node_path_1.default.join(
      this.tempDir,
      `ps-dpi-${(0, uuid_1.v4)()}.png`,
    );
    const escapedPath = tempFile.replace(/\\/g, "\\\\");
    const psScript = `
$ErrorActionPreference = 'Stop'
# Diagnostics only: retain the existing capture order and report timings as one JSON line.
$scriptEntryMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$scriptClock = [System.Diagnostics.Stopwatch]::StartNew()
$stageClock = [System.Diagnostics.Stopwatch]::StartNew()
$timings = [ordered]@{ script_entry_unix_ms = $scriptEntryMs }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DpiHelper {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
}
"@
$timings.dpi_compile_ms = $stageClock.Elapsed.TotalMilliseconds
$stageClock.Restart()
[DpiHelper]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$timings.dpi_apply_ms = $stageClock.Elapsed.TotalMilliseconds
$stageClock.Restart()
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$timings.assembly_load_ms = $stageClock.Elapsed.TotalMilliseconds
$stageClock.Restart()
$rect = New-Object System.Drawing.Rectangle(${normalized.left}, ${normalized.top}, ${normalized.width}, ${normalized.height})
$bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$timings.bitmap_setup_ms = $stageClock.Elapsed.TotalMilliseconds
$stageClock.Restart()
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $rect.Size)
$timings.copy_screen_ms = $stageClock.Elapsed.TotalMilliseconds
$stageClock.Restart()
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$timings.png_write_ms = $stageClock.Elapsed.TotalMilliseconds
$stageClock.Restart()
$graphics.Dispose()
$bmp.Dispose()
$timings.dispose_ms = $stageClock.Elapsed.TotalMilliseconds
$timings.script_total_ms = $scriptClock.Elapsed.TotalMilliseconds
Write-Output ('SCREENSHOT_TIMING_JSON:' + ($timings | ConvertTo-Json -Compress))
`;
    const powershellStarted = performance.now();
    const powershellStartedAt = Date.now();
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      psScript,
    ]);
    const powershellMs = performance.now() - powershellStarted;
    console.log(
      `[ScreenshotTiming][${traceId || "unknown"}] powershell=${powershellMs.toFixed(1)}ms (process startup + Add-Type + capture + PNG write)`,
    );
    // Rollback: remove the PowerShell stopwatch statements and this parser together.
    // A missing/malformed diagnostic line must not fail an otherwise successful capture.
    try {
      const line = String(stdout)
        .split(/\r?\n/)
        .find((line) => line.startsWith("SCREENSHOT_TIMING_JSON:"));
      if (!line) throw new Error("PowerShell timing line missing");
      const timings = JSON.parse(line.slice("SCREENSHOT_TIMING_JSON:".length));
      for (const stage of [
        "dpi_compile_ms",
        "dpi_apply_ms",
        "assembly_load_ms",
        "bitmap_setup_ms",
        "copy_screen_ms",
        "png_write_ms",
        "dispose_ms",
        "script_total_ms",
      ]) {
        if (
          typeof timings[stage] === "number" &&
          Number.isFinite(timings[stage]) &&
          timings[stage] >= 0
        ) {
          console.log(
            `[ScreenshotTiming][${traceId || "unknown"}] ps_${stage}=${timings[stage].toFixed(1)}ms`,
          );
        }
      }
      if (Number.isFinite(timings.script_total_ms)) {
        console.log(
          `[ScreenshotTiming][${traceId || "unknown"}] ps_process_overhead=${Math.max(0, powershellMs - timings.script_total_ms).toFixed(1)}ms (startup + exit + output handling)`,
        );
      }
      if (Number.isFinite(timings.script_entry_unix_ms)) {
        console.log(
          `[ScreenshotTiming][${traceId || "unknown"}] ps_launch_to_script_approx=${Math.max(0, timings.script_entry_unix_ms - powershellStartedAt).toFixed(1)}ms (wall-clock estimate)`,
        );
      }
    } catch (error) {
      console.warn(
        `[ScreenshotTiming][${traceId || "unknown"}] detailed timing unavailable`,
        error,
      );
    }
    try {
      const readStarted = performance.now();
      const buffer = await node_fs_1.default.promises.readFile(tempFile);
      console.log(
        `[ScreenshotTiming][${traceId || "unknown"}] temp_read=${(performance.now() - readStarted).toFixed(1)}ms bytes=${buffer.length}`,
      );
      console.log(
        "Windows DPI-aware screenshot succeeded:",
        `${buffer.length} bytes (${normalized.width}x${normalized.height})`,
      );
      return buffer;
    } finally {
      try {
        await node_fs_1.default.promises.unlink(tempFile);
      } catch (cleanupErr) {
        console.warn("Failed to remove temporary screenshot file:", cleanupErr);
      }
    }
  }
  async captureWindowsScreenshot(region, traceId) {
    try {
      const bounds = region
        ? {
            left: region.absoluteX,
            top: region.absoluteY,
            width: region.width,
            height: region.height,
          }
        : this.getVirtualDesktopPhysicalBounds();
      const buffer = await this.captureWindowsDpiAware(bounds, traceId);
      this.emitCapturePath("dpi-aware");
      return buffer;
    } catch (err) {
      if (this.disposed) throw err; // Quit must not launch any legacy fallback either.
      console.warn(
        `[ScreenshotTiming][${traceId || "unknown"}] DPI-aware failed; entering legacy fallback`,
        err,
      );
    }
    const legacyStarted = performance.now();
    const legacyBuffer = await this.captureWindowsScreenshotLegacy(region);
    console.log(
      `[ScreenshotTiming][${traceId || "unknown"}] legacy_fallback=${(performance.now() - legacyStarted).toFixed(1)}ms`,
    );
    if (!region) {
      return legacyBuffer;
    }
    if (!legacyBuffer || legacyBuffer.length === 0) {
      throw new Error("Legacy screenshot capture returned empty buffer");
    }
    this.emitCapturePath("fallback");
    return this.cropBufferToRegion(legacyBuffer, region);
  }
  /**
   * Windows-specific screenshot capture with multiple fallback mechanisms
   */
  async captureWindowsScreenshotLegacy(region) {
    console.log("Attempting Windows screenshot with multiple methods");
    // Method 1: Try screenshot-desktop with filename first
    try {
      const tempFile = node_path_1.default.join(
        this.tempDir,
        `temp-${(0, uuid_1.v4)()}.png`,
      );
      console.log(
        `Taking Windows screenshot to temp file (Method 1): ${tempFile}`,
      );
      await (0, screenshot_desktop_1.default)({ filename: tempFile });
      if (node_fs_1.default.existsSync(tempFile)) {
        const buffer = await node_fs_1.default.promises.readFile(tempFile);
        console.log(
          `Method 1 successful, screenshot size: ${buffer.length} bytes`,
        );
        this.emitCapturePath("legacy-method1");
        // Cleanup temp file
        try {
          await node_fs_1.default.promises.unlink(tempFile);
        } catch (cleanupErr) {
          console.warn("Failed to clean up temp file:", cleanupErr);
        }
        if (region) {
          console.log("Cropping legacy screenshot to requested region");
          return this.cropBufferToRegion(buffer, region);
        }
        this.emitCapturePath("legacy-method1");
        return buffer;
      }
      console.log("Method 1 failed: File not created");
      throw new Error("Screenshot file not created");
    } catch (error) {
      console.warn("Windows screenshot Method 1 failed:", error);
      // Method 2: Try using PowerShell
      try {
        console.log("Attempting Windows screenshot with PowerShell (Method 2)");
        const tempFile = node_path_1.default.join(
          this.tempDir,
          `ps-temp-${(0, uuid_1.v4)()}.png`,
        );
        // PowerShell command to take screenshot using .NET classes
        const psScript = `
        Add-Type -AssemblyName System.Windows.Forms,System.Drawing
        $screens = [System.Windows.Forms.Screen]::AllScreens
        $top = ($screens | ForEach-Object {$_.Bounds.Top} | Measure-Object -Minimum).Minimum
        $left = ($screens | ForEach-Object {$_.Bounds.Left} | Measure-Object -Minimum).Minimum
        $width = ($screens | ForEach-Object {$_.Bounds.Right} | Measure-Object -Maximum).Maximum
        $height = ($screens | ForEach-Object {$_.Bounds.Bottom} | Measure-Object -Maximum).Maximum
        $bounds = [System.Drawing.Rectangle]::FromLTRB($left, $top, $width, $height)
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bmp)
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
        $bmp.Save('${tempFile.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bmp.Dispose()
        `;
        // Execute PowerShell
        await execFileAsync("powershell", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          psScript,
        ]);
        // Check if file exists and read it
        if (node_fs_1.default.existsSync(tempFile)) {
          try {
            const buffer = await node_fs_1.default.promises.readFile(tempFile);
            console.log(
              `Method 2 successful, screenshot size: ${buffer.length} bytes`,
            );
            if (region) {
              console.log("Cropping PowerShell screenshot to requested region");
              return this.cropBufferToRegion(buffer, region);
            }
            this.emitCapturePath("legacy-method2");
            return buffer;
          } finally {
            try {
              await node_fs_1.default.promises.unlink(tempFile);
            } catch (err) {
              console.warn("Failed to clean up PowerShell temp file:", err);
            }
          }
        }
        throw new Error("PowerShell screenshot file not created");
      } catch (psError) {
        console.warn("Windows PowerShell screenshot failed:", psError);
        // Method 3: Last resort - create a tiny placeholder image
        console.log(
          "All screenshot methods failed, creating placeholder image",
        );
        // Create a 1x1 transparent PNG as fallback
        const fallbackBuffer = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        );
        console.log("Created placeholder image as fallback");
        // Show the error but return a valid buffer so the app doesn't crash
        throw new Error(
          "Could not capture screenshot with any method. Please check your Windows security settings and try again.",
        );
      }
    }
  }
  async takeScreenshot(hideMainWindow, showMainWindow, region) {
    if (this.disposed) throw new Error("Screenshot helper disposed");
    // Diagnostic only: the same UUID identifies capture, history, previews and image load.
    const traceId = (0, uuid_1.v4)();
    const started = performance.now();
    let stageStarted = started;
    console.log(
      `[ScreenshotTiming][${traceId}] start at=${Date.now()} view=${this.view} mode=${region ? "region" : "full"}`,
    );
    console.log("Taking screenshot in view:", this.view);
    hideMainWindow();
    // Increased delay for window hiding on Windows
    const hideDelay = process.platform === "win32" ? 500 : 300;
    await new Promise((resolve) => setTimeout(resolve, hideDelay));
    console.log(
      `[ScreenshotTiming][${traceId}] hide_wait=${(performance.now() - stageStarted).toFixed(1)}ms configured=${hideDelay}ms`,
    );
    let screenshotPath = "";
    try {
      stageStarted = performance.now();
      const screenshotBuffer = await this.captureScreenshot(region, traceId);
      console.log(
        `[ScreenshotTiming][${traceId}] capture=${(performance.now() - stageStarted).toFixed(1)}ms bytes=${screenshotBuffer?.length || 0}`,
      );
      if (!screenshotBuffer || screenshotBuffer.length === 0) {
        throw new Error("Screenshot capture returned empty buffer");
      }
      stageStarted = performance.now();
      // Save and manage the screenshot based on current view
      if (this.view === "queue") {
        screenshotPath = node_path_1.default.join(
          this.screenshotDir,
          `${traceId}.png`,
        );
        await node_fs_1.default.promises.writeFile(
          screenshotPath,
          screenshotBuffer,
        );
        console.log("Adding screenshot to main queue:", screenshotPath);
        this.screenshotQueue.push(screenshotPath);
        if (this.screenshotQueue.length > this.MAX_SCREENSHOTS) {
          const removedPath = this.screenshotQueue.shift();
          if (removedPath) {
            try {
              await node_fs_1.default.promises.unlink(removedPath);
              console.log(
                "Removed old screenshot from main queue:",
                removedPath,
              );
            } catch (error) {
              console.error("Error removing old screenshot:", error);
            }
          }
        }
      } else {
        // In solutions view, only add to extra queue
        screenshotPath = node_path_1.default.join(
          this.extraScreenshotDir,
          `${traceId}.png`,
        );
        await node_fs_1.default.promises.writeFile(
          screenshotPath,
          screenshotBuffer,
        );
        console.log("Adding screenshot to extra queue:", screenshotPath);
        this.extraScreenshotQueue.push(screenshotPath);
        if (this.extraScreenshotQueue.length > this.MAX_SCREENSHOTS) {
          const removedPath = this.extraScreenshotQueue.shift();
          if (removedPath) {
            try {
              await node_fs_1.default.promises.unlink(removedPath);
              console.log(
                "Removed old screenshot from extra queue:",
                removedPath,
              );
            } catch (error) {
              console.error("Error removing old screenshot:", error);
            }
          }
        }
      }
      console.log(
        `[ScreenshotTiming][${traceId}] save_queue=${(performance.now() - stageStarted).toFixed(1)}ms`,
      );
    } catch (error) {
      console.error(
        `[ScreenshotTiming][${traceId}] failed elapsed=${(performance.now() - started).toFixed(1)}ms`,
        error,
      );
      console.error("Screenshot error:", error);
      throw error;
    } finally {
      // Increased delay for showing window again (unchanged by timing logs).
      stageStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 200));
      showMainWindow();
      console.log(
        `[ScreenshotTiming][${traceId}] restore_wait=${(performance.now() - stageStarted).toFixed(1)}ms configured=200ms`,
      );
      console.log(
        `[ScreenshotTiming][${traceId}] capture_to_restore=${(performance.now() - started).toFixed(1)}ms (excludes history/preview/UI)`,
      );
    }
    return screenshotPath;
  }
  async getImagePreview(filepath) {
    const started = performance.now();
    const traceId = node_path_1.default.basename(
      filepath,
      node_path_1.default.extname(filepath),
    );
    try {
      if (!node_fs_1.default.existsSync(filepath)) {
        console.error(`Image file not found: ${filepath}`);
        return "";
      }
      const data = await node_fs_1.default.promises.readFile(filepath);
      const readMs = performance.now() - started;
      const encodeStarted = performance.now();
      const preview = `data:image/png;base64,${data.toString("base64")}`;
      console.log(
        `[ScreenshotTiming][${traceId}] preview_read=${readMs.toFixed(1)}ms base64=${(performance.now() - encodeStarted).toFixed(1)}ms bytes=${data.length}`,
      );
      return preview;
    } catch (error) {
      console.error("Error reading image:", error);
      return "";
    }
  }
  async deleteScreenshot(path) {
    try {
      if (node_fs_1.default.existsSync(path)) {
        await node_fs_1.default.promises.unlink(path);
      }
      if (this.view === "queue") {
        this.screenshotQueue = this.screenshotQueue.filter(
          (filePath) => filePath !== path,
        );
      } else {
        this.extraScreenshotQueue = this.extraScreenshotQueue.filter(
          (filePath) => filePath !== path,
        );
      }
      return { success: true };
    } catch (error) {
      console.error("Error deleting file:", error);
      return { success: false, error: error.message };
    }
  }
  clearExtraScreenshotQueue() {
    // Clear extraScreenshotQueue
    this.extraScreenshotQueue.forEach((screenshotPath) => {
      if (node_fs_1.default.existsSync(screenshotPath)) {
        node_fs_1.default.unlink(screenshotPath, (err) => {
          if (err)
            console.error(
              `Error deleting extra screenshot at ${screenshotPath}:`,
              err,
            );
        });
      }
    });
    this.extraScreenshotQueue = [];
  }
  removeExtraScreenshots(paths) {
    const requested = new Set(paths);
    const consumed = this.extraScreenshotQueue.filter((screenshotPath) =>
      requested.has(screenshotPath),
    );
    this.extraScreenshotQueue = this.extraScreenshotQueue.filter(
      (screenshotPath) => !requested.has(screenshotPath),
    );
    consumed.forEach((screenshotPath) => {
      if (!node_fs_1.default.existsSync(screenshotPath)) return;
      node_fs_1.default.unlink(screenshotPath, (err) => {
        if (err) {
          console.error(
            `Error deleting consumed screenshot at ${screenshotPath}:`,
            err,
          );
        }
      });
    });
  }
  cropBufferToRegion(buffer, region) {
    try {
      const img = electron_1.nativeImage.createFromBuffer(buffer);
      const imgSize = img.getSize();
      // Get virtual desktop origin and scale factor
      const displays = electron_1.screen.getAllDisplays();
      const leftPx = Math.min(
        ...displays.map((d) => Math.floor(d.bounds.x * (d.scaleFactor || 1))),
      );
      const topPx = Math.min(
        ...displays.map((d) => Math.floor(d.bounds.y * (d.scaleFactor || 1))),
      );
      // On macOS, uIOhook may return logical coordinates instead of physical pixels
      // We need to multiply by scaleFactor to get physical pixel coordinates
      const scaleFactor = region.scaleFactor || 1;
      // Calculate crop coordinates in physical pixels
      const cropX = Math.max(
        0,
        Math.floor(region.absoluteX * scaleFactor - leftPx),
      );
      const cropY = Math.max(
        0,
        Math.floor(region.absoluteY * scaleFactor - topPx),
      );
      const cropWidth = Math.max(1, Math.floor(region.width * scaleFactor));
      const cropHeight = Math.max(1, Math.floor(region.height * scaleFactor));
      // Debug logging
      console.log(
        "[CROP DEBUG] Image size:",
        imgSize.width,
        "x",
        imgSize.height,
      );
      console.log(
        "[CROP DEBUG] Virtual desktop origin (physical):",
        leftPx,
        topPx,
      );
      console.log("[CROP DEBUG] Region scaleFactor:", scaleFactor);
      console.log(
        "[CROP DEBUG] Region absolute coords (absoluteX/Y):",
        region.absoluteX,
        region.absoluteY,
      );
      console.log(
        "[CROP DEBUG] Region size (width/height):",
        region.width,
        region.height,
      );
      console.log(
        "[CROP DEBUG] After scaleFactor - coords:",
        region.absoluteX * scaleFactor,
        region.absoluteY * scaleFactor,
      );
      console.log("[CROP DEBUG] Calculated crop coords:", cropX, cropY);
      console.log("[CROP DEBUG] Calculated crop size:", cropWidth, cropHeight);
      console.log(
        "[CROP DEBUG] Display info:",
        displays.map((d) => ({
          id: d.id,
          bounds: d.bounds,
          scaleFactor: d.scaleFactor,
        })),
      );
      const cropped = img.crop({
        x: cropX,
        y: cropY,
        width: cropWidth,
        height: cropHeight,
      });
      const croppedBuffer = cropped.toPNG();
      if (croppedBuffer && croppedBuffer.length > 0) {
        console.log(
          "[CROP DEBUG] Crop successful, output size:",
          croppedBuffer.length,
          "bytes",
        );
        return croppedBuffer;
      }
    } catch (err) {
      console.warn("cropBufferToRegion failed, returning original buffer", err);
    }
    return buffer;
  }
}
exports.ScreenshotHelper = ScreenshotHelper;
