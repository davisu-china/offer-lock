"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalBM25 = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const elasticlunr_1 = __importDefault(require("elasticlunr"));
// LocalBM25: lightweight BM25 retriever for VIP/custom provider
// Knowledge source folder: %userData%/knowledge (supports .txt/.md)
// Index file: %userData%/kb_bm25.json
// Lightweight 2-gram tokenizer to avoid heavy dict dependencies
function tokenize2Gram(input) {
  if (!input) return [];
  const s = String(input).replace(/\s+/g, " ").trim();
  if (s.length === 0) return [];
  const tokens = [];
  // single char as fallback
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch && ch !== "\n" && ch !== "\r") tokens.push(ch);
  }
  // 2-gram
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    if (!/\s/.test(g)) grams.push(g);
  }
  return grams.length > 0 ? grams : tokens;
}
// Override tokenizer once
elasticlunr_1.default.tokenizer = (str) => tokenize2Gram(str);
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
    // Accept any non-empty trimmed segment (previously required >=50 chars)
    if (seg.trim().length > 0) chunks.push(seg);
  }
  return chunks;
}
class LocalBM25 {
  constructor() {
    this.index = null;
    this.docs = [];
    this.builtAt = 0;
    const userDir = electron_1.app.getPath("userData");
    this.knowledgeDir = node_path_1.default.join(userDir, "knowledge");
    this.storePath = node_path_1.default.join(userDir, "kb_bm25.json");
    // Ensure knowledge source folder exists so users can drop files in
    ensureDir(this.knowledgeDir);
  }
  async buildOrLoadIndex() {
    try {
      if (node_fs_1.default.existsSync(this.storePath)) {
        const raw = readTextFileSafe(this.storePath);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.docs = parsed.docs || [];
          this.index = elasticlunr_1.default.Index.load(parsed.idx);
          this.builtAt = parsed.builtAt || Date.now();
          console.log(
            `[KB] Loaded BM25 index: chunks=${this.docs.length}, file=${this.storePath}`,
          );
          return;
        }
      }
      await this.rebuildIndex();
    } catch (e) {
      console.warn("[KB] buildOrLoadIndex failed, try rebuild:", e);
      await this.rebuildIndex();
    }
  }
  // Force a full rescan of knowledge folder and rewrite snapshot
  async forceRebuild() {
    await this.rebuildIndex();
  }
  async rebuildIndex() {
    const idx = (0, elasticlunr_1.default)(function () {
      // @ts-ignore
      this.setRef("id");
      // @ts-ignore
      this.addField("text");
      // @ts-ignore
      this.saveDocument(false);
    });
    // Disable default English pipeline (trimmer/stopWords/stemmer) to keep CJK tokens intact
    try {
      idx.pipeline?.reset?.();
      idx.searchPipeline?.reset?.();
    } catch {}
    const exts = new Set([".txt", ".md"]); // 初版仅支持
    const files = node_fs_1.default
      .readdirSync(this.knowledgeDir)
      .filter((f) => exts.has(node_path_1.default.extname(f).toLowerCase()))
      .map((f) => node_path_1.default.join(this.knowledgeDir, f));
    const docs = [];
    let idCounter = 0;
    for (const f of files) {
      const content = readTextFileSafe(f);
      if (!content) continue;
      const parts = chunkText(content, 500, 100);
      for (const seg of parts) {
        const id = String(idCounter++);
        const doc = { id, text: seg };
        docs.push(doc);
        idx.addDoc(doc);
      }
    }
    this.docs = docs;
    this.index = idx;
    this.builtAt = Date.now();
    try {
      node_fs_1.default.writeFileSync(
        this.storePath,
        JSON.stringify({
          docs: this.docs,
          idx: idx.toJSON(),
          builtAt: this.builtAt,
        }),
      );
      console.log(
        `[KB] Rebuilt BM25 index: files=${files.length}, chunks=${docs.length}, out=${this.storePath}`,
      );
    } catch (e) {
      console.warn("[KB] persist index failed:", e);
    }
  }
  searchTop(query, k) {
    return this.searchTopWithScores(query, k).map((r) => r.text);
  }
  searchTopWithScores(query, k) {
    if (!this.index) {
      try {
        console.log(`[KB] searchTop: index-not-ready`);
      } catch {}
      return [];
    }
    if (!query || !k) {
      try {
        console.log(`[KB] searchTop: invalid-params q=${!!query} k=${k}`);
      } catch {}
      return [];
    }
    try {
      const results = this.index.search(query, {
        fields: { text: { boost: 1 } },
        expand: true,
      });
      const top = results.slice(0, Math.max(1, k));
      const out = top
        .map((r) => {
          const ref = Number(r.ref);
          const hit = this.docs[ref];
          return hit ? { text: hit.text, score: Number(r.score) || 0 } : null;
        })
        .filter((item) => !!item && !!item.text);
      console.log(`[KB] searchTop: qlen=${query.length}, hits=${out.length}`);
      return out;
    } catch (e) {
      console.warn("[KB] searchTop failed:", e);
      return [];
    }
  }
  getStats() {
    return { chunks: this.docs.length, lastBuiltAt: this.builtAt };
  }
}
exports.LocalBM25 = LocalBM25;
