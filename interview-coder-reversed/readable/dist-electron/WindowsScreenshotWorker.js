"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowsScreenshotWorker = void 0;
const child_process_1 = require("child_process");
const PREFIX = "SCREENSHOT_WORKER:";
// One hidden process per app, initialized lazily on the first Windows screenshot.
// JSON travels over stdin/stdout; no focus/window APIs and no script interpolation
// of file paths. Each request saves a PNG before acknowledging it.
const WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$initClock = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DpiHelper {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
}
"@
[void][DpiHelper]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
[Console]::Out.WriteLine('SCREENSHOT_WORKER:' + (@{ type = 'ready'; init_ms = $initClock.Elapsed.TotalMilliseconds } | ConvertTo-Json -Compress))
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = $null
  $bitmap = $null
  $graphics = $null
  try {
    $request = $line | ConvertFrom-Json
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $stage = [System.Diagnostics.Stopwatch]::StartNew()
    $rect = New-Object System.Drawing.Rectangle([int]$request.left, [int]$request.top, [int]$request.width, [int]$request.height)
    $bitmap = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $setupMs = $stage.Elapsed.TotalMilliseconds
    $stage.Restart()
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $rect.Size)
    $copyMs = $stage.Elapsed.TotalMilliseconds
    $stage.Restart()
    $bitmap.Save([string]$request.file, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngMs = $stage.Elapsed.TotalMilliseconds
  } catch {
    [Console]::Out.WriteLine('SCREENSHOT_WORKER:' + (@{ id = $request.id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    continue
  } finally {
    # Release GDI resources after every request, including errors; never accumulate bitmaps.
    if ($null -ne $graphics) { $graphics.Dispose() }
    if ($null -ne $bitmap) { $bitmap.Dispose() }
  }
  [Console]::Out.WriteLine('SCREENSHOT_WORKER:' + (@{
    id = $request.id; ok = $true; bitmap_setup_ms = $setupMs;
    copy_screen_ms = $copyMs; png_write_ms = $pngMs; total_ms = $clock.Elapsed.TotalMilliseconds
  } | ConvertTo-Json -Compress))
}
`;
class WindowsScreenshotWorker {
  // The injectable spawn/timeout also permit lifecycle tests without capturing a screen.
  constructor(spawnProcess = child_process_1.spawn, timeoutMs = 15000) {
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.ready = false;
    this.closed = false;
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.pending = null;
  }
  capture(bounds, file, traceId) {
    const task = this.tail.then(() => this.captureNow(bounds, file, traceId));
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  captureNow(bounds, file, traceId) {
    if (this.closed)
      return Promise.reject(new Error("Screenshot worker disposed"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(
        () => this.reset(new Error("Screenshot worker timed out")),
        this.timeoutMs,
      );
      this.pending = {
        id,
        traceId,
        started: performance.now(),
        timer,
        resolve,
        reject,
      };
      try {
        this.start();
        console.log(
          `[ScreenshotTiming][${traceId}] worker_mode=${this.ready ? "warm" : "cold"}`,
        );
        this.child.stdin.write(
          JSON.stringify({ id, ...bounds, file }) + "\n",
          (error) => {
            if (error && this.pending?.id === id) this.reset(error);
          },
        );
      } catch (error) {
        this.reset(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  start() {
    if (this.child) return;
    const child = this.spawnProcess(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(WORKER_SCRIPT, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    this.child = child;
    this.ready = false;
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-2048);
    });
    child.stdout.on("data", (data) => {
      if (this.child !== child) return; // Ignore events from a previously killed worker.
      output += data;
      if (output.length > 65536) {
        this.reset(new Error("Screenshot worker output limit exceeded"));
        return;
      }
      let newline;
      while ((newline = output.indexOf("\n")) !== -1) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (!line.startsWith(PREFIX)) continue;
        try {
          const message = JSON.parse(line.slice(PREFIX.length));
          if (message.type === "ready") {
            this.ready = true;
            console.log(
              `[ScreenshotTiming][worker] initialized=${Number(message.init_ms).toFixed(1)}ms (compile/assemblies once)`,
            );
            continue;
          }
          const pending = this.pending;
          if (!pending || message.id !== pending.id) continue;
          if (message.ok !== true) {
            this.reset(
              new Error(message.error || "Screenshot worker capture failed"),
            );
            return;
          }
          clearTimeout(pending.timer);
          this.pending = null;
          for (const stage of [
            "bitmap_setup_ms",
            "copy_screen_ms",
            "png_write_ms",
            "total_ms",
          ]) {
            if (
              typeof message[stage] === "number" &&
              Number.isFinite(message[stage])
            ) {
              console.log(
                `[ScreenshotTiming][${pending.traceId}] worker_${stage}=${message[stage].toFixed(1)}ms`,
              );
            }
          }
          console.log(
            `[ScreenshotTiming][${pending.traceId}] worker_roundtrip=${(performance.now() - pending.started).toFixed(1)}ms`,
          );
          pending.resolve();
        } catch (error) {
          this.reset(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    child.stdin.on("error", (error) => {
      if (this.child === child) this.reset(error);
    });
    child.on("error", (error) => {
      if (this.child === child) this.reset(error);
    });
    child.on("close", (code) => {
      if (this.child === child)
        this.reset(new Error(`Screenshot worker exited (${code}): ${stderr}`));
    });
  }
  reset(error) {
    const child = this.child;
    this.child = null;
    this.ready = false;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (child) {
      child.stdin.destroy();
      child.kill();
    }
  }
  dispose() {
    this.closed = true;
    this.reset(new Error("Screenshot worker disposed"));
  }
}
exports.WindowsScreenshotWorker = WindowsScreenshotWorker;
