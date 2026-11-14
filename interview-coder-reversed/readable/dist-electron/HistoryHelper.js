"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryHelper = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const AppRegion_1 = require("./AppRegion");
const MAX_RECENT_RECORDS = 20;
const TYPE_LABELS = {
  interview: "Interview",
  written: "Written",
};
const LEGACY_TYPE_LABELS = {
  interview: "Interview / 面试",
  written: "Written / 笔试",
};
const BLOCK_LABELS = {
  transcript: "Transcript",
  screenshot: "Screenshot",
  aiAnswer: "AI Answer",
  empty: "No content recorded yet.",
};
const OFFICIAL_SITES = {
  domestic: "https://mianshiguodong.top",
  overseas: "https://interviewcoder.vip",
};
function safeNowIso() {
  return new Date().toISOString();
}
function createLocalSessionId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const local =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${local}_${suffix}`;
}
function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function toDisplayTime(input) {
  try {
    const d = new Date(input);
    return d.toLocaleString();
  } catch {
    return input;
  }
}
function toDisplayShortTime(input) {
  try {
    const d = new Date(input);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return input;
  }
}
function normalizeWhitespace(input) {
  return String(input ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function stripDangerousFileChars(input) {
  return String(input ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
class HistoryHelper {
  constructor() {
    this.current = null;
    this.writeQueue = Promise.resolve();
    this.htmlTimer = null;
    this.baseDir = node_path_1.default.join(
      electron_1.app.getPath("userData"),
      "records",
    );
    node_fs_1.default.mkdirSync(this.baseDir, { recursive: true });
  }
  async recordTranscript(text) {
    const clean = normalizeWhitespace(text);
    if (!clean) return;
    await this.ensureSession("interview");
    const current = this.current;
    if (!current) return;
    current.record.type = "interview";
    current.meta.type = "interview";
    this.maybeAdoptTitleFromText(clean);
    this.pushBlock({
      id: this.createBlockId("transcript"),
      seq: current.record.blocks.length + 1,
      type: "transcript",
      createdAt: safeNowIso(),
      text: clean,
    });
  }
  async recordAiAnswer(payload) {
    const summary = normalizeWhitespace(payload.summary || payload.raw || "");
    const code = normalizeWhitespace(payload.code || "");
    const thoughts = (payload.thoughts || [])
      .map((item) => normalizeWhitespace(item))
      .filter(Boolean);
    if (!summary && !code && thoughts.length === 0) return;
    await this.ensureSession("written");
    const current = this.current;
    if (!current) return;
    this.maybeAdoptTitleFromText(summary || thoughts[0] || "");
    this.pushBlock({
      id: this.createBlockId("answer"),
      seq: current.record.blocks.length + 1,
      type: "ai_answer",
      createdAt: safeNowIso(),
      content: {
        summary,
        code,
        thoughts,
      },
    });
  }
  async recordScreenshot(sourcePath) {
    if (!sourcePath || !node_fs_1.default.existsSync(sourcePath)) return;
    await this.ensureSession("written");
    const current = this.current;
    if (!current) return;
    current.screenshotIndex += 1;
    const fileName = `${String(current.screenshotIndex).padStart(3, "0")}${node_path_1.default.extname(sourcePath) || ".png"}`;
    const targetPath = node_path_1.default.join(
      current.screenshotsDir,
      fileName,
    );
    await node_fs_1.default.promises.mkdir(current.screenshotsDir, {
      recursive: true,
    });
    await node_fs_1.default.promises.copyFile(sourcePath, targetPath);
    this.pushBlock({
      id: this.createBlockId("shot"),
      seq: current.record.blocks.length + 1,
      type: "screenshot",
      createdAt: safeNowIso(),
      path: `screenshots/${fileName}`,
      fileName,
    });
  }
  async closeCurrentSession(_reason) {
    if (!this.current) return;
    this.current.meta.status = "closed";
    this.current.meta.updatedAt = safeNowIso();
    this.current.record.updatedAt = this.current.meta.updatedAt;
    await this.flushNow();
    this.current = null;
  }
  async listRecent(limit = MAX_RECENT_RECORDS) {
    await node_fs_1.default.promises.mkdir(this.baseDir, { recursive: true });
    const entries = await node_fs_1.default.promises.readdir(this.baseDir, {
      withFileTypes: true,
    });
    const metas = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const metaPath = node_path_1.default.join(
              this.baseDir,
              entry.name,
              "meta.json",
            );
            if (!node_fs_1.default.existsSync(metaPath)) return null;
            const raw = await node_fs_1.default.promises.readFile(
              metaPath,
              "utf8",
            );
            const meta = JSON.parse(raw);
            const title =
              meta.title || this.buildFallbackTitle(meta.type, meta.createdAt);
            return {
              id: meta.id,
              type: meta.type,
              title,
              createdAt: meta.createdAt,
              updatedAt: meta.updatedAt,
              htmlPath: meta.htmlPath,
              blockCount: meta.blockCount || 0,
            };
          } catch {
            return null;
          }
        }),
    );
    return metas
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .slice(0, Math.max(1, limit))
      .map((item) => item);
  }
  async openHtml(id) {
    const sessionDir = node_path_1.default.join(this.baseDir, id);
    const htmlPath = node_path_1.default.join(sessionDir, "review.html");
    if (!node_fs_1.default.existsSync(htmlPath)) {
      return { success: false, error: "review_html_missing" };
    }
    const error = await electron_1.shell.openPath(htmlPath);
    return error ? { success: false, error } : { success: true };
  }
  async openFolder(id) {
    const sessionDir = node_path_1.default.join(this.baseDir, id);
    if (!node_fs_1.default.existsSync(sessionDir)) {
      return { success: false, error: "session_folder_missing" };
    }
    const error = await electron_1.shell.openPath(sessionDir);
    return error ? { success: false, error } : { success: true };
  }
  async deleteRecord(id) {
    if (!id) {
      return { success: false, error: "missing_record_id" };
    }
    const sessionDir = node_path_1.default.join(this.baseDir, id);
    if (!node_fs_1.default.existsSync(sessionDir)) {
      return { success: false, error: "session_folder_missing" };
    }
    if (this.current?.meta.id === id) {
      if (this.htmlTimer) {
        clearTimeout(this.htmlTimer);
        this.htmlTimer = null;
      }
      this.current = null;
    }
    try {
      await node_fs_1.default.promises.rm(sessionDir, {
        recursive: true,
        force: true,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
  async ensureSession(type) {
    if (this.current) {
      if (type === "interview") {
        this.current.meta.type = "interview";
        this.current.record.type = "interview";
      }
      return;
    }
    const id = createLocalSessionId();
    const createdAt = safeNowIso();
    const dir = node_path_1.default.join(this.baseDir, id);
    const screenshotsDir = node_path_1.default.join(dir, "screenshots");
    const metaPath = node_path_1.default.join(dir, "meta.json");
    const recordPath = node_path_1.default.join(dir, "record.json");
    const htmlPath = node_path_1.default.join(dir, "review.html");
    await node_fs_1.default.promises.mkdir(screenshotsDir, { recursive: true });
    const title = this.buildFallbackTitle(type, createdAt);
    const meta = {
      id,
      type,
      title,
      status: "open",
      createdAt,
      updatedAt: createdAt,
      htmlPath,
      blockCount: 0,
    };
    const record = {
      id,
      type,
      title,
      createdAt,
      updatedAt: createdAt,
      blocks: [],
    };
    this.current = {
      dir,
      metaPath,
      recordPath,
      htmlPath,
      screenshotsDir,
      meta,
      record,
      screenshotIndex: 0,
    };
    await this.flushNow();
  }
  maybeAdoptTitleFromText(text) {
    const current = this.current;
    if (!current) return;
    const fallback = this.buildFallbackTitle(
      current.meta.type,
      current.meta.createdAt,
    );
    if (current.meta.title !== fallback) return;
    const next = stripDangerousFileChars(text).slice(0, 48);
    if (!next) return;
    current.meta.title = next;
    current.record.title = next;
  }
  buildFallbackTitle(type, createdAt) {
    const prefix = TYPE_LABELS[type];
    return `${prefix} ${toDisplayTime(createdAt)}`;
  }
  buildLegacyFallbackTitle(type, createdAt) {
    const prefix = LEGACY_TYPE_LABELS[type];
    return `${prefix} ${toDisplayTime(createdAt)}`;
  }
  resolveDisplayTitle(meta) {
    const fallbackTitle = this.buildFallbackTitle(meta.type, meta.createdAt);
    const legacyFallbackTitle = this.buildLegacyFallbackTitle(
      meta.type,
      meta.createdAt,
    );
    if (
      !meta.title ||
      meta.title === legacyFallbackTitle ||
      meta.title === fallbackTitle
    ) {
      return fallbackTitle;
    }
    return meta.title;
  }
  pushBlock(block) {
    const current = this.current;
    if (!current) return;
    current.record.blocks.push(block);
    current.record.updatedAt = block.createdAt;
    current.meta.updatedAt = block.createdAt;
    current.meta.blockCount = current.record.blocks.length;
    current.record.title = current.meta.title;
    this.enqueueFlush();
    this.scheduleHtmlRebuild();
  }
  createBlockId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  enqueueFlush() {
    void this.flushNow();
  }
  scheduleHtmlRebuild() {
    if (this.htmlTimer) {
      clearTimeout(this.htmlTimer);
    }
    this.htmlTimer = setTimeout(() => {
      this.htmlTimer = null;
      void this.flushNow();
    }, 1200);
  }
  async flushNow() {
    if (!this.current) return;
    const snapshot = this.cloneCurrent(this.current);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await node_fs_1.default.promises.mkdir(snapshot.dir, {
          recursive: true,
        });
        await this.atomicWriteJson(snapshot.metaPath, snapshot.meta);
        await this.atomicWriteJson(snapshot.recordPath, snapshot.record);
        await this.atomicWriteText(
          snapshot.htmlPath,
          this.renderHtml(snapshot.meta, snapshot.record),
        );
      })
      .catch((error) => {
        console.error("[history] flush failed", error);
      });
    await this.writeQueue;
  }
  cloneCurrent(current) {
    return {
      dir: current.dir,
      metaPath: current.metaPath,
      recordPath: current.recordPath,
      htmlPath: current.htmlPath,
      screenshotsDir: current.screenshotsDir,
      screenshotIndex: current.screenshotIndex,
      meta: JSON.parse(JSON.stringify(current.meta)),
      record: JSON.parse(JSON.stringify(current.record)),
    };
  }
  async atomicWriteJson(filePath, data) {
    await this.atomicWriteText(filePath, JSON.stringify(data, null, 2));
  }
  async atomicWriteText(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    await node_fs_1.default.promises.writeFile(tempPath, data, "utf8");
    await node_fs_1.default.promises.rename(tempPath, filePath);
  }
  renderHtml(meta, record) {
    const title = this.resolveDisplayTitle(meta);
    const typeLabel = TYPE_LABELS[meta.type];
    const appRegion = (0, AppRegion_1.getAppRegion)();
    const officialSite = OFFICIAL_SITES[appRegion];
    const blocksHtml = record.blocks
      .map((block) => {
        const blockTime = toDisplayShortTime(block.createdAt);
        if (block.type === "transcript") {
          return `
            <section class="block">
              <div class="meta-line">${escapeHtml(blockTime)} · ${BLOCK_LABELS.transcript}</div>
              <div class="text-card">${escapeHtml(block.text).replace(/\n/g, "<br/>")}</div>
            </section>
          `;
        }
        if (block.type === "screenshot") {
          const href = encodeURI(block.path);
          return `
            <section class="block">
              <div class="meta-line">${escapeHtml(blockTime)} · ${BLOCK_LABELS.screenshot}</div>
              <a class="image-link" href="${href}" target="_blank" rel="noopener noreferrer">
                <img class="shot" src="${href}" alt="${escapeHtml(block.fileName)}" />
              </a>
            </section>
          `;
        }
        const thoughtsHtml = block.content.thoughts.length
          ? `<ul>${block.content.thoughts.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          : "";
        const codeHtml = block.content.code
          ? `<pre><code>${escapeHtml(block.content.code)}</code></pre>`
          : "";
        return `
          <section class="block">
            <div class="meta-line">${escapeHtml(blockTime)} · ${BLOCK_LABELS.aiAnswer}</div>
            ${block.content.summary ? `<div class="text-card">${escapeHtml(block.content.summary).replace(/\n/g, "<br/>")}</div>` : ""}
            ${thoughtsHtml}
            ${codeHtml}
          </section>
        `;
      })
      .join("\n");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f3efe7;
      --paper: #fffdf8;
      --ink: #111827;
      --muted: #667085;
      --line: #e6dfd3;
      --accent: #1f4a6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background: radial-gradient(circle at top, #f8f3ea 0, var(--bg) 55%);
      line-height: 1.6;
    }
    .page {
      max-width: 920px;
      margin: 24px auto;
      padding: 24px;
    }
    .paper {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 14px 40px rgba(15, 23, 42, 0.08);
      padding: 28px;
    }
    .site-banner {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
      padding: 10px 14px;
      border-radius: 999px;
      background: #eef4f8;
      border: 1px solid #d6e3ec;
      color: var(--accent);
      font-size: 13px;
      font-family: "Segoe UI", Arial, sans-serif;
    }
    .site-banner a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 700;
    }
    .site-banner a:hover {
      text-decoration: underline;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 30px;
      line-height: 1.15;
    }
    .subtitle {
      color: var(--muted);
      font-size: 14px;
      margin-bottom: 24px;
    }
    .block {
      padding: 16px 0;
      border-top: 1px solid var(--line);
    }
    .block:first-of-type {
      border-top: none;
      padding-top: 0;
    }
    .meta-line {
      color: var(--accent);
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 10px;
      font-family: "Segoe UI", Arial, sans-serif;
    }
    .text-card {
      background: #fcfaf5;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px 16px;
      white-space: normal;
      word-break: break-word;
    }
    .shot {
      width: 100%;
      height: auto;
      display: block;
      border-radius: 16px;
      border: 1px solid var(--line);
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
      cursor: zoom-in;
    }
    .image-link {
      display: block;
    }
    pre {
      overflow: auto;
      padding: 14px 16px;
      border-radius: 14px;
      background: #101826;
      color: #f8fafc;
      border: 1px solid #223049;
      font-size: 13px;
      line-height: 1.45;
    }
    ul {
      margin: 12px 0 0 18px;
      padding: 0;
    }
    @media (max-width: 720px) {
      .page { padding: 12px; }
      .paper { padding: 18px; border-radius: 16px; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <article class="paper">
      <div class="site-banner">
        <span>Official Site</span>
        <a href="${escapeHtml(officialSite)}" target="_blank" rel="noopener noreferrer">${escapeHtml(officialSite)}</a>
      </div>
      <h1>${escapeHtml(title)}</h1>
      <div class="subtitle">${escapeHtml(typeLabel)} · ${escapeHtml(toDisplayTime(meta.createdAt))}</div>
      ${blocksHtml || `<div class="text-card">${BLOCK_LABELS.empty}</div>`}
    </article>
  </main>
</body>
</html>`;
  }
}
exports.HistoryHelper = HistoryHelper;
