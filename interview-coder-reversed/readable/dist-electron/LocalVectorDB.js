"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalVectorDB = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const electron_log_1 = __importDefault(require("electron-log"));
// --- ESM Bypass for CommonJS Electron Main Process ---
// Since Electron's main process is compiled to matching CommonJS (CJS) by tsc,
// doing `import '...'` or `await import('...')` gets transpiled to `require()`,
// causing ERR_REQUIRE_ESM for pure ESM packages like Transformers.js and Orama.
// We use `new Function` to force Node to keep it as native dynamic import.
const dynamicImport = new Function("specifier", "return import(specifier)");
let oramaCreate, oramaInsert, oramaSearch;
let oramaPersist, oramaRestore;
let tfEnv, tfPipeline;
function ensureDir(p) {
  if (!node_fs_1.default.existsSync(p))
    node_fs_1.default.mkdirSync(p, { recursive: true });
}
function readTextFileSafe(p) {
  try {
    return node_fs_1.default.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}
function chunkText(text, size = 500, overlap = 100) {
  const src = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const chunks = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < src.length; i += step) {
    const seg = src.slice(i, i + size);
    if (seg.trim().length > 0) chunks.push(seg);
  }
  return chunks;
}
class LocalVectorDB {
  constructor() {
    this.oramaDB = null;
    this.extractor = null;
    this.builtAt = 0;
    this.chunkCount = 0;
    this.userDir = electron_1.app.getPath("userData");
    this.knowledgeDir = node_path_1.default.join(this.userDir, "knowledge");
    this.dbPath = node_path_1.default.join(this.userDir, "orama_kb.json");
    ensureDir(this.knowledgeDir);
    electron_log_1.default.info("[KB Init] LocalVectorDB 引擎初始化...", {
      knowledgeDir: this.knowledgeDir,
      dbPath: this.dbPath,
    });
  }
  async initOramaDeps() {
    if (!oramaCreate) {
      electron_log_1.default.info("[KB] Loading Orama ESM Dependencies...");
      const orama = await dynamicImport("@orama/orama");
      oramaCreate = orama.create;
      oramaInsert = orama.insertMultiple;
      oramaSearch = orama.search;
      const oramaPersistPlugin = await dynamicImport(
        "@orama/plugin-data-persistence/server",
      );
      oramaPersist = oramaPersistPlugin.persistToFile;
      oramaRestore = oramaPersistPlugin.restoreFromFile;
    }
  }
  async initExtractor() {
    if (!tfEnv) {
      electron_log_1.default.info("[KB] Loading AI components...");
      const tf = await dynamicImport("@xenova/transformers");
      tfEnv = tf.env;
      tfPipeline = tf.pipeline;
      tfEnv.backends.onnx.wasm.wasmPaths = node_path_1.default.join(
        __dirname,
        "../node_modules/@xenova/transformers/dist/",
      );
      tfEnv.remoteHost = "https://hf-mirror.com";
      tfEnv.cacheDir = node_path_1.default.join(this.userDir, ".models");
      const resourcePath = electron_1.app.isPackaged
        ? process.resourcesPath
        : node_path_1.default.join(__dirname, "..");
      const bundledModelPath = node_path_1.default.join(
        resourcePath,
        "assets/models/",
      );
      if (node_fs_1.default.existsSync(bundledModelPath)) {
        tfEnv.localModelPath = bundledModelPath;
      }
    }
    if (!this.extractor) {
      electron_log_1.default.info("[KB] Initializing AI...");
      this.extractor = await tfPipeline(
        "feature-extraction",
        "Xenova/bge-small-zh-v1.5",
        {
          quantized: true, // we use the 24MB quantized model
        },
      );
      electron_log_1.default.info("[KB] AI initialized successfully");
    }
  }
  async buildOrLoadIndex() {
    try {
      await this.initOramaDeps();
      if (node_fs_1.default.existsSync(this.dbPath)) {
        electron_log_1.default.info(
          "[KB] 检测到历史数据库，启动【反序列化读取】...",
        );
        this.oramaDB = await oramaRestore("json", this.dbPath);
        // Count docs roughly
        this.chunkCount =
          Object.keys(this.oramaDB?.data?.docs?.docs || {}).length || 0;
        this.builtAt = node_fs_1.default.statSync(this.dbPath).mtimeMs;
        electron_log_1.default.info(
          `[KB] 数据库恢复完毕！ chunks=${this.chunkCount}`,
        );
        // 【核心优化】：延迟 3 秒在后台静默预热大模型，绝不阻塞应用第一次弹出的丝滑度，又能保证用户第一次提问时模型已在内存就绪
        setTimeout(() => {
          electron_log_1.default.info(
            "[KB] Starting background AI initialization...",
          );
          this.initExtractor().catch((e) =>
            electron_log_1.default.error("[KB] 后台预热失败:", e),
          );
        }, 3000);
        return;
      }
      electron_log_1.default.info(
        "[KB] 未检测到历史库文件，进入【深度编译流程】...",
      );
      await this.rebuildIndex();
    } catch (e) {
      electron_log_1.default.error(
        "[KB] buildOrLoadIndex 遭遇错误，尝试清空重建:",
        e,
      );
      await this.rebuildIndex();
    }
  }
  async forceRebuild() {
    await this.initOramaDeps();
    // rebuildIndex will call initExtractor
    await this.rebuildIndex();
  }
  async rebuildIndex() {
    try {
      await this.initOramaDeps();
      this.oramaDB = await oramaCreate({
        schema: {
          id: "string",
          text: "string",
          embedding: "vector[512]", // BGE-small output dim
        },
      });
      await this.initExtractor();
      const exts = new Set([".txt", ".md"]);
      const files = node_fs_1.default
        .readdirSync(this.knowledgeDir)
        .filter((f) => exts.has(node_path_1.default.extname(f).toLowerCase()))
        .map((f) => node_path_1.default.join(this.knowledgeDir, f));
      let idCounter = 0;
      const docsToInsert = [];
      electron_log_1.default.info(`[KB] 分块开始，发现文件数: ${files.length}`);
      for (const f of files) {
        const content = readTextFileSafe(f);
        if (!content) continue;
        const parts = chunkText(content, 500, 100);
        for (const seg of parts) {
          const id = String(idCounter++);
          const queryOut = await this.extractor(seg, {
            pooling: "mean",
            normalize: true,
          });
          const vectorData = Array.from(queryOut.data);
          docsToInsert.push({
            id,
            text: seg,
            embedding: vectorData,
          });
        }
      }
      if (docsToInsert.length > 0) {
        await oramaInsert(this.oramaDB, docsToInsert);
      }
      this.chunkCount = docsToInsert.length;
      this.builtAt = Date.now();
      electron_log_1.default.info(
        `[KB] 文件向量化处理完毕！共处理 ${files.length} 个文件, ${this.chunkCount} 个切片。准备落盘...`,
      );
      await oramaPersist(this.oramaDB, "json", this.dbPath);
      electron_log_1.default.info(
        `[KB] 写入成功！向量库文件位于: ${this.dbPath}`,
      );
    } catch (e) {
      electron_log_1.default.error("[KB] rebuildIndex failed:", e);
    }
  }
  async searchTop(query, k) {
    const hits = await this.searchTopWithScores(query, k);
    return hits.map((h) => h.text);
  }
  async searchTopWithScores(query, k) {
    if (!this.oramaDB) {
      electron_log_1.default.warn(`[KB] searchTop: index-not-ready`);
      return [];
    }
    if (!query || !k) {
      return [];
    }
    try {
      const startObj = Date.now();
      await this.initOramaDeps();
      await this.initExtractor();
      const queryOut = await this.extractor(query, {
        pooling: "mean",
        normalize: true,
      });
      const vectorData = Array.from(queryOut.data);
      const results = await oramaSearch(this.oramaDB, {
        mode: "vector",
        vector: {
          value: vectorData,
          property: "embedding",
        },
        limit: Math.max(1, k),
        similarity: 0.3,
      });
      const out = results.hits.map((r) => {
        return {
          text: r.document.text,
          score: r.score,
        };
      });
      electron_log_1.default.info(
        `[KB Search] qlen=${query.length}, hits=${out.length}, time=${Date.now() - startObj}ms`,
      );
      return out;
    } catch (e) {
      electron_log_1.default.warn("[KB] searchTop failed:", e);
      return [];
    }
  }
  getStats() {
    return { chunks: this.chunkCount, lastBuiltAt: this.builtAt };
  }
}
exports.LocalVectorDB = LocalVectorDB;
