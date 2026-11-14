"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessingHelper = void 0;
// ProcessingHelper.ts
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const axios = __importStar(require("axios"));
const openai_1 = require("openai");
const ConfigHelper_1 = require("./ConfigHelper");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const electron_log_1 = __importDefault(require("electron-log"));
const LocalVectorDB_1 = require("./LocalVectorDB");
const ContextManager_1 = require("./ContextManager");
const AccessGuard_1 = require("./AccessGuard");
const DomesticLicenseService_1 = require("./DomesticLicenseService");
const AppRegion_1 = require("./AppRegion");
const LicenseHelper_1 = require("./LicenseHelper");
// ⏱️ AI 请求前统一延迟时间（毫秒），原为 5000，为了方便测试与统一维护提到了这里
const AI_PRE_REQUEST_DELAY_MS = 3500;
const DEFAULT_QWEN_MODEL = "qwen3.8-flash";
// Qwen3.8 Flash defaults to thinking, which delays the first visible answer token.
// Limit this override to the verified model; other models keep their own defaults.
function getQwenThinkingParams(model) {
  return model === "qwen3.8-flash" ? { enable_thinking: false } : {};
}
function getAiPreRequestDelayMs() {
  let delayMs = AI_PRE_REQUEST_DELAY_MS;
  try {
    if ((0, AppRegion_1.getAppRegion)() === "overseas") {
      delayMs = 0;
    } else {
      const license = LicenseHelper_1.licenseHelper.load(
        LicenseHelper_1.licenseHelper.getOrCreateDeviceId(),
      );
      const code = license?.code?.trim().toUpperCase() || "";
      delayMs = code.startsWith("M") ? 0 : AI_PRE_REQUEST_DELAY_MS;
    }
  } catch {
    delayMs = AI_PRE_REQUEST_DELAY_MS;
  }
  console.log(`[ai-pre-request-delay] ${delayMs}ms`);
  return delayMs;
}
const prompts_1 = require("./prompts");
class ProcessingHelper {
  getOfficialOpenAIChatLimit(maxTokens) {
    return { max_completion_tokens: maxTokens };
  }
  createRequestSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  // Ctrl+R clears ContextManager immediately. This guard prevents a cancelled
  // request from writing an old turn back into memory if a late finalize path runs.
  shouldCommitTurn(signal, source) {
    if (signal?.aborted) {
      console.log(
        `[ContextManager] Skip commitTurn after cancel/reset (${source})`,
      );
      return false;
    }
    return true;
  }
  getPreferredQwenVisionModel(config) {
    const candidates = [
      config?.qwenModel,
      config?.extractionModel,
      config?.solutionModel,
      config?.debuggingModel,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
    return DEFAULT_QWEN_MODEL;
  }
  summarizeTextForLog(text, maxLength = 120) {
    const normalized = String(text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return "";
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength)}...`
      : normalized;
  }
  summarizeMessageContentForLog(content) {
    if (typeof content === "string")
      return this.summarizeTextForLog(content, 80);
    if (!Array.isArray(content)) return "";
    const textBlocks = content
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text || ""));
    const imageCount = content.filter(
      (block) => block?.type === "image" || block?.type === "image_url",
    ).length;
    const textPreview = this.summarizeTextForLog(textBlocks.join(" "), 80);
    return `${textPreview}${imageCount ? ` [images:${imageCount}]` : ""}`.trim();
  }
  summarizeProblemInfoForLog(problemInfo, maxLength = 120) {
    if (!problemInfo) return "";
    if (typeof problemInfo === "string") {
      return this.summarizeTextForLog(problemInfo, maxLength);
    }
    const candidate =
      problemInfo?.problem_statement ||
      problemInfo?.description ||
      problemInfo?.title ||
      "";
    if (candidate) {
      return this.summarizeTextForLog(candidate, maxLength);
    }
    try {
      return this.summarizeTextForLog(JSON.stringify(problemInfo), maxLength);
    } catch {
      return "";
    }
  }
  createImageBatch(screenshots, accompanyingText) {
    const images = screenshots
      .filter((screenshot) => Boolean(screenshot?.data))
      .map((screenshot) => ({
        mediaType: "image/png",
        data: screenshot.data,
      }));
    if (images.length === 0) return undefined;
    return {
      images,
      accompanyingText: String(accompanyingText || "").trim() || undefined,
      createdAt: Date.now(),
    };
  }
  getAssistantText(result) {
    if (
      typeof result?.assistantText === "string" &&
      result.assistantText.trim()
    ) {
      return result.assistantText.trim();
    }
    if (typeof result?.data === "string") return result.data.trim();
    if (result?.data && typeof result.data === "object") {
      try {
        return JSON.stringify(result.data);
      } catch {}
    }
    return "";
  }
  async getRendererTextInputSnapshot(mainWindow) {
    if (!mainWindow || mainWindow.isDestroyed()) return "";
    try {
      const textInput = await mainWindow.webContents.executeJavaScript(
        "String(window.__TEXT_INPUT__ || '')",
      );
      return typeof textInput === "string"
        ? textInput
        : String(textInput || "");
    } catch (error) {
      console.warn("[Diag] Failed to read renderer text snapshot:", error);
      return "";
    }
  }
  constructor(deps) {
    this.openaiClient = null;
    this.geminiClient = null;
    this.geminiApiKey = null;
    this.anthropicClient = null;
    this.qwenClient = null;
    this.openrouterClient = null;
    this.customClient = null;
    this.custom2Client = null;
    this.kb = null;
    // AbortControllers for API requests
    this.currentProcessingAbortController = null;
    this.currentExtraProcessingAbortController = null;
    // Session ID to guard against stale stream chunks from cancelled requests
    this.currentSessionId = "";
    this.deps = deps;
    this.screenshotHelper = deps.getScreenshotHelper();
    // Initialize AI client based on config
    this.initializeAIClient();
    // Initialize local knowledge base (VectorDB) asynchronously
    try {
      this.kb = new LocalVectorDB_1.LocalVectorDB();
      this.kb
        .buildOrLoadIndex()
        .catch((e) => console.warn("KB build failed:", e));
    } catch (e) {
      console.warn("KB init failed:", e);
      this.kb = null;
    }
    DomesticLicenseService_1.domesticLicenseService.on("changed", () => {
      this.cancelOngoingRequests();
    });
    // Listen for config changes to re-initialize the AI client
    ConfigHelper_1.configHelper.on("config-updated", () => {
      this.initializeAIClient();
    });
  }
  /**
   * Initialize or reinitialize the AI client with current config
   */
  guardCustomClient(client, provider) {
    const create = client.chat.completions.create.bind(client.chat.completions);
    client.chat.completions.create = (...args) => {
      if (!(0, AccessGuard_1.guardProviderAccess)(provider).ok) {
        throw new Error("当前卡密不支持自定义模型，或需要重新校验。");
      }
      return create(...args);
    };
    return client;
  }
  initializeAIClient() {
    try {
      const config = ConfigHelper_1.configHelper.loadConfig();
      if (config.apiProvider === "openai") {
        const openaiKey = config.openaiApiKey || config.apiKey;
        if (openaiKey) {
          this.openaiClient = new openai_1.OpenAI({
            apiKey: openaiKey,
            baseURL: "https://api.openai.com/v1",
            timeout: 60000, // 60 second timeout
            maxRetries: 2, // Retry up to 2 times
          });
          this.geminiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          this.qwenClient = null;
          this.customClient = null;
          console.log("OpenAI client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          this.qwenClient = null;
          this.customClient = null;
          console.warn("No API key available, OpenAI client not initialized");
        }
      } else if (config.apiProvider === "gemini") {
        // Gemini via OpenAI-compatible proxy
        this.openaiClient = null;
        this.anthropicClient = null;
        this.qwenClient = null;
        this.customClient = null;
        const geminiKey = config.geminiApiKey || config.apiKey;
        if (geminiKey) {
          this.geminiClient = new openai_1.OpenAI({
            apiKey: geminiKey,
            baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
            timeout: 60000,
            maxRetries: 2,
          });
          this.geminiApiKey = null;
          console.log(
            "Gemini client (OpenAI-compatible) initialized successfully",
          );
        } else {
          this.geminiClient = null;
          this.geminiApiKey = null;
          console.warn("No API key available, Gemini client not initialized");
        }
      } else if (config.apiProvider === "anthropic") {
        // Reset other clients
        this.openaiClient = null;
        this.geminiClient = null;
        this.geminiApiKey = null;
        this.qwenClient = null;
        this.customClient = null;
        const anthropicKey = config.anthropicApiKey || config.apiKey;
        if (anthropicKey) {
          this.anthropicClient = new sdk_1.default({
            apiKey: anthropicKey,
            timeout: 60000,
            maxRetries: 2,
          });
          console.log("Anthropic client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          this.qwenClient = null;
          this.customClient = null;
          console.warn(
            "No API key available, Anthropic client not initialized",
          );
        }
      } else if (config.apiProvider === "qwen") {
        // Reset other clients
        this.openaiClient = null;
        this.geminiClient = null;
        this.geminiApiKey = null;
        this.anthropicClient = null;
        this.customClient = null;
        const qwenKey = config.qwenApiKey || config.apiKey;
        if (qwenKey) {
          this.qwenClient = new openai_1.OpenAI({
            apiKey: qwenKey,
            baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            timeout: 60000,
            maxRetries: 2,
          });
          console.log("Qwen client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          this.qwenClient = null;
          this.customClient = null;
          console.warn("No API key available, Qwen client not initialized");
        }
      } else if (config.apiProvider === "openrouter") {
        // Reset others
        this.openaiClient = null;
        this.geminiClient = null;
        this.geminiApiKey = null;
        this.anthropicClient = null;
        this.qwenClient = null;
        this.customClient = null;
        const openrouterKey = config.openrouterApiKey || config.apiKey;
        if (openrouterKey) {
          this.openrouterClient = new openai_1.OpenAI({
            apiKey: openrouterKey,
            baseURL: "https://openrouter.ai/api/v1",
            timeout: 60000,
            maxRetries: 2,
          });
          console.log("OpenRouter client initialized successfully");
        } else {
          this.openrouterClient = null;
          console.warn(
            "No API key available, OpenRouter client not initialized",
          );
        }
      } else if (config.apiProvider === "custom") {
        // Reset others
        this.openaiClient = null;
        this.geminiClient = null;
        this.geminiApiKey = null;
        this.anthropicClient = null;
        this.qwenClient = null;
        this.openrouterClient = null;
        this.custom2Client = null;
        const customKey = config.customApiKey || config.apiKey;
        if (customKey && (config.customBaseUrl || "").trim()) {
          this.customClient = this.guardCustomClient(
            new openai_1.OpenAI({
              apiKey: customKey,
              baseURL: (config.customBaseUrl || "").trim(),
              timeout: 60000,
              maxRetries: 2,
            }),
            "custom",
          );
          console.log("Custom client initialized successfully");
        } else {
          this.customClient = null;
          console.warn("Custom provider missing apiKey or customBaseUrl");
        }
      } else if (config.apiProvider === "custom2") {
        // Reset others
        this.openaiClient = null;
        this.geminiClient = null;
        this.geminiApiKey = null;
        this.anthropicClient = null;
        this.qwenClient = null;
        this.openrouterClient = null;
        this.customClient = null;
        const custom2Key = config.custom2ApiKey || config.apiKey;
        if (custom2Key && (config.custom2BaseUrl || "").trim()) {
          this.custom2Client = this.guardCustomClient(
            new openai_1.OpenAI({
              apiKey: custom2Key,
              baseURL: (config.custom2BaseUrl || "").trim(),
              timeout: 60000,
              maxRetries: 2,
            }),
            "custom2",
          );
          console.log("Custom2 client initialized successfully");
        } else {
          this.custom2Client = null;
          console.warn("Custom2 provider missing apiKey or custom2BaseUrl");
        }
      }
    } catch (error) {
      console.error("Failed to initialize AI client:", error);
      this.openaiClient = null;
      this.geminiClient = null;
      this.geminiApiKey = null;
      this.anthropicClient = null;
      this.qwenClient = null;
      this.openrouterClient = null;
      this.customClient = null;
      this.custom2Client = null;
    }
  }
  async waitForInitialization(mainWindow) {
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds total
    while (attempts < maxAttempts) {
      const isInitialized = await mainWindow.webContents.executeJavaScript(
        "window.__IS_INITIALIZED__",
      );
      if (isInitialized) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }
    throw new Error("App failed to initialize after 5 seconds");
  }
  async getCredits() {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) return 999; // Unlimited credits in this version
    try {
      await this.waitForInitialization(mainWindow);
      return 999; // Always return sufficient credits to work
    } catch (error) {
      console.error("Error getting credits:", error);
      return 999; // Unlimited credits as fallback
    }
  }
  async getLanguage() {
    try {
      // Get language from config
      const config = ConfigHelper_1.configHelper.loadConfig();
      if (config.language) {
        return config.language;
      }
      // Fallback to window variable if config doesn't have language
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow) {
        try {
          await this.waitForInitialization(mainWindow);
          const language = await mainWindow.webContents.executeJavaScript(
            "window.__LANGUAGE__",
          );
          if (
            typeof language === "string" &&
            language !== undefined &&
            language !== null
          ) {
            return language;
          }
        } catch (err) {
          console.warn("Could not get language from window", err);
        }
      }
      // Default fallback
      return "python";
    } catch (error) {
      console.error("Error getting language:", error);
      return "python";
    }
  }
  async processScreenshots() {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) return;
    // License guard
    if (!(0, AccessGuard_1.guardFeatureAccess)().ok) {
      console.warn("Blocked by access guard: processScreenshots");
      return;
    }
    const providerAccess = (0, AccessGuard_1.guardProviderAccess)(
      ConfigHelper_1.configHelper.loadConfig().apiProvider,
    );
    if (!providerAccess.ok) {
      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        providerAccess.reason === "custom_requires_full_card"
          ? "当前基础卡不支持自定义 1、2，请切换模型或使用 T/M 卡密。"
          : "请先完成卡密校验。",
      );
      return;
    }
    const config = ConfigHelper_1.configHelper.loadConfig();
    // First verify we have a valid AI client
    if (config.apiProvider === "openai" && !this.openaiClient) {
      this.initializeAIClient();
      if (!this.openaiClient) {
        console.error("OpenAI client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID,
        );
        return;
      }
    } else if (config.apiProvider === "gemini" && !this.geminiClient) {
      this.initializeAIClient();
      if (!this.geminiClient) {
        console.error("Gemini client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID,
        );
        return;
      }
    } else if (config.apiProvider === "anthropic" && !this.anthropicClient) {
      // Add check for Anthropic client
      this.initializeAIClient();
      if (!this.anthropicClient) {
        console.error("Anthropic client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID,
        );
        return;
      }
    } else if (config.apiProvider === "qwen" && !this.qwenClient) {
      // Add check for Qwen client
      this.initializeAIClient();
      if (!this.qwenClient) {
        console.error("Qwen client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID,
        );
        return;
      }
    } else if (config.apiProvider === "custom" && !this.customClient) {
      // Add check for custom client
      this.initializeAIClient();
      if (!this.customClient) {
        console.error("Custom client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID,
        );
        return;
      }
    } else if (config.apiProvider === "custom2" && !this.custom2Client) {
      // Add check for custom2 client
      this.initializeAIClient();
      if (!this.custom2Client) {
        console.error("Custom2 client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID,
        );
        return;
      }
    }
    const view = this.deps.getView();
    const mainQueueSnapshot = this.screenshotHelper.getScreenshotQueue();
    const extraQueueSnapshot = this.screenshotHelper.getExtraScreenshotQueue();
    const rendererTextSnapshot =
      await this.getRendererTextInputSnapshot(mainWindow);
    const currentProblemPreview = this.summarizeProblemInfoForLog(
      this.deps.getProblemInfo(),
    );
    console.log("Processing screenshots in view:", view);
    console.log("[Ctrl+Enter][Diag] processScreenshots entry", {
      view,
      provider: config.apiProvider,
      mainQueueCount: mainQueueSnapshot.length,
      extraQueueCount: extraQueueSnapshot.length,
      textPresent: Boolean(rendererTextSnapshot.trim()),
      textPreview: this.summarizeTextForLog(rendererTextSnapshot),
      currentProblemPreview,
    });
    if (view === "queue") {
      const sessionId = this.createRequestSessionId();
      this.currentSessionId = sessionId;
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START, {
        sessionId,
      });
      try {
        this.deps.setView("solutions");
      } catch {}
      const screenshotQueue = this.screenshotHelper.getScreenshotQueue();
      console.log("Processing main queue screenshots:", screenshotQueue);
      // Check if the queue is empty
      if (!screenshotQueue || screenshotQueue.length === 0) {
        console.log("No screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }
      // Check that files actually exist
      const existingScreenshots = screenshotQueue.filter((path) =>
        node_fs_1.default.existsSync(path),
      );
      if (existingScreenshots.length === 0) {
        console.log("Screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }
      console.log("[Ctrl+Enter][Diag] queue route selected", {
        sessionId,
        screenshotCount: existingScreenshots.length,
        screenshots: existingScreenshots
          .slice(0, 4)
          .map((s) => node_path_1.default.basename(s)),
        textPresent: Boolean(rendererTextSnapshot.trim()),
        textPreview: this.summarizeTextForLog(rendererTextSnapshot),
        currentProblemPreview,
      });
      try {
        // 1) 软重置前端状态（等效 Ctrl+R 的表现，但由于本函数会紧接着 setView("solutions")，所以视觉上是无感的）
        try {
          mainWindow.webContents.send("reset-view");
          mainWindow.webContents.send("reset");
        } catch {}
        // 2) 开始处理
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START, {
          sessionId,
        });
        // Cancel any ongoing request before starting a new one
        try {
          this.cancelOngoingRequests();
        } catch {}
        // Initialize AbortController
        this.currentProcessingAbortController = new AbortController();
        const { signal } = this.currentProcessingAbortController;
        const screenshots = await Promise.all(
          existingScreenshots.map(async (path) => {
            try {
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: node_fs_1.default.readFileSync(path).toString("base64"),
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          }),
        );
        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(
          (screenshot) => screenshot !== null,
        );
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data");
        }
        ContextManager_1.contextManager.clear();
        const result = await this.processScreenshotsHelper(
          validScreenshots,
          signal,
          sessionId,
        );
        if (!result.success) {
          console.log("Processing failed:", result.error);
          if (
            result.error?.includes("API Key") ||
            result.error?.includes("OpenAI") ||
            result.error?.includes("Gemini")
          ) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.API_KEY_INVALID,
            );
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
              result.error,
            );
          }
          // Reset view back to queue on error
          console.log("Resetting view to queue due to error");
          this.deps.setView("queue");
          return;
        }
        // Abort guard: if user cancelled mid-run, do not switch views or send success
        if (signal?.aborted) {
          console.log("Aborted during processing; skipping success/setView");
          return;
        }
        // Only set view to solutions if processing succeeded
        console.log("Setting view to solutions after successful processing");
        const imageBatch = this.createImageBatch(validScreenshots);
        const assistantText = this.getAssistantText(result);
        if (assistantText) {
          if (imageBatch)
            ContextManager_1.contextManager.commitImageBatch(imageBatch);
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const language = await this.getLanguage();
          const userPrompt =
            config?.xingceMode === true
              ? prompts_1.XINGCE_USER_PROMPT
              : (0, prompts_1.getScreenshotUserPrompt)(language, answerLang);
          ContextManager_1.contextManager.commitTurn(userPrompt, assistantText);
        }
        if (!result?.isStreamingComplete) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            result.data,
          );
        }
        this.deps.setView("solutions");
      } catch (error) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          error,
        );
        console.error("Processing error:", error);
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            "Processing was canceled by the user.",
          );
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            error.message || "Server error. Please try again.",
          );
        }
        // Reset view back to queue on error
        console.log("Resetting view to queue due to error");
        this.deps.setView("queue");
      } finally {
        this.currentProcessingAbortController = null;
      }
    } else {
      // view == 'solutions'
      const extraScreenshotQueue =
        this.screenshotHelper.getExtraScreenshotQueue();
      console.log("Processing extra queue screenshots:", extraScreenshotQueue);
      console.log("[Ctrl+Enter][Diag] debug route selected", {
        provider: config.apiProvider,
        mainQueueCount: this.screenshotHelper.getScreenshotQueue().length,
        extraQueueCount: extraScreenshotQueue.length,
        textPresent: Boolean(rendererTextSnapshot.trim()),
        textPreview: this.summarizeTextForLog(rendererTextSnapshot),
        currentProblemPreview,
      });
      // Check if the extra queue is empty
      if (!extraScreenshotQueue || extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }
      // Check that files actually exist
      const existingExtraScreenshots = extraScreenshotQueue.filter((path) =>
        node_fs_1.default.existsSync(path),
      );
      if (existingExtraScreenshots.length === 0) {
        console.log("Extra screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_START);
      // Initialize AbortController
      this.currentExtraProcessingAbortController = new AbortController();
      const { signal } = this.currentExtraProcessingAbortController;
      try {
        // Get all screenshots (both main and extra) for processing
        const allPaths = [
          ...this.screenshotHelper.getScreenshotQueue(),
          ...existingExtraScreenshots,
        ];
        const screenshots = await Promise.all(
          allPaths.map(async (path) => {
            try {
              if (!node_fs_1.default.existsSync(path)) {
                console.warn(`Screenshot file does not exist: ${path}`);
                return null;
              }
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: node_fs_1.default.readFileSync(path).toString("base64"),
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          }),
        );
        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(
          (screenshot) => screenshot !== null,
        );
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data for debugging");
        }
        console.log(
          "Combined screenshots for processing:",
          validScreenshots.map((s) => s.path),
        );
        const result = await this.processExtraScreenshotsHelper(
          validScreenshots,
          signal,
        );
        if (result.success) {
          this.deps.setHasDebugged(true);
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_SUCCESS,
            result.data,
          );
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            result.error,
          );
        }
      } catch (error) {
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            "Extra processing was canceled by the user.",
          );
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            error.message,
          );
        }
      } finally {
        // 调试流程结束后清空额外截图队列，避免历史叠加
        try {
          this.screenshotHelper.clearExtraScreenshotQueue();
        } catch {}
        this.currentExtraProcessingAbortController = null;
      }
    }
  }
  // 🔤 新增：处理纯文本输入
  async processRecentVoiceText() {
    const text = await this.deps.getMainWindow()?.webContents
      .executeJavaScript(`
      (() => {
        const count = Number(localStorage.getItem("recentVoiceSendCount"));
        const limit = Number.isInteger(count) && count >= 1 && count <= 8 ? count : 4;
        return (window.__VOICE_SENTENCES__ || [])
          .slice(-limit)
          .map(sentence => sentence.text.trim())
          .filter(Boolean)
          .join("\\n");
      })()
    `);
    if (typeof text === "string" && text.trim())
      await this.processTextOnly(text, false);
  }
  async processTextOnly(textFromRenderer, includeExtraScreenshots = true) {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) {
      console.error("Main window not available for text processing");
      return;
    }
    // License guard
    if (!(0, AccessGuard_1.guardFeatureAccess)().ok) {
      console.warn("Blocked by access guard: processTextOnly");
      return;
    }
    if (
      this.currentProcessingAbortController ||
      this.currentExtraProcessingAbortController
    ) {
      console.log(
        "[TextOnly] Ignored duplicate trigger while another response is running",
      );
      return;
    }
    const providerAccess = (0, AccessGuard_1.guardProviderAccess)(
      ConfigHelper_1.configHelper.loadConfig().apiProvider,
    );
    if (!providerAccess.ok) {
      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        providerAccess.reason === "custom_requires_full_card"
          ? "当前基础卡不支持自定义 1、2，请切换模型或使用 T/M 卡密。"
          : "请先完成卡密校验。",
      );
      return;
    }
    const config = ConfigHelper_1.configHelper.loadConfig();
    const viewAtStart = this.deps.getView();
    let consumedExtraPaths = [];
    let requestController = null;
    try {
      const rawTextInput =
        typeof textFromRenderer === "string"
          ? String(textFromRenderer)
          : await mainWindow.webContents.executeJavaScript(
              "window.__TEXT_INPUT__ || ''",
            );
      let extraScreenshots = [];
      if (includeExtraScreenshots && viewAtStart !== "queue") {
        const extraQueueSnapshot = [
          ...this.screenshotHelper.getExtraScreenshotQueue(),
        ];
        extraScreenshots = extraQueueSnapshot.flatMap((screenshotPath) => {
          try {
            if (!node_fs_1.default.existsSync(screenshotPath)) return [];
            return [
              {
                path: screenshotPath,
                data: node_fs_1.default
                  .readFileSync(screenshotPath)
                  .toString("base64"),
              },
            ];
          } catch (error) {
            console.warn(
              "[TextOnly] Failed to read follow-up screenshot:",
              screenshotPath,
              error,
            );
            return [];
          }
        });
        consumedExtraPaths = extraScreenshots.map(
          (screenshot) => screenshot.path,
        );
      }
      const hasNewScreenshots = extraScreenshots.length > 0;
      const textInput =
        String(rawTextInput || "").trim() ||
        (hasNewScreenshots ? "请结合新增截图继续回答当前问题。" : "");
      if (!textInput) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          "No text input provided",
        );
        return;
      }
      if (viewAtStart === "queue") {
        ContextManager_1.contextManager.clear();
      }
      const newImageBatch = this.createImageBatch(
        extraScreenshots,
        rawTextInput,
      );
      const candidateImageBatches =
        ContextManager_1.contextManager.getCandidateImageBatches(newImageBatch);
      console.log("Processing text only:", textInput.substring(0, 100) + "...");
      console.log("[TextOnly][Diag] processTextOnly start", {
        provider: config.apiProvider,
        viewAtStart,
        source:
          typeof textFromRenderer === "string"
            ? "renderer-payload"
            : "window.__TEXT_INPUT__",
        textLength: textInput.length,
        textPreview: this.summarizeTextForLog(textInput),
        newScreenshotCount: extraScreenshots.length,
        imageBatchCount: candidateImageBatches.length,
      });
      // 1) 先取消之前的流，防止旧 chunk 在新 INITIAL_START 之后到达前端
      try {
        this.cancelOngoingRequests(viewAtStart !== "queue");
      } catch {}
      // 2) 生成本轮唯一 sessionId，随每个 SOLUTION_PROGRESS chunk 发送
      const sessionId = this.createRequestSessionId();
      this.currentSessionId = sessionId;
      console.log("[TextOnly][Diag] session created", {
        sessionId,
        provider: config.apiProvider,
      });
      // 3) 发送开始处理事件（附带 sessionId，让前端知道新会话已开始）
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START, {
        sessionId,
      });
      try {
        this.deps.setView("solutions");
      } catch {}
      // 创建取消控制器
      requestController = new AbortController();
      this.currentProcessingAbortController = requestController;
      const { signal } = requestController;
      // 处理文本
      const result = await this.processTextOnlyHelper(
        textInput,
        signal,
        sessionId,
        candidateImageBatches,
      );
      if (result.success) {
        // Abort guard: if user cancelled mid-run, do not switch views or send success
        if (signal?.aborted) {
          console.log(
            "Aborted during text-only processing; skipping success/setView",
          );
          return;
        }
        // 🔥 检查是否是流式完成（Qwen模式）
        if (!result.isStreamingComplete) {
          // 非流式模式才发送SOLUTION_SUCCESS
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            result.data,
          );
        }
        const assistantText = this.getAssistantText(result);
        if (newImageBatch && assistantText) {
          ContextManager_1.contextManager.commitImageBatch(newImageBatch);
          this.screenshotHelper.removeExtraScreenshots(consumedExtraPaths);
        }
        // Only a queue-page request starts a new problem. Follow-ups must not
        // overwrite the original problem used by the existing Debug workflow.
        if (viewAtStart === "queue") {
          try {
            this.deps.setProblemInfo({ problem_statement: textInput });
          } catch {}
          console.log(
            "[TextOnly][Diag] updated problemInfo from new text question",
            {
              sessionId,
              problemPreview: this.summarizeTextForLog(textInput),
            },
          );
        }
        this.deps.setView("solutions");
      } else {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          result.error,
        );
      }
    } catch (error) {
      console.error("Error in processTextOnly:", error);
      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        error.message || "Failed to process text input",
      );
    } finally {
      if (this.currentProcessingAbortController === requestController) {
        this.currentProcessingAbortController = null;
      }
    }
  }
  // 🔄 新增：处理文本+截图组合输入
  async processWithInput() {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) {
      console.error("Main window not available for combined processing");
      return;
    }
    // License guard
    if (!(0, AccessGuard_1.guardFeatureAccess)().ok) {
      console.warn("Blocked by access guard: processWithInput");
      return;
    }
    const providerAccess = (0, AccessGuard_1.guardProviderAccess)(
      ConfigHelper_1.configHelper.loadConfig().apiProvider,
    );
    if (!providerAccess.ok) {
      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        providerAccess.reason === "custom_requires_full_card"
          ? "当前基础卡不支持自定义 1、2，请切换模型或使用 T/M 卡密。"
          : "请先完成卡密校验。",
      );
      return;
    }
    const config = ConfigHelper_1.configHelper.loadConfig();
    try {
      // 1) 捕获素材：根据视图选择队列（solutions/debug 优先使用额外队列；为空则仅文本，不回退主队列）
      const view = this.deps.getView();
      const mainQueue = this.screenshotHelper.getScreenshotQueue();
      const extraQueue = this.screenshotHelper.getExtraScreenshotQueue
        ? this.screenshotHelper.getExtraScreenshotQueue()
        : [];
      const textInput = await mainWindow.webContents.executeJavaScript(
        "window.__TEXT_INPUT__ || ''",
      );
      let chosenPaths = [];
      if (view === "queue") {
        chosenPaths = [...mainQueue];
      } else {
        chosenPaths = extraQueue.length > 0 ? [...extraQueue] : [];
      }
      console.log(
        `[Ctrl+D] new-dialog capture: view=${view}, main=${mainQueue.length}, extra=${extraQueue.length}, chosen=${chosenPaths.length}, text=${textInput && String(textInput).trim() ? "yes" : "no"}`,
      );
      console.log("[Ctrl+D][Diag] capture summary", {
        view,
        provider: config.apiProvider,
        mainQueueCount: mainQueue.length,
        extraQueueCount: extraQueue.length,
        chosenCount: chosenPaths.length,
        textPresent: Boolean(textInput && String(textInput).trim()),
        textPreview: this.summarizeTextForLog(textInput),
        currentProblemPreview: this.summarizeProblemInfoForLog(
          this.deps.getProblemInfo(),
        ),
      });
      // 预读文件到内存，避免重置时文件被删除
      let screenshots = [];
      if (chosenPaths.length > 0) {
        const loaded = await Promise.all(
          chosenPaths.map(async (p) => {
            try {
              if (!node_fs_1.default.existsSync(p)) return null;
              return {
                path: p,
                data: node_fs_1.default.readFileSync(p).toString("base64"),
              };
            } catch (e) {
              console.warn("[Ctrl+D] failed to read screenshot:", p, e);
              return null;
            }
          }),
        );
        screenshots = loaded.filter(Boolean);
      }
      const hasScreens = screenshots.length > 0;
      const hasText = Boolean(textInput && String(textInput).trim());
      if (!hasScreens && !hasText) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS,
          "No screenshots or text input provided",
        );
        console.log("[Ctrl+D] new-dialog aborted: no screenshots or text");
        return;
      }
      // 2) 软重置（等效 Ctrl+R，但不丢当前捕获的素材）
      ContextManager_1.contextManager.clear();
      try {
        this.cancelOngoingRequests();
      } catch {}
      try {
        this.screenshotHelper.clearQueues();
      } catch {}
      try {
        this.deps.setHasDebugged(false);
      } catch {}
      try {
        this.deps.setView("queue");
      } catch {}
      try {
        mainWindow.webContents.send("reset-view");
        mainWindow.webContents.send("reset");
      } catch {}
      // 3) 开始新的处理（使用捕获到的内存素材）
      const sessionId = this.createRequestSessionId();
      this.currentSessionId = sessionId;
      console.log("[Ctrl+D][Diag] session created", {
        sessionId,
        hasScreens,
        hasText,
        screenshotCount: screenshots.length,
        textPreview: this.summarizeTextForLog(textInput),
      });
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START, {
        sessionId,
      });
      try {
        this.deps.setView("solutions");
      } catch {}
      // 创建取消控制器
      this.currentProcessingAbortController = new AbortController();
      const { signal } = this.currentProcessingAbortController;
      let result;
      if (hasScreens && hasText) {
        console.log("[Ctrl+D] new-dialog using: screenshots+text", {
          count: screenshots.length,
        });
        result = await this.processScreenshotsWithTextHelper(
          screenshots,
          textInput,
          signal,
          sessionId,
        );
      } else if (hasScreens) {
        console.log("[Ctrl+D] new-dialog using: screenshots-only", {
          count: screenshots.length,
        });
        result = await this.processScreenshotsHelper(
          screenshots,
          signal,
          sessionId,
        );
      } else {
        console.log("[Ctrl+D] new-dialog using: text-only");
        result = await this.processTextOnlyHelper(textInput, signal, sessionId);
      }
      if (result?.success) {
        // Abort guard: if user cancelled mid-run, do not switch views or send success
        if (signal?.aborted) {
          console.log(
            "Aborted during combined processing; skipping success/setView",
          );
          return;
        }
        if (hasScreens) {
          const imageBatch = this.createImageBatch(
            screenshots,
            hasText ? String(textInput) : undefined,
          );
          const assistantText = this.getAssistantText(result);
          if (assistantText) {
            if (imageBatch)
              ContextManager_1.contextManager.commitImageBatch(imageBatch);
            const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
            const language = await this.getLanguage();
            const userPrompt =
              config?.xingceMode === true
                ? `${prompts_1.XINGCE_USER_PROMPT}${hasText ? `\n${String(textInput)}` : ""}`
                : (0, prompts_1.getScreenshotUserPrompt)(
                    language,
                    answerLang,
                    hasText ? String(textInput) : undefined,
                  );
            ContextManager_1.contextManager.commitTurn(
              userPrompt,
              assistantText,
            );
          }
        }
        // 成功：保持队列为空，进入 solutions
        try {
          // Ctrl+D 写回当前 problemInfo，便于后续调试（覆盖写，不累加）
          if (result?.isStreamingComplete) {
            // 流式：先用本次文本作为最小 problemInfo；完成时若有 structured 会覆盖
            if (hasText) {
              this.deps.setProblemInfo({
                problem_statement: String(textInput),
              });
            }
          } else if (result?.data) {
            const ps = result.data?.problem_statement;
            if (ps && typeof ps === "string") {
              this.deps.setProblemInfo({ problem_statement: ps });
            } else if (hasText) {
              this.deps.setProblemInfo({
                problem_statement: String(textInput),
              });
            }
          }
        } catch {}
        if (!result?.isStreamingComplete) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            result.data,
          );
        }
        this.deps.setView("solutions");
      } else {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          result?.error || "Failed to process combined input",
        );
      }
    } catch (error) {
      console.error("Error in processWithInput (new-dialog):", error);
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          error?.message || "Failed to process combined input",
        );
      }
    } finally {
      this.currentProcessingAbortController = null;
    }
  }
  async processScreenshotsHelper(screenshots, signal, sessionId = "") {
    try {
      const config = ConfigHelper_1.configHelper.loadConfig();
      const language = await this.getLanguage();
      const mainWindow = this.deps.getMainWindow();
      // Prepare image data list early for all branches
      const imageDataList = screenshots.map((screenshot) => screenshot.data);
      console.log("[ScreenshotOnly][Diag] processScreenshotsHelper start", {
        provider: config.apiProvider,
        sessionId,
        screenshotCount: screenshots.length,
        screenshots: screenshots
          .slice(0, 4)
          .map((s) => node_path_1.default.basename(s.path)),
      });
      // 🚦 Xingce mode: visual single-shot direct streaming (OpenAI/Qwen)
      if (
        config?.xingceMode === true &&
        (config.apiProvider === "openai" || config.apiProvider === "qwen")
      ) {
        const isOpenAI = config.apiProvider === "openai";
        const client = isOpenAI ? this.openaiClient : this.qwenClient;
        if (!client) {
          return {
            success: false,
            error: isOpenAI
              ? "OpenAI API key not configured. Please check your settings."
              : "Qwen API key not configured. Please check your settings.",
          };
        }
        try {
          const messages = [
            {
              role: "system",
              content: prompts_1.XINGCE_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: [
                { type: "text", text: prompts_1.XINGCE_USER_PROMPT },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          const stream = await client.chat.completions.create(
            {
              model: isOpenAI
                ? config.extractionModel || "gpt-5.4"
                : config.extractionModel || DEFAULT_QWEN_MODEL,
              ...(!isOpenAI
                ? getQwenThinkingParams(
                    config.extractionModel || DEFAULT_QWEN_MODEL,
                  )
                : {}),
              messages,
              ...(isOpenAI
                ? this.getOfficialOpenAIChatLimit(8000)
                : { max_tokens: 8000, temperature: 0.2 }),
              stream: true,
            },
            { signal },
          );
          let full = "";
          let chunks = 0;
          for await (const chunk of stream) {
            if (signal?.aborted) {
              break;
            }
            const content = chunk.choices?.[0]?.delta?.content || "";
            const done =
              chunk.choices?.[0]?.finish_reason === "stop" ||
              chunk.choices?.[0]?.finish_reason === "length";
            if (content) {
              full += content;
              chunks++;
              const win = this.deps.getMainWindow?.() || mainWindow;
              if (win && !win.isDestroyed()) {
                win.webContents.send(
                  this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                  {
                    content,
                    fullContent: full,
                    chunkIndex: chunks,
                    provider: isOpenAI ? "openai" : "qwen",
                    sessionId,
                  },
                );
              }
            }
            if (done) break;
          }
          if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: isOpenAI ? "openai" : "qwen",
                sessionId,
              },
            );
          }
          return {
            success: true,
            data: null,
            assistantText: full,
            isStreamingComplete: true,
          };
        } catch (e) {
          console.error("Xingce streaming error:", e);
          return { success: false, error: "请检查APIKey等设置是否正确" };
        }
      } else if (
        config?.xingceMode === true &&
        config.apiProvider === "custom"
      ) {
        const client = this.customClient;
        if (!client) {
          return {
            success: false,
            error:
              "Custom provider not configured. Please check Base URL / API Key / Model ID.",
          };
        }
        try {
          const systemPrompt =
            typeof config?.customPrompt === "string" &&
            config.customPrompt.trim().length > 0
              ? String(config.customPrompt)
              : prompts_1.XINGCE_SYSTEM_PROMPT;
          const messages = [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: [
                { type: "text", text: prompts_1.XINGCE_USER_PROMPT },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          const modelId = config?.customModelId || "";
          if (!modelId) {
            return { success: false, error: "Custom model ID not configured" };
          }
          const stream = await client.chat.completions.create({
            model: modelId,
            ...getQwenThinkingParams(modelId),
            messages,
            max_tokens: 8000,
            temperature: 0.2,
            stream: true,
          });
          let full = "";
          let chunks = 0;
          for await (const chunk of stream) {
            if (signal?.aborted) {
              break;
            }
            const content = chunk.choices?.[0]?.delta?.content || "";
            const done =
              chunk.choices?.[0]?.finish_reason === "stop" ||
              chunk.choices?.[0]?.finish_reason === "length";
            if (content) {
              full += content;
              chunks++;
              const win = this.deps.getMainWindow?.() || mainWindow;
              if (win && !win.isDestroyed()) {
                win.webContents.send(
                  this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                  {
                    content,
                    fullContent: full,
                    chunkIndex: chunks,
                    provider: "custom",
                    sessionId,
                  },
                );
              }
            }
            if (done) break;
          }
          if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "custom",
                sessionId,
              },
            );
          }
          return {
            success: true,
            data: null,
            assistantText: full,
            isStreamingComplete: true,
          };
        } catch (e) {
          console.error("Xingce streaming error (custom):", e);
          return { success: false, error: "请检查APIKey等设置是否正确" };
        }
      } else if (
        config?.xingceMode === true &&
        config.apiProvider === "custom2"
      ) {
        const client = this.custom2Client;
        if (!client) {
          return {
            success: false,
            error:
              "Custom2 provider not configured. Please check Base URL / API Key / Model ID.",
          };
        }
        try {
          const systemPrompt =
            typeof config?.custom2Prompt === "string" &&
            config.custom2Prompt.trim().length > 0
              ? String(config.custom2Prompt)
              : prompts_1.XINGCE_SYSTEM_PROMPT;
          const messages = [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: [
                { type: "text", text: prompts_1.XINGCE_USER_PROMPT },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          const modelId = config?.custom2ModelId || "";
          if (!modelId) {
            return { success: false, error: "Custom2 model ID not configured" };
          }
          const stream = await client.chat.completions.create({
            model: modelId,
            messages,
            max_tokens: 8000,
            temperature: 0.2,
            stream: true,
          });
          let full = "";
          let chunks = 0;
          for await (const chunk of stream) {
            if (signal?.aborted) {
              break;
            }
            const content = chunk.choices?.[0]?.delta?.content || "";
            const done =
              chunk.choices?.[0]?.finish_reason === "stop" ||
              chunk.choices?.[0]?.finish_reason === "length";
            if (content) {
              full += content;
              chunks++;
              const win = this.deps.getMainWindow?.() || mainWindow;
              if (win && !win.isDestroyed()) {
                win.webContents.send(
                  this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                  {
                    content,
                    fullContent: full,
                    chunkIndex: chunks,
                    provider: "custom2",
                    sessionId,
                  },
                );
              }
            }
            if (done) break;
          }
          if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "custom2",
                sessionId,
              },
            );
          }
          return {
            success: true,
            data: null,
            assistantText: full,
            isStreamingComplete: true,
          };
        } catch (e) {
          console.error("Xingce streaming error (custom2):", e);
          return { success: false, error: "请检查APIKey等设置是否正确" };
        }
      } else if (
        config?.xingceMode === true &&
        config.apiProvider === "openrouter"
      ) {
        const client = this.openrouterClient;
        if (!client) {
          return {
            success: false,
            error:
              "OpenRouter API key not configured. Please check your settings.",
          };
        }
        try {
          const messages = [
            {
              role: "system",
              content: prompts_1.XINGCE_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: [
                { type: "text", text: prompts_1.XINGCE_USER_PROMPT },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          const modelId =
            config?.openrouterModel || "google/gemini-2.5-flash-lite";
          const stream = await client.chat.completions.create(
            {
              model: modelId,
              messages,
              max_tokens: 8000,
              temperature: 0.2,
              stream: true,
            },
            { signal },
          );
          let full = "";
          let chunks = 0;
          for await (const chunk of stream) {
            if (signal?.aborted) {
              break;
            }
            const content = chunk.choices?.[0]?.delta?.content || "";
            const done =
              chunk.choices?.[0]?.finish_reason === "stop" ||
              chunk.choices?.[0]?.finish_reason === "length";
            if (content) {
              full += content;
              chunks++;
              const win = this.deps.getMainWindow?.() || mainWindow;
              if (win && !win.isDestroyed()) {
                win.webContents.send(
                  this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                  {
                    content,
                    fullContent: full,
                    chunkIndex: chunks,
                    provider: "openrouter",
                    sessionId,
                  },
                );
              }
            }
            if (done) break;
          }
          if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "openrouter",
                sessionId,
              },
            );
          }
          return {
            success: true,
            data: null,
            assistantText: full,
            isStreamingComplete: true,
          };
        } catch (e) {
          console.error("Xingce streaming error (openrouter):", e);
          return {
            success: false,
            error: "请检查 OpenRouter APIKey 等设置是否正确",
          };
        }
      }
      // Step 1: Extract problem info using AI Vision API (OpenAI or Gemini)
      // const imageDataList = screenshots.map(screenshot => screenshot.data);
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Analyzing problem from screenshots...",
          progress: 20,
        });
      }
      let problemInfo;
      if (config.apiProvider === "openai") {
        // Verify OpenAI client
        if (!this.openaiClient) {
          this.initializeAIClient(); // Try to reinitialize
          if (!this.openaiClient) {
            return {
              success: false,
              error:
                "OpenAI API key not configured or invalid. Please check your settings.",
            };
          }
        }
        // 🔥 OpenAI 直解（流式）：跳过"抽取→解答"，直接基于截图作答
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const messages = [
          {
            role: "system",
            content: (0, prompts_1.getScreenshotSolvePrompt)(answerLang),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: (0, prompts_1.getScreenshotUserPrompt)(
                  language,
                  answerLang,
                ),
              },
              ...imageDataList.map((data) => ({
                type: "image_url",
                image_url: { url: `data:image/png;base64,${data}` },
              })),
            ],
          },
        ];
        const stream = await this.openaiClient.chat.completions.create(
          {
            model: config.solutionModel || "gpt-5.4",
            messages,
            ...this.getOfficialOpenAIChatLimit(8000),
            stream: true,
          },
          { signal },
        );
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const content = chunk.choices?.[0]?.delta?.content || "";
          const done =
            chunk.choices?.[0]?.finish_reason === "stop" ||
            chunk.choices?.[0]?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.() || mainWindow;
            if (win && !win.isDestroyed()) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "openai",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
          // Try to parse structured JSON so the Solution page can render code
          const parseStructured = (raw) => {
            const clean = (raw || "").replace(/```json|```/g, "").trim();
            try {
              return JSON.parse(clean);
            } catch {}
            const decoded = clean
              .replace(/\\n/g, "\n")
              .replace(/\\t/g, "\t")
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, "\\");
            try {
              return JSON.parse(decoded);
            } catch {}
            try {
              const once = JSON.parse(clean);
              if (typeof once === "string") {
                try {
                  return JSON.parse(once);
                } catch {}
              }
            } catch {}
            try {
              const once = JSON.parse(decoded);
              if (typeof once === "string") {
                try {
                  return JSON.parse(once);
                } catch {}
              }
            } catch {}
            return null;
          };
          const canonicalize = (obj) => {
            if (!obj || typeof obj !== "object") return obj;
            const out = { ...obj };
            if (out.solution == null)
              out.solution = out.solution_code ?? out.code;
            return out;
          };
          const parsed = parseStructured(full);
          const structured = parsed ? canonicalize(parsed) : null;
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
            {
              content: "",
              fullContent: full,
              chunkIndex: chunks + 1,
              isComplete: true,
              provider: "openai",
              structured,
              sessionId,
            },
          );
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "gemini") {
        // Use Gemini via OpenAI-compatible proxy (unified with OpenAI path)
        if (!this.geminiClient) {
          this.initializeAIClient();
          if (!this.geminiClient) {
            return {
              success: false,
              error:
                "Gemini client not configured. Please check your settings.",
            };
          }
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const messages = [
          {
            role: "system",
            content: (0, prompts_1.getScreenshotSolvePrompt)(answerLang),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: (0, prompts_1.getScreenshotUserPrompt)(
                  language,
                  answerLang,
                ),
              },
              ...imageDataList.map((data) => ({
                type: "image_url",
                image_url: { url: `data:image/png;base64,${data}` },
              })),
            ],
          },
        ];
        const stream = await this.geminiClient.chat.completions.create(
          {
            model: config.solutionModel || "gemini-2.5-pro",
            messages,
            max_tokens: 8000,
            temperature: 0.1,
            top_p: 0.2,
            stream: true,
          },
          { signal },
        );
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const content = chunk.choices?.[0]?.delta?.content || "";
          const done =
            chunk.choices?.[0]?.finish_reason === "stop" ||
            chunk.choices?.[0]?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.() || mainWindow;
            if (win && !win.isDestroyed()) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "gemini",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
          const parseStructured = (raw) => {
            const clean = (raw || "").replace(/```json|```/g, "").trim();
            try {
              return JSON.parse(clean);
            } catch {}
            const decoded = clean
              .replace(/\\n/g, "\n")
              .replace(/\\t/g, "\t")
              .replace(/\\\"/g, '"')
              .replace(/\\\\/g, "\\");
            try {
              return JSON.parse(decoded);
            } catch {}
            try {
              const once = JSON.parse(clean);
              if (typeof once === "string") {
                try {
                  return JSON.parse(once);
                } catch {}
              }
            } catch {}
            try {
              const once = JSON.parse(decoded);
              if (typeof once === "string") {
                try {
                  return JSON.parse(once);
                } catch {}
              }
            } catch {}
            return null;
          };
          const canonicalize = (obj) => {
            if (!obj || typeof obj !== "object") return obj;
            const out = { ...obj };
            if (out.solution == null)
              out.solution = out.solution_code ?? out.code;
            return out;
          };
          const parsed = parseStructured(full);
          const structured = parsed ? canonicalize(parsed) : null;
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
            {
              content: "",
              fullContent: full,
              chunkIndex: chunks + 1,
              isComplete: true,
              provider: "gemini",
              structured,
              sessionId,
            },
          );
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
        // Old direct Google API call kept for reference
        // const response = await axios.default.post(...)
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error:
              "Anthropic API key not configured. Please check your settings.",
          };
        }
        // 🔥 Claude 直解：跳过"抽取→解答"，直接基于截图作答
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const systemPrompt = (0, prompts_1.getScreenshotSolvePrompt)(
            answerLang,
          );
          const userPrompt = (0, prompts_1.getScreenshotUserPrompt)(
            language,
            answerLang,
          );
          const messages = [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${systemPrompt}\n\n${userPrompt}`,
                },
                ...imageDataList.map((data) => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: data,
                  },
                })),
              ],
            },
          ];
          // Claude 流式调用
          const stream = await this.anthropicClient.messages.stream({
            model: config.solutionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 8000,
            messages: messages,
            temperature: 0.2,
          });
          let full = "";
          let chunks = 0;
          for await (const event of stream) {
            if (signal?.aborted) break;
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const text = event.delta.text;
              full += text;
              chunks++;
              if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                  {
                    content: text,
                    fullContent: full,
                    chunkIndex: chunks,
                    isComplete: false,
                    provider: "anthropic",
                    sessionId,
                  },
                );
              }
            }
          }
          // 发送完成信号
          if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "anthropic",
                sessionId,
              },
            );
          }
          return {
            success: true,
            data: null,
            assistantText: full,
            isStreamingComplete: true,
          };
        } catch (error) {
          console.error("Error using Anthropic API:", error);
          if (error.status === 429) {
            return {
              success: false,
              error:
                "Claude API rate limit exceeded. Please wait a few minutes before trying again.",
            };
          } else if (
            error.status === 413 ||
            (error.message && error.message.includes("token"))
          ) {
            return {
              success: false,
              error:
                "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs.",
            };
          }
          return {
            success: false,
            error:
              "Failed to process with Anthropic API. Please check your API key or try again later.",
          };
        }
      } else if (config.apiProvider === "qwen") {
        if (!this.qwenClient) {
          return {
            success: false,
            error: "Qwen API key not configured. Please check your settings.",
          };
        }
        // ========== Qwen 一步解答流程（简化版，类似 Custom）==========
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const systemPrompt = (0, prompts_1.getSolutionPrompt)(answerLang);
          const contents = [];
          // Optional text input - 使用统一的 prompt 函数
          // [DISABLED] 不再主动抓取前端残留语音文本，确保 Command+Enter 只发截图
          // try {
          //   const text = await this.deps.getMainWindow()?.webContents.executeJavaScript(
          //     "(window.__TEXT_INPUT__ && String(window.__TEXT_INPUT__)) || ''"
          //   )
          //   const extraText = (text && typeof text === 'string' && text.trim().length > 0) ? text.trim() : undefined
          //   contents.push({ type: "text", text: getScreenshotUserPrompt(language, answerLang, extraText) })
          // } catch {
          contents.push({
            type: "text",
            text: (0, prompts_1.getScreenshotUserPrompt)(language, answerLang),
          });
          // }
          // Images
          for (const data of imageDataList) {
            contents.push({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${data}` },
            });
          }
          const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: contents },
          ];
          // ⏱️ 故意延迟（仅 Qwen 和 OpenRouter 受影响，Custom 不受影响）
          await new Promise((resolve) =>
            setTimeout(resolve, getAiPreRequestDelayMs()),
          );
          if (signal?.aborted) return { success: false, error: "Cancelled" };
          // Qwen 一步解答流式调用
          const stream = await this.qwenClient.chat.completions.create(
            {
              model: config.extractionModel || DEFAULT_QWEN_MODEL,
              ...getQwenThinkingParams(
                config.extractionModel || DEFAULT_QWEN_MODEL,
              ),
              messages,
              max_tokens: 8000,
              temperature: 0.2,
              stream: true,
            },
            { signal },
          );
          let fullResponse = "";
          let chunkCount = 0;
          for await (const chunk of stream) {
            if (signal?.aborted) break;
            const content = chunk.choices?.[0]?.delta?.content || "";
            const done =
              chunk.choices?.[0]?.finish_reason === "stop" ||
              chunk.choices?.[0]?.finish_reason === "length";
            if (content) {
              fullResponse += content;
              chunkCount++;
              // 发送流式进度到前端
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                  {
                    content,
                    fullContent: fullResponse,
                    chunkIndex: chunkCount,
                    provider: "qwen",
                    sessionId,
                  },
                );
              }
              // 反检测延迟
              if (chunkCount % 4 === 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, Math.random() * 30 + 10),
                );
              }
            }
            if (done) break;
          }
          // 完成信号
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: fullResponse,
                chunkIndex: chunkCount,
                isComplete: true,
                provider: "qwen",
                sessionId,
              },
            );
          }
          // Qwen 一步解答完成，直接返回
          return {
            success: true,
            data: null,
            assistantText: fullResponse,
            isStreamingComplete: true,
          };
        } catch (error) {
          console.error("Error using Qwen API:", error);
          // Add specific handling for Qwen limitations
          if (error?.response?.status === 401) {
            return {
              success: false,
              error: "Invalid Qwen API key. Please check your settings.",
            };
          } else if (error?.response?.status === 429) {
            return {
              success: false,
              error: "Qwen API rate limit exceeded. Please try again later.",
            };
          }
          return {
            success: false,
            error:
              "Failed to process with Qwen API. Please check your API key or try again later.",
          };
        }
      } else if (config.apiProvider === "openrouter") {
        // OpenRouter 直解（流式）
        if (!this.openrouterClient) {
          return {
            success: false,
            error:
              "OpenRouter API key not configured. Please check your settings.",
          };
        }
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const openrouterModel =
            config?.openrouterModel || "google/gemini-2.5-flash-lite";
          const contents = [];
          // [DISABLED] 不再主动抓取前端残留语音文本，确保 Command+Enter 只发截图
          // try {
          //   const text = await this.deps.getMainWindow()?.webContents.executeJavaScript(
          //     "(window.__TEXT_INPUT__ && String(window.__TEXT_INPUT__)) || ''"
          //   )
          //   const extraText = (text && typeof text === 'string' && text.trim().length > 0) ? text.trim() : undefined
          //   contents.push({ type: "text", text: getScreenshotUserPrompt(language, answerLang, extraText) })
          // } catch {
          contents.push({
            type: "text",
            text: (0, prompts_1.getScreenshotUserPrompt)(language, answerLang),
          });
          // }
          for (const data of imageDataList) {
            contents.push({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${data}` },
            });
          }
          const messages = [
            {
              role: "system",
              content: (0, prompts_1.getScreenshotSolvePrompt)(answerLang),
            },
            { role: "user", content: contents },
          ];
          // ⏱️ 故意延迟（仅 Qwen 和 OpenRouter 受影响，Custom 不受影响）
          await new Promise((resolve) =>
            setTimeout(resolve, getAiPreRequestDelayMs()),
          );
          if (signal?.aborted) return { success: false, error: "Cancelled" };
          const stream = await this.openrouterClient.chat.completions.create(
            {
              model: openrouterModel,
              messages,
              max_tokens: 8000,
              temperature: 0.2,
              stream: true,
            },
            { signal },
          );
          let fullResponse = "";
          let chunkCount = 0;
          for await (const chunk of stream) {
            if (signal?.aborted) break;
            const content = chunk.choices?.[0]?.delta?.content || "";
            if (content) {
              fullResponse += content;
              chunkCount++;
              if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                  {
                    content,
                    fullContent: fullResponse,
                    chunkIndex: chunkCount,
                    isComplete: false,
                    provider: "openrouter",
                    sessionId,
                  },
                );
              }
            }
          }
          if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: fullResponse,
                chunkIndex: chunkCount + 1,
                isComplete: true,
                provider: "openrouter",
                sessionId,
              },
            );
          }
          return {
            success: true,
            data: null,
            assistantText: fullResponse,
            isStreamingComplete: true,
          };
        } catch (error) {
          console.error("OpenRouter:", error);
          // 直接返回 OpenRouter 平台返回的原始错误信息
          const errorMessage =
            error?.error?.message ||
            error?.message ||
            "Failed to process with OpenRouter API. Please check your API key or try again later.";
          return {
            success: false,
            error: errorMessage,
          };
        }
      } else if (config.apiProvider === "custom") {
        // Verify custom client
        if (!this.customClient) {
          this.initializeAIClient();
          if (!this.customClient) {
            return {
              success: false,
              error:
                "Custom provider not configured. Please set Base URL / Model ID / API Key.",
            };
          }
        }
        const systemPrompt =
          config?.customPrompt && String(config.customPrompt).trim().length > 0
            ? String(config.customPrompt)
            : prompts_1.CUSTOM_DEFAULT_PROMPT;
        const contents = [];
        // [DISABLED] 不再主动抓取前端残留语音文本，确保 Command+Enter 只发截图
        // try {
        //   const text = await this.deps.getMainWindow()?.webContents.executeJavaScript(
        //     "(window.__TEXT_INPUT__ && String(window.__TEXT_INPUT__)) || ''"
        //   )
        //   if (text && typeof text === 'string' && text.trim().length > 0) {
        //     contents.push({ type: "text", text })
        //   }
        // } catch { }
        // Images
        for (const data of imageDataList) {
          contents.push({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${data}` },
          });
        }
        if (contents.length === 0) {
          contents.push({ type: "text", text: "请直接回答：" });
        }
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: contents },
        ];
        const modelId = config?.customModelId || "";
        if (!modelId) {
          return { success: false, error: "自定义模型ID未设置" };
        }
        const finalMessages = messages;
        const stream = await this.customClient.chat.completions.create(
          {
            model: modelId,
            ...getQwenThinkingParams(modelId),
            messages: finalMessages,
            max_tokens: 8000,
            temperature: 0.2,
            stream: true,
          },
          { signal },
        );
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const content = chunk?.choices?.[0]?.delta?.content || "";
          const done =
            chunk?.choices?.[0]?.finish_reason === "stop" ||
            chunk?.choices?.[0]?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.() || mainWindow;
            if (win && !win.isDestroyed()) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "custom",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
            {
              content: "",
              fullContent: full,
              chunkIndex: chunks + 1,
              isComplete: true,
              provider: "custom",
              sessionId,
            },
          );
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "custom2") {
        // Verify custom2 client
        if (!this.custom2Client) {
          this.initializeAIClient();
          if (!this.custom2Client) {
            return {
              success: false,
              error:
                "Custom2 provider not configured. Please set Base URL / Model ID / API Key.",
            };
          }
        }
        const systemPrompt =
          config?.custom2Prompt &&
          String(config.custom2Prompt).trim().length > 0
            ? String(config.custom2Prompt)
            : prompts_1.CUSTOM_DEFAULT_PROMPT;
        const contents = [];
        // [DISABLED] 不再主动抓取前端残留语音文本，确保 Command+Enter 只发截图
        // Images
        for (const data of imageDataList) {
          contents.push({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${data}` },
          });
        }
        if (contents.length === 0) {
          contents.push({ type: "text", text: "请直接回答：" });
        }
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: contents },
        ];
        const modelId = config?.custom2ModelId || "";
        if (!modelId) {
          return { success: false, error: "自定义2模型ID未设置" };
        }
        const finalMessages = messages;
        const stream = await this.custom2Client.chat.completions.create(
          {
            model: modelId,
            messages: finalMessages,
            max_tokens: 8000,
            temperature: 0.2,
            stream: true,
          },
          { signal },
        );
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const content = chunk?.choices?.[0]?.delta?.content || "";
          const done =
            chunk?.choices?.[0]?.finish_reason === "stop" ||
            chunk?.choices?.[0]?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.() || mainWindow;
            if (win && !win.isDestroyed()) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "custom2",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        if (!signal?.aborted && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
            {
              content: "",
              fullContent: full,
              chunkIndex: chunks + 1,
              isComplete: true,
              provider: "custom2",
              sessionId,
            },
          );
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      }
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message:
            "Problem analyzed successfully. Preparing to generate solution...",
          progress: 40,
        });
      }
      // Store problem info in AppState
      this.deps.setProblemInfo(problemInfo);
      // Send first success event
      if (mainWindow) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
          problemInfo,
        );
        // ✅ 抽取即直答：若 problem_statement 已包含 Answer: 则直接返回，跳过后续 solution 阶段
        const extractDirectAnswers = (info) => {
          const getFrom = (ps) => {
            if (typeof ps !== "string") return null;
            const match = ps.match(/Answer:\s*([^\n]+)\s*$/i);
            return match
              ? `Answer: ${match[1].replace(/\s+/g, " ").trim()}`
              : null;
          };
          const out = [];
          try {
            if (Array.isArray(info?.problems)) {
              for (const p of info.problems) {
                const a = getFrom(p?.problem_statement);
                if (a) out.push(a);
              }
            } else {
              const a = getFrom(info?.problem_statement);
              if (a) out.push(a);
            }
          } catch {}
          return out;
        };
        const directAnswerLines = extractDirectAnswers(problemInfo);
        if (directAnswerLines.length > 0) {
          // 标注直解路径并直接返回
          mainWindow.webContents.send("processing-status", {
            message: "route=visual_direct (short-circuit)",
            progress: 90,
          });
          const formattedDirect = {
            code: directAnswerLines.join("\n"),
            thoughts: ["直接解答"],
            time_complexity: "N/A",
            space_complexity: "N/A",
          };
          try {
            this.screenshotHelper.clearExtraScreenshotQueue();
          } catch {}
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            formattedDirect,
          );
          return { success: true, data: formattedDirect };
        }
        // Generate solutions after successful extraction
        const solutionsResult = await this.generateSolutionsHelper(signal);
        if (solutionsResult.success) {
          // Clear any existing extra screenshots before transitioning to solutions view
          this.screenshotHelper.clearExtraScreenshotQueue();
          // Final progress update
          mainWindow.webContents.send("processing-status", {
            message: "Solution generated successfully",
            progress: 100,
          });
          // 🔥 检查是否是流式完成（Qwen模式）
          if (solutionsResult.isStreamingComplete) {
            // 流式已经自行处理了所有逻辑，不需要发送SOLUTION_SUCCESS
            return {
              success: true,
              data: null,
              assistantText: solutionsResult.assistantText,
              isStreamingComplete: true,
            };
          } else {
            // 非流式模式，发送SOLUTION_SUCCESS
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
              solutionsResult.data,
            );
            return { success: true, data: solutionsResult.data };
          }
        } else {
          throw new Error(
            solutionsResult.error || "Failed to generate solutions",
          );
        }
      }
      return { success: false, error: "Failed to process screenshots" };
    } catch (error) {
      // If the request was cancelled, don't retry
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user.",
        };
      }
      // Handle OpenAI API errors specifically
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings.",
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error:
            "OpenAI API rate limit exceeded or insufficient credits. Please try again later.",
        };
      } else if (error?.response?.status === 500) {
        return {
          success: false,
          error: "OpenAI server error. Please try again later.",
        };
      }
      console.error("API Error Details:", error);
      return {
        success: false,
        error:
          error.message || "Failed to process screenshots. Please try again.",
      };
    }
  }
  async generateSolutionsHelper(signal) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = ConfigHelper_1.configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();
      if (!problemInfo) {
        // Fallback: provide a minimal default so debug flow won't abort.
        const fallback = { problem_statement: "帮我解决图中的报错" };
        try {
          this.deps.setProblemInfo(fallback);
        } catch {}
        try {
          console.warn(
            "[DEBUG] problemInfo missing; using fallback default problem_statement",
          );
        } catch {}
      }
      // Re-read (fallback may have been set)
      const effectiveProblemInfo = this.deps.getProblemInfo();
      if (!effectiveProblemInfo) {
        // Extremely defensive: if still null, keep previous behavior
        throw new Error("No problem info available");
      }
      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Creating optimal solution with detailed explanations...",
          progress: 60,
        });
      }
      // Create prompt for solution generation
      // Normalize programming language label for better model adherence
      const _langKey = (language || "").toLowerCase();
      const languageLabel =
        {
          cpp: "C++",
          golang: "Go",
          javascript: "JavaScript",
          typescript: "TypeScript",
          python: "Python",
          java: "Java",
          swift: "Swift",
          kotlin: "Kotlin",
          ruby: "Ruby",
          sql: "SQL",
          r: "R",
        }[_langKey] || language;
      const problemsArray = Array.isArray(problemInfo?.problems)
        ? problemInfo.problems
        : null;
      const singleProblem = !problemsArray;
      const formatOptions = (p) => {
        const o = p?.options || p?.choice_options || null;
        if (!o || (!o.A && !o.B && !o.C && !o.D)) return "";
        return `\n选项：\nA. ${o.A ?? ""}\nB. ${o.B ?? ""}\nC. ${o.C ?? ""}\nD. ${o.D ?? ""}\n`;
      };
      const problemSectionZh = singleProblem
        ? `题目描述：\n${problemInfo.problem_statement}\n${formatOptions(problemInfo)}\n约束条件：\n${problemInfo.constraints || "无特殊约束条件"}\n\n示例输入：\n${problemInfo.example_input || "无示例输入"}\n\n示例输出：\n${problemInfo.example_output || "无示例输出"}`
        : problemsArray
            .map(
              (p, i) =>
                `题目${i + 1}：\n${p.problem_statement}\n${formatOptions(p)}\n`,
            )
            .join("\n");
      const problemSectionEn = singleProblem
        ? `Problem Description:\n${problemInfo.problem_statement}\n${formatOptions(problemInfo)}\nConstraints:\n${problemInfo.constraints || "No special constraints"}\n\nSample Input:\n${problemInfo.example_input || "N/A"}\n\nSample Output:\n${problemInfo.example_output || "N/A"}`
        : problemsArray
            .map(
              (p, i) =>
                `Q${i + 1}:\n${p.problem_statement}\n${formatOptions(p)}\n`,
            )
            .join("\n");
      const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
      const promptText =
        answerLang === "en"
          ? `\nPlease provide accurate and comprehensive solutions. If multiple problems are present, answer each (Q1, Q2, ...).\n\n${problemSectionEn}\n\nReply language: English\n\nFor coding problems:\n- Provide complete ${languageLabel} code that is runnable with a main/entry function\n- Read input according to the problem's input format (stdin/argv as appropriate) and write output in the required format (stdout/print)\n- Use concise inline comments only (no header or block comments); do NOT restate the problem in solution\n- Whitespace rules (apply to both problem_statement and solution): do not insert extra blank lines; use exactly one "\\n" between consecutive lines; do not start or end with a blank line; collapse multiple consecutive blank lines into a single newline\n- **Explanation Requirements (Critical - Must be comprehensive):**\n  1. Problem Analysis: Deep analysis of requirements and constraints\n  2. Algorithm Approach: Detailed explanation of the chosen algorithm and data structures\n  3. Implementation Details: Step-by-step walkthrough of key code sections\n  4. Edge Cases: How special inputs and boundary conditions are handled\n  5. Complexity Analysis: Detailed explanation of time and space complexity with reasoning\n- The explanation should be thorough, typically 3-5 paragraphs with 2-4 sentences each\n- Use natural, conversational language that flows well between ideas`
          : `\n请提供准确解答。若存在多道题，请分别作答（题1、题2、…）。\n\n${problemSectionZh}\n\n回复语言：中文\n\n若为代码题：\n- 请先输出完整的${languageLabel}可运行代码（放在 solution 字段，且置于最前）\n- 必须包含主函数/入口，严格按照题目的输入/输出格式读写（stdin/stdout 或等价方式）\n- 仅使用必要行内注释（不要文件头注释/段落性注释）；不要在 solution 中复述题干\n\n**解释要求（非常重要 - 必须详细全面）：**\n- explanation字段必须包含详尽的解释，根据题目类型至少包含以下相关内容：\n  1. 问题分析：深入分析题目要求和关键约束条件\n  2. 思路演进：从最初想法到最终答案的完整思考过程\n  3. 方法原理：详细说明所使用的方法、技术或解决思路的选择原因\n  4. 具体解析：关键步骤、要点或实现的具体作用和细节说明\n  5. 特殊情况处理：如何处理边界条件、特殊情况或例外情形\n  6. 深入思考：为什么选择这种方案，还有什么其他可能的解决思路\n- 对于代码题：同时包含时间空间复杂度的详细分析，说明为什么是这个复杂度\n- 解释长度要求：explanation内容应该详细充分，通常需要3-5个自然段，每段2-4句话\n- 表达风格：用连贯的自然段详细解释思路，像跟朋友交谈一样，避免机械化、完美化的AI风格\n- 空白/格式规则（同时作用于 problem_statement 与 solution）：禁止多余空行；相邻行之间只使用一个换行符"\\n"；开头与结尾不得是空行；若出现连续空行请折叠为单一换行`;
      let responseContent;
      if (config.apiProvider === "openai") {
        // OpenAI processing
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings.",
          };
        }
        // Send to OpenAI API
        const solutionResponse =
          await this.openaiClient.chat.completions.create({
            model: config.solutionModel || "gpt-5.4",
            messages: [
              {
                role: "system",
                content:
                  "You are an expert coding interview assistant. Provide clear, optimal solutions with detailed explanations.",
              },
              { role: "user", content: promptText },
            ],
            ...this.getOfficialOpenAIChatLimit(8000),
          });
        responseContent = solutionResponse.choices[0].message.content;
      } else if (config.apiProvider === "gemini") {
        // Gemini processing via OpenAI-compatible proxy
        if (!this.geminiClient) {
          this.initializeAIClient();
          if (!this.geminiClient) {
            return {
              success: false,
              error:
                "Gemini client not configured. Please check your settings.",
            };
          }
        }
        try {
          const solutionResponse =
            await this.geminiClient.chat.completions.create({
              model: config.solutionModel || "gemini-2.5-pro",
              messages: [
                {
                  role: "system",
                  content:
                    "You are an expert coding interview assistant. Provide clear, optimal solutions with detailed explanations.",
                },
                { role: "user", content: promptText },
              ],
              max_tokens: 8000,
              temperature: 0.2,
            });
          responseContent = solutionResponse.choices[0].message.content;
        } catch (error) {
          console.error("Error using Gemini client for solution:", error);
          return {
            success: false,
            error:
              "Failed to generate solution with Gemini client. Please check your settings.",
          };
        }
      } else if (config.apiProvider === "anthropic") {
        // Anthropic processing
        if (!this.anthropicClient) {
          return {
            success: false,
            error:
              "Anthropic API key not configured. Please check your settings.",
          };
        }
        try {
          const messages = [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `You are an expert coding interview assistant. Provide a clear, optimal solution with detailed explanations for this problem:\n\n${promptText}`,
                },
              ],
            },
          ];
          // Send to Anthropic API
          const response = await this.anthropicClient.messages.create(
            {
              model: config.solutionModel || "claude-3-7-sonnet-20250219",
              max_tokens: 8000,
              messages: messages,
              temperature: 0.2,
            },
            { signal },
          );
          responseContent = response.content[0].text;
        } catch (error) {
          console.error("Error using Anthropic API for solution:", error);
          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error:
                "Claude API rate limit exceeded. Please wait a few minutes before trying again.",
            };
          } else if (
            error.status === 413 ||
            (error.message && error.message.includes("token"))
          ) {
            return {
              success: false,
              error:
                "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs.",
            };
          }
          return {
            success: false,
            error:
              "Failed to generate solution with Anthropic API. Please check your API key or try again later.",
          };
        }
      } else if (config.apiProvider === "qwen") {
        // Qwen processing - 🔥 修改为流式响应
        if (!this.qwenClient) {
          return {
            success: false,
            error: "Qwen API key not configured. Please check your settings.",
          };
        }
        try {
          //
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const systemPrompt = (0, prompts_1.getSolutionPrompt)(answerLang);
          const stream = await this.qwenClient.chat.completions.create({
            model: config.solutionModel || DEFAULT_QWEN_MODEL,
            ...getQwenThinkingParams(
              config.solutionModel || DEFAULT_QWEN_MODEL,
            ),
            messages: ((modelName) => {
              const isDeepSeek =
                typeof modelName === "string" && /^deepseek-/i.test(modelName);
              if (isDeepSeek) {
                const merged = `${systemPrompt}\n\n${promptText}`;
                return [{ role: "user", content: merged }];
              }
              return [
                { role: "system", content: systemPrompt },
                { role: "user", content: promptText },
              ];
            })(config.solutionModel || DEFAULT_QWEN_MODEL),
            max_tokens: 8000,
            temperature: 0.4,
            stream: true, // 🔥 关键：启用流式模式
          });
          let fullResponse = "";
          let chunkCount = 0;
          // 📡 处理流式数据
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            const isLastChunk =
              chunk.choices[0]?.finish_reason === "stop" ||
              chunk.choices[0]?.finish_reason === "length";
            // 🔍 调试信息：记录结束原因
            if (isLastChunk) {
              const finishReason = chunk.choices[0]?.finish_reason;
              console.log(
                `🔚 Stream finished, reason: ${finishReason}, response length: ${fullResponse.length}`,
              );
              if (finishReason === "length") {
                console.warn(
                  "⚠️ Response truncated due to max_tokens limit! Consider increasing max_tokens.",
                );
              }
            }
            if (content) {
              fullResponse += content;
              chunkCount++;
              // 🚀 发送流式进度到前端（每个数据块都发送）
              const mainWindow = this.deps.getMainWindow();
              if (mainWindow) {
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                  {
                    content: content,
                    fullContent: fullResponse,
                    chunkIndex: chunkCount,
                    isComplete: false, // 在循环中始终为false
                    provider: "qwen",
                  },
                );
              }
              // 🛡️ 反检测延迟：每4个chunk暂停一下
              if (chunkCount % 4 === 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, Math.random() * 60 + 20),
                );
              }
              // 📊 发送进度更新（可选，不影响现有逻辑）
              if (mainWindow && chunkCount % 8 === 0) {
                mainWindow.webContents.send("processing-status", {
                  message: "AI正在生成解决方案...",
                  progress: Math.min(60 + chunkCount * 2, 95),
                });
              }
            }
            // 如果是最后一个chunk，提前退出循环
            if (isLastChunk) {
              break;
            }
          }
          // 🚀 流式结束后，发送最终完成信号
          const mainWindow = this.deps.getMainWindow();
          if (mainWindow) {
            // Try to parse structured fields from the final response
            const parseStructured = (raw) => {
              const clean = (raw || "").replace(/```json|```/g, "").trim();
              // direct
              try {
                return JSON.parse(clean);
              } catch {}
              // decode simple escapes then parse
              const decoded = clean
                .replace(/\\n/g, "\n")
                .replace(/\\t/g, "\t")
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, "\\");
              try {
                return JSON.parse(decoded);
              } catch {}
              // double-parse if payload itself is a JSON string
              try {
                const once = JSON.parse(clean);
                if (typeof once === "string") {
                  try {
                    return JSON.parse(once);
                  } catch {}
                }
              } catch {}
              try {
                const once = JSON.parse(decoded);
                if (typeof once === "string") {
                  try {
                    return JSON.parse(once);
                  } catch {}
                }
              } catch {}
              return null;
            };
            const canonicalize = (obj) => {
              if (!obj || typeof obj !== "object") return obj;
              const out = { ...obj };
              if (out.solution == null)
                out.solution = out.solution_code ?? out.code;
              const exp =
                out.explanation ??
                out.explantion ??
                out.analysis ??
                out.reasoning ??
                out.thoughts;
              if (exp != null) out.explanation = exp;
              if (out.time_complexity == null)
                out.time_complexity =
                  out.timeComplexity ??
                  out["time-complexity"] ??
                  (out.complexity &&
                    (out.complexity.time || out.complexity.Time));
              if (out.space_complexity == null)
                out.space_complexity =
                  out.spaceComplexity ??
                  out["space-complexity"] ??
                  (out.complexity &&
                    (out.complexity.space || out.complexity.Space));
              if (out.problem_statement == null)
                out.problem_statement =
                  out.problem ?? out.description ?? out.title;
              return out;
            };
            const parsed = parseStructured(fullResponse);
            const structured = parsed ? canonicalize(parsed) : null;
            try {
              electron_log_1.default.info("Qwen stream complete", {
                contentLength: (fullResponse || "").length,
                structuredKeys: structured ? Object.keys(structured) : [],
                hasProblem: !!(structured && structured.problem_statement),
                hasExplanation: !!(structured && structured.explanation),
                hasSolution: !!(
                  structured &&
                  (structured.solution ||
                    structured.code ||
                    structured.solution_code)
                ),
                hasTime: !!(structured && structured.time_complexity),
                hasSpace: !!(structured && structured.space_complexity),
              });
            } catch {}
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: fullResponse,
                chunkIndex: chunkCount + 1,
                isComplete: true, // 🔥 最终标记为完成
                provider: "qwen",
                structured,
              },
            );
          }
          // 使用完整响应作为最终结果
          responseContent = fullResponse;
          // 🔥 对于Qwen流式模式，我们已经通过SOLUTION_PROGRESS处理了所有逻辑
          // 返回特殊标志表示流式已完成，无需再发送SOLUTION_SUCCESS
          return {
            success: true,
            data: null,
            assistantText: fullResponse,
            isStreamingComplete: true, // 🔥 特殊标志
          };
        } catch (error) {
          console.error("Error using Qwen API for solution:", error);
          // Add specific handling for Qwen limitations
          if (error?.response?.status === 401) {
            return {
              success: false,
              error: "Invalid Qwen API key. Please check your settings.",
            };
          } else if (error?.response?.status === 429) {
            return {
              success: false,
              error: "Qwen API rate limit exceeded. Please try again later.",
            };
          }
          return {
            success: false,
            error:
              "Failed to generate solution with Qwen API. Please check your API key or try again later.",
          };
        }
      }
      // Extract parts from the response
      const codeMatch = responseContent.match(/```(?:\w+)?\s*([\s\S]*?)```/);
      const code = codeMatch ? codeMatch[1].trim() : responseContent;
      // Extract thoughts, looking for bullet points or numbered lists
      const thoughtsRegex =
        /(?:Thoughts:|Key Insights:|Reasoning:|Approach:)([\s\S]*?)(?:Time complexity:|$)/i;
      const thoughtsMatch = responseContent.match(thoughtsRegex);
      let thoughts = [];
      if (thoughtsMatch && thoughtsMatch[1]) {
        // Extract bullet points or numbered items
        const bulletPoints = thoughtsMatch[1].match(
          /(?:^|\n)\s*(?:[-*•]|\d+\.)\s*(.*)/g,
        );
        if (bulletPoints) {
          thoughts = bulletPoints
            .map((point) => point.replace(/^\s*(?:[-*•]|\d+\.)\s*/, "").trim())
            .filter(Boolean);
        } else {
          // If no bullet points found, split by newlines and filter empty lines
          thoughts = thoughtsMatch[1]
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        }
      }
      // Extract complexity information
      const timeComplexityPattern =
        /Time complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:Space complexity|$))/i;
      const spaceComplexityPattern =
        /Space complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:[A-Z]|$))/i;
      let timeComplexity =
        "O(n) - Linear time complexity because we only iterate through the array once. Each element is processed exactly one time, and the hashmap lookups are O(1) operations.";
      let spaceComplexity =
        "O(n) - Linear space complexity because we store elements in the hashmap. In the worst case, we might need to store all elements before finding the solution pair.";
      const timeMatch = responseContent.match(timeComplexityPattern);
      if (timeMatch && timeMatch[1]) {
        timeComplexity = timeMatch[1].trim();
        if (!timeComplexity.match(/O\([^)]+\)/i)) {
          timeComplexity = `O(n) - ${timeComplexity}`;
        } else if (
          !timeComplexity.includes("-") &&
          !timeComplexity.includes("because")
        ) {
          const notationMatch = timeComplexity.match(/O\([^)]+\)/i);
          if (notationMatch) {
            const notation = notationMatch[0];
            const rest = timeComplexity.replace(notation, "").trim();
            timeComplexity = `${notation} - ${rest}`;
          }
        }
      }
      const spaceMatch = responseContent.match(spaceComplexityPattern);
      if (spaceMatch && spaceMatch[1]) {
        spaceComplexity = spaceMatch[1].trim();
        if (!spaceComplexity.match(/O\([^)]+\)/i)) {
          spaceComplexity = `O(n) - ${spaceComplexity}`;
        } else if (
          !spaceComplexity.includes("-") &&
          !spaceComplexity.includes("because")
        ) {
          const notationMatch = spaceComplexity.match(/O\([^)]+\)/i);
          if (notationMatch) {
            const notation = notationMatch[0];
            const rest = spaceComplexity.replace(notation, "").trim();
            spaceComplexity = `${notation} - ${rest}`;
          }
        }
      }
      const formattedResponse = {
        code: code,
        thoughts:
          thoughts.length > 0
            ? thoughts
            : ["Solution approach based on efficiency and readability"],
        time_complexity: timeComplexity,
        space_complexity: spaceComplexity,
      };
      return { success: true, data: formattedResponse };
    } catch (error) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user.",
        };
      }
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings.",
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error:
            "OpenAI API rate limit exceeded or insufficient credits. Please try again later.",
        };
      }
      console.error("Solution generation error:", error);
      return {
        success: false,
        error: error.message || "Failed to generate solution",
      };
    }
  }
  async processExtraScreenshotsHelper(screenshots, signal) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = ConfigHelper_1.configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();
      if (!problemInfo) {
        // Fallback: provide a minimal default so debug flow won't abort.
        const fallback = { problem_statement: "帮我解决图中的报错" };
        try {
          this.deps.setProblemInfo(fallback);
        } catch {}
        try {
          console.warn(
            "[DEBUG] problemInfo missing; using fallback default problem_statement",
          );
        } catch {}
      }
      // Re-read (fallback may have been set)
      const effectiveProblemInfo = this.deps.getProblemInfo();
      if (!effectiveProblemInfo) {
        // Extremely defensive: if still null, keep previous behavior
        throw new Error("No problem info available");
      }
      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Processing debug screenshots...",
          progress: 30,
        });
      }
      // Prepare the images for the API call
      const imageDataList = screenshots.map((screenshot) => screenshot.data);
      // 🔍 Debug logs for provider/model and images involved in extra processing
      try {
        console.log(
          "[DEBUG][extra] provider/model:",
          config.apiProvider,
          config.debuggingModel,
        );
        console.log("[DEBUG][extra] images:", {
          count: screenshots.length,
          paths: screenshots.map((s) => s.path),
        });
        const sample = screenshots.slice(0, 4).map((s) => {
          let bytes = 0;
          try {
            bytes = Buffer.from(s.data || "", "base64").length;
          } catch {}
          return { path: s.path, base64Len: (s.data || "").length, bytes };
        });
        console.log("[DEBUG][extra] sample image sizes:", sample);
      } catch {}
      let debugContent;
      if (config.apiProvider === "openai") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const messages = [
          {
            role: "system",
            content:
              answerLang === "en"
                ? prompts_1.DEBUG_SYSTEM_PROMPT_EN
                : prompts_1.DEBUG_SYSTEM_PROMPT_ZH,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: (0, prompts_1.getDebugUserPrompt)(
                  effectiveProblemInfo.problem_statement,
                  language,
                  answerLang,
                ),
              },
              ...imageDataList.map((data) => ({
                type: "image_url",
                image_url: { url: `data:image/png;base64,${data}` },
              })),
            ],
          },
        ];
        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message:
              answerLang === "en"
                ? "Analyzing code and generating debug feedback..."
                : "正在分析代码并生成调试反馈...",
            progress: 60,
          });
        }
        // 🔒 Add error detail logging for the OpenAI debug call
        try {
          const debugResponse = await this.openaiClient.chat.completions.create(
            {
              model: config.debuggingModel || "gpt-5.4",
              messages: messages,
              ...this.getOfficialOpenAIChatLimit(8000),
            },
          );
          debugContent = debugResponse.choices[0].message.content;
        } catch (err) {
          try {
            console.error("[DEBUG][extra][openai] call failed", {
              status: err?.status,
              code: err?.code,
              type: err?.type,
              message: err?.message,
              response: err?.response?.data || err?.response?.body,
            });
          } catch {}
          throw err;
        }
      } else if (config.apiProvider === "gemini") {
        if (!this.geminiClient) {
          this.initializeAIClient();
          if (!this.geminiClient) {
            return {
              success: false,
              error:
                "Gemini client not configured. Please check your settings.",
            };
          }
        }
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const debugSystemPrompt =
            answerLang === "en"
              ? prompts_1.DEBUG_SYSTEM_PROMPT_EN
              : prompts_1.DEBUG_SYSTEM_PROMPT_ZH;
          const debugUserPrompt = (0, prompts_1.getDebugUserPrompt)(
            effectiveProblemInfo.problem_statement,
            language,
            answerLang,
          );
          const messages = [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${debugSystemPrompt}\n\n${debugUserPrompt}`,
                },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message:
                answerLang === "en"
                  ? "Analyzing code and generating debug feedback with Gemini..."
                  : "正在使用 Gemini 分析代码并生成调试反馈...",
              progress: 60,
            });
          }
          const response = await this.geminiClient.chat.completions.create({
            model: config.debuggingModel || "gemini-2.5-pro",
            messages,
            max_tokens: 8000,
            temperature: 0.2,
          });
          debugContent = response.choices[0].message.content || "";
        } catch (error) {
          console.error("Error using Gemini client for debugging:", error);
          return {
            success: false,
            error:
              "Failed to process debug request with Gemini client. Please check your settings.",
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error:
              "Anthropic API key not configured. Please check your settings.",
          };
        }
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const debugSystemPrompt =
            answerLang === "en"
              ? prompts_1.DEBUG_SYSTEM_PROMPT_EN
              : prompts_1.DEBUG_SYSTEM_PROMPT_ZH;
          const debugUserPrompt = (0, prompts_1.getDebugUserPrompt)(
            effectiveProblemInfo.problem_statement,
            language,
            answerLang,
          );
          const messages = [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${debugSystemPrompt}\n\n${debugUserPrompt}`,
                },
                ...imageDataList.map((data) => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: data,
                  },
                })),
              ],
            },
          ];
          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message:
                answerLang === "en"
                  ? "Analyzing code and generating debug feedback with Claude..."
                  : "正在使用 Claude 分析代码并生成调试反馈...",
              progress: 60,
            });
          }
          const response = await this.anthropicClient.messages.create(
            {
              model: config.debuggingModel || "claude-3-7-sonnet-20250219",
              max_tokens: 8000,
              messages: messages,
              temperature: 0.2,
            },
            { signal },
          );
          debugContent = response.content[0].text;
        } catch (error) {
          console.error("Error using Anthropic API for debugging:", error);
          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error:
                "Claude API rate limit exceeded. Please wait a few minutes before trying again.",
            };
          } else if (
            error.status === 413 ||
            (error.message && error.message.includes("token"))
          ) {
            return {
              success: false,
              error:
                "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs.",
            };
          }
          return {
            success: false,
            error:
              "Failed to process debug request with Anthropic API. Please check your API key or try again later.",
          };
        }
      } else if (config.apiProvider === "custom") {
        if (!this.customClient) {
          return {
            success: false,
            error:
              "Custom provider not configured. Please check your settings.",
          };
        }
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const systemPrompt =
            typeof config?.customPrompt === "string" &&
            config.customPrompt.trim().length > 0
              ? String(config.customPrompt)
              : answerLang === "en"
                ? prompts_1.DEBUG_SYSTEM_PROMPT_EN
                : prompts_1.DEBUG_SYSTEM_PROMPT_ZH;
          const debugUserPrompt = (0, prompts_1.getDebugUserPrompt)(
            effectiveProblemInfo.problem_statement,
            language,
            answerLang,
          );
          const messages = [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: debugUserPrompt },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "正在使用自定义模型分析调试反馈...",
              progress: 60,
            });
          }
          const modelId = config?.customModelId || "";
          if (!modelId) {
            return { success: false, error: "自定义模型ID未设置" };
          }
          const finalMessages = messages;
          const response = await this.customClient.chat.completions.create(
            {
              model: modelId,
              ...getQwenThinkingParams(modelId),
              messages: finalMessages,
              max_tokens: 8000,
              temperature: 0.2,
              stream: false,
            },
            { signal },
          );
          debugContent = response.choices?.[0]?.message?.content || "";
        } catch (error) {
          console.error("Error using Custom provider for debugging:", error);
          return {
            success: false,
            error:
              "Failed to process debug request with Custom provider. Please check your settings or try another model.",
          };
        }
      } else if (config.apiProvider === "custom2") {
        if (!this.custom2Client) {
          return {
            success: false,
            error:
              "Custom2 provider not configured. Please check your settings.",
          };
        }
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const systemPrompt =
            typeof config?.custom2Prompt === "string" &&
            config.custom2Prompt.trim().length > 0
              ? String(config.custom2Prompt)
              : answerLang === "en"
                ? prompts_1.DEBUG_SYSTEM_PROMPT_EN
                : prompts_1.DEBUG_SYSTEM_PROMPT_ZH;
          const debugUserPrompt = (0, prompts_1.getDebugUserPrompt)(
            effectiveProblemInfo.problem_statement,
            language,
            answerLang,
          );
          const messages = [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: debugUserPrompt },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "正在使用自定义模型2分析调试反馈...",
              progress: 60,
            });
          }
          const modelId = config?.custom2ModelId || "";
          if (!modelId) {
            return { success: false, error: "自定义2模型ID未设置" };
          }
          const finalMessages = messages;
          const response = await this.custom2Client.chat.completions.create(
            {
              model: modelId,
              messages: finalMessages,
              max_tokens: 8000,
              temperature: 0.2,
              stream: false,
            },
            { signal },
          );
          debugContent = response.choices?.[0]?.message?.content || "";
        } catch (error) {
          console.error("Error using Custom2 provider for debugging:", error);
          return {
            success: false,
            error:
              "Failed to process debug request with Custom2 provider. Please check your settings or try another model.",
          };
        }
      } else if (config.apiProvider === "qwen") {
        if (!this.qwenClient) {
          return {
            success: false,
            error: "Qwen API key not configured. Please check your settings.",
          };
        }
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const debugUserPrompt = (0, prompts_1.getDebugUserPrompt)(
            effectiveProblemInfo.problem_statement,
            language,
            answerLang,
          );
          const messages = [
            {
              role: "system",
              content:
                answerLang === "en"
                  ? prompts_1.DEBUG_SYSTEM_PROMPT_EN
                  : prompts_1.DEBUG_SYSTEM_PROMPT_ZH,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: debugUserPrompt,
                },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "正在使用通义千问分析代码并生成调试反馈...",
              progress: 60,
            });
          }
          // 🚀 Qwen流式调试API调用
          const stream = await this.qwenClient.chat.completions.create({
            model: config.debuggingModel || DEFAULT_QWEN_MODEL,
            ...getQwenThinkingParams(
              config.debuggingModel || DEFAULT_QWEN_MODEL,
            ),
            messages: messages,
            max_tokens: 8000, // 增加token限制，支持更详细的调试分析
            temperature: 0.4, // 提升创造性
            stream: true, // 🔥 启用流式模式
          });
          let fullResponse = "";
          let chunkCount = 0;
          // 📡 处理流式数据
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            if (content) {
              fullResponse += content;
              chunkCount++;
              // 🛡️ 反检测延迟
              if (chunkCount % 5 === 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, Math.random() * 70 + 25),
                );
              }
              // 📊 进度更新
              if (mainWindow && chunkCount % 10 === 0) {
                mainWindow.webContents.send("processing-status", {
                  message: "AI正在分析调试信息...",
                  progress: Math.min(60 + chunkCount * 3, 95),
                });
              }
            }
          }
          debugContent = fullResponse;
        } catch (error) {
          console.error("Error using Qwen API for debugging:", error);
          // Add specific handling for Qwen limitations
          if (error?.response?.status === 401) {
            return {
              success: false,
              error: "Invalid Qwen API key. Please check your settings.",
            };
          } else if (error?.response?.status === 429) {
            return {
              success: false,
              error: "Qwen API rate limit exceeded. Please try again later.",
            };
          }
          return {
            success: false,
            error:
              "Failed to process debug request with Qwen API. Please check your API key or try again later.",
          };
        }
      } else if (config.apiProvider === "openrouter") {
        if (!this.openrouterClient) {
          return {
            success: false,
            error:
              "OpenRouter API key not configured. Please check your settings.",
          };
        }
        try {
          const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
          const openrouterModel =
            config?.openrouterModel || "google/gemini-2.5-flash-lite";
          const debugUserPrompt = (0, prompts_1.getDebugUserPrompt)(
            effectiveProblemInfo.problem_statement,
            language,
            answerLang,
          );
          const messages = [
            {
              role: "system",
              content:
                answerLang === "en"
                  ? prompts_1.DEBUG_SYSTEM_PROMPT_EN
                  : prompts_1.DEBUG_SYSTEM_PROMPT_ZH,
            },
            {
              role: "user",
              content: [
                { type: "text", text: debugUserPrompt },
                ...imageDataList.map((data) => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${data}` },
                })),
              ],
            },
          ];
          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "正在使用 OpenRouter 分析调试反馈...",
              progress: 60,
            });
          }
          const response = await this.openrouterClient.chat.completions.create(
            {
              model: openrouterModel,
              messages,
              max_tokens: 8000,
              temperature: 0.2,
              stream: false,
            },
            { signal },
          );
          debugContent = response.choices?.[0]?.message?.content || "";
        } catch (error) {
          console.error("OpenRouter:", error);
          // 直接返回 OpenRouter 平台返回的原始错误信息
          const errorMessage =
            error?.error?.message ||
            error?.message ||
            "Failed to process debug request with OpenRouter. Please check your API key or try again later.";
          return {
            success: false,
            error: errorMessage,
          };
        }
      }
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "调试分析完成",
          progress: 100,
        });
      }
      let extractedCode = "// Debug mode - see analysis below";
      const codeMatch = debugContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        extractedCode = codeMatch[1].trim();
      }
      let formattedDebugContent = debugContent;
      if (!debugContent.includes("# ") && !debugContent.includes("## ")) {
        formattedDebugContent = debugContent
          .replace(
            /issues identified|problems found|bugs found/i,
            "## Issues Identified",
          )
          .replace(
            /code improvements|improvements|suggested changes/i,
            "## Code Improvements",
          )
          .replace(
            /optimizations|performance improvements/i,
            "## Optimizations",
          )
          .replace(/explanation|detailed analysis/i, "## Explanation");
      }
      const bulletPoints = formattedDebugContent.match(
        /(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g,
      );
      const thoughts = bulletPoints
        ? bulletPoints
            .map((point) =>
              point.replace(/^[ ]*(?:[-*•]|\d+\.)[ ]+/, "").trim(),
            )
            .slice(0, 5)
        : ["基于您的截图进行调试分析"];
      const response = {
        code: extractedCode,
        debug_analysis: formattedDebugContent,
        thoughts: thoughts,
        time_complexity: "N/A - Debug mode",
        space_complexity: "N/A - Debug mode",
      };
      return { success: true, data: response };
    } catch (error) {
      console.error("Debug processing error:", error);
      return {
        success: false,
        error: error.message || "Failed to process debug request",
      };
    }
  }
  // 🔤 新增：处理纯文本的Helper方法
  async processTextOnlyHelper(textInput, signal, sessionId = "", imageBatches) {
    try {
      const config = ConfigHelper_1.configHelper.loadConfig();
      const language =
        (await this.deps
          .getMainWindow()
          ?.webContents.executeJavaScript(
            "window.__LANGUAGE__ || 'javascript'",
          )) || "javascript";
      let response;
      if (config.apiProvider === "openai") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const systemPrompt = (0, prompts_1.getTextSolvePrompt)(answerLang);
        const userPrompt = (0, prompts_1.getTextUserPrompt)(
          textInput,
          answerLang,
        );
        // [DiveDeep 多轮记忆] - OpenAI: 构建携带历史记录的消息数组，并注入知识库资料
        const messages = ContextManager_1.contextManager.buildMessages(
          "openai",
          systemPrompt,
          userPrompt,
          "",
          { imageBatches },
        );
        const finalMessages = await this.buildMessagesWithKB(
          messages,
          textInput,
        );
        // Stream response with cumulative fallback
        const stream = await this.openaiClient.chat.completions.create({
          model: config.solutionModel || "gpt-5.4",
          messages: finalMessages,
          ...this.getOfficialOpenAIChatLimit(8000),
          stream: true,
        });
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const choice = chunk.choices?.[0] || {};
          let content = choice?.delta?.content || "";
          if (!content) {
            const cumulative = choice?.message?.content || "";
            if (
              typeof cumulative === "string" &&
              cumulative.length > full.length
            ) {
              content = cumulative.slice(full.length);
            }
          }
          const done =
            choice?.finish_reason === "stop" ||
            choice?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed()) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "openai",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        // Finalize with structured parse so Solution page can render code when applicable
        const parseStructured = (raw) => {
          const clean = (raw || "").replace(/```json|```/g, "").trim();
          try {
            return JSON.parse(clean);
          } catch {}
          const decoded = clean
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\\"/g, '"')
            .replace(/\\\\/g, "\\");
          try {
            return JSON.parse(decoded);
          } catch {}
          try {
            const once = JSON.parse(clean);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          try {
            const once = JSON.parse(decoded);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          return null;
        };
        const canonicalize = (obj) => {
          if (!obj || typeof obj !== "object") return obj;
          const out = { ...obj };
          if (out.solution == null)
            out.solution = out.solution_code ?? out.code;
          return out;
        };
        const parsed = parseStructured(full);
        const structured = parsed ? canonicalize(parsed) : null;
        if (
          full &&
          full.trim() &&
          this.shouldCommitTurn(signal, "text-openai-stream")
        ) {
          ContextManager_1.contextManager.commitTurn(
            (0, prompts_1.getTextUserPrompt)(textInput, answerLang),
            full,
          );
        }
        {
          const win = this.deps.getMainWindow?.();
          if (win && !win.isDestroyed() && !signal?.aborted) {
            win.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "openai",
                structured,
                sessionId,
              },
            );
          }
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "openrouter") {
        if (!this.openrouterClient) {
          return {
            success: false,
            error:
              "OpenRouter API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const openrouterModel =
          config?.openrouterModel || "google/gemini-2.5-flash-lite";
        const systemPrompt = (0, prompts_1.getTextSolvePrompt)(answerLang);
        const userPrompt = (0, prompts_1.getTextUserPrompt)(
          textInput,
          answerLang,
        );
        // [DiveDeep 多轮记忆] - OpenRouter: 构建携带历史记录的消息数组，仅在开启时注入知识库
        const messages = ContextManager_1.contextManager.buildMessages(
          "openrouter",
          systemPrompt,
          userPrompt,
          openrouterModel,
          { imageBatches },
        );
        const finalMessages = await this.buildMessagesWithKB(
          messages,
          textInput,
        );
        // [DEBUG] 打印发送给 OpenRouter 的完整消息数组，用于排查记忆是否正确传递
        try {
          console.log(
            `[DEBUG][OpenRouter] finalMessages count: ${finalMessages.length}`,
          );
          finalMessages.forEach((m, idx) => {
            const contentPreview = this.summarizeMessageContentForLog(
              m.content,
            );
            console.log(
              `[DEBUG][OpenRouter] msg[${idx}] role=${m.role} content=${contentPreview}...`,
            );
          });
        } catch {}
        const stream = await this.openrouterClient.chat.completions.create(
          {
            model: openrouterModel,
            messages: finalMessages,
            max_tokens: 8000,
            temperature: 0.2,
            stream: true,
          },
          { signal },
        );
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const content = chunk.choices?.[0]?.delta?.content || "";
          const done =
            chunk.choices?.[0]?.finish_reason === "stop" ||
            chunk.choices?.[0]?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed() && !signal?.aborted) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  isComplete: false,
                  provider: "openrouter",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        if (!signal?.aborted) {
          if (
            full &&
            full.trim() &&
            this.shouldCommitTurn(signal, "text-openrouter-stream")
          ) {
            // [DiveDeep 多轮记忆] - OpenRouter: 将当前问答存入滑动窗口
            ContextManager_1.contextManager.commitTurn(
              (0, prompts_1.getTextUserPrompt)(textInput, answerLang),
              full,
            );
          }
          const win = this.deps.getMainWindow?.();
          if (win && !win.isDestroyed()) {
            win.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "openrouter",
                sessionId,
              },
            );
          }
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "custom") {
        if (!this.customClient) {
          return {
            success: false,
            error:
              "Custom provider not configured. Please check your settings.",
          };
        }
        const systemPrompt =
          config?.customPrompt && String(config.customPrompt).trim().length > 0
            ? String(config.customPrompt)
            : prompts_1.CUSTOM_DEFAULT_PROMPT;
        const modelId = config?.customModelId || "";
        if (!modelId) {
          return { success: false, error: "自定义模型ID未设置" };
        }
        const messages = ContextManager_1.contextManager.buildMessages(
          "custom",
          systemPrompt,
          textInput,
          modelId,
          { imageBatches },
        );
        const finalMessages = await this.buildMessagesWithKB(
          messages,
          textInput,
        );
        console.log(`[KB] custom finalMessages count: ${finalMessages.length}`);
        const stream = await this.customClient.chat.completions.create({
          model: modelId,
          ...getQwenThinkingParams(modelId),
          messages: finalMessages,
          max_tokens: 8000,
          temperature: 0.2,
          stream: true,
        });
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const choice = chunk.choices?.[0] || {};
          const content = choice?.delta?.content || "";
          const done =
            choice?.finish_reason === "stop" ||
            choice?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed() && !signal?.aborted) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "custom",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        const parseStructured = (raw) => {
          const clean = (raw || "").replace(/```json|```/g, "").trim();
          try {
            return JSON.parse(clean);
          } catch {}
          const decoded = clean
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\\"/g, '"')
            .replace(/\\\\/g, "\\");
          try {
            return JSON.parse(decoded);
          } catch {}
          try {
            const once = JSON.parse(clean);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          try {
            const once = JSON.parse(decoded);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          return null;
        };
        const canonicalize = (obj) => {
          if (!obj || typeof obj !== "object") return obj;
          const out = { ...obj };
          if (out.solution == null)
            out.solution = out.solution_code ?? out.code;
          return out;
        };
        const parsed = parseStructured(full);
        const structured = parsed ? canonicalize(parsed) : null;
        if (
          full &&
          full.trim() &&
          this.shouldCommitTurn(signal, "text-custom-stream")
        ) {
          ContextManager_1.contextManager.commitTurn(textInput, full);
        }
        {
          const win = this.deps.getMainWindow?.();
          if (win && !win.isDestroyed() && !signal?.aborted) {
            win.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "custom",
                structured,
                sessionId,
              },
            );
          }
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "custom2") {
        if (!this.custom2Client) {
          return {
            success: false,
            error:
              "Custom2 provider not configured. Please check your settings.",
          };
        }
        const systemPrompt =
          config?.custom2Prompt &&
          String(config.custom2Prompt).trim().length > 0
            ? String(config.custom2Prompt)
            : prompts_1.CUSTOM_DEFAULT_PROMPT;
        const modelId = config?.custom2ModelId || "";
        if (!modelId) {
          return { success: false, error: "自定义2模型ID未设置" };
        }
        const messages = ContextManager_1.contextManager.buildMessages(
          "custom2",
          systemPrompt,
          textInput,
          modelId,
          { imageBatches },
        );
        const finalMessages = await this.buildMessagesWithKB(
          messages,
          textInput,
        );
        console.log(
          `[KB] custom2 finalMessages count: ${finalMessages.length}`,
        );
        const stream = await this.custom2Client.chat.completions.create({
          model: modelId,
          messages: finalMessages,
          max_tokens: 8000,
          temperature: 0.2,
          stream: true,
        });
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const choice = chunk.choices?.[0] || {};
          const content = choice?.delta?.content || "";
          const done =
            choice?.finish_reason === "stop" ||
            choice?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed() && !signal?.aborted) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "custom2",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        const parseStructured = (raw) => {
          const clean = (raw || "").replace(/```json|```/g, "").trim();
          try {
            return JSON.parse(clean);
          } catch {}
          const decoded = clean
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\\"/g, '"')
            .replace(/\\\\/g, "\\");
          try {
            return JSON.parse(decoded);
          } catch {}
          try {
            const once = JSON.parse(clean);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          try {
            const once = JSON.parse(decoded);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          return null;
        };
        const canonicalize = (obj) => {
          if (!obj || typeof obj !== "object") return obj;
          const out = { ...obj };
          if (out.solution == null)
            out.solution = out.solution_code ?? out.code;
          return out;
        };
        const parsed = parseStructured(full);
        const structured = parsed ? canonicalize(parsed) : null;
        if (
          full &&
          full.trim() &&
          this.shouldCommitTurn(signal, "text-custom2-stream")
        ) {
          ContextManager_1.contextManager.commitTurn(textInput, full);
        }
        {
          const win = this.deps.getMainWindow?.();
          if (win && !win.isDestroyed() && !signal?.aborted) {
            win.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "custom2",
                structured,
                sessionId,
              },
            );
          }
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "gemini") {
        if (!this.geminiClient) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const systemPrompt = (0, prompts_1.getTextSolvePrompt)(answerLang);
        const userPrompt = (0, prompts_1.getTextUserPrompt)(
          textInput,
          answerLang,
        );
        // [DiveDeep 多轮记忆] - Gemini: 构建携带历史记录的消息数组，并注入知识库资料
        const messages = ContextManager_1.contextManager.buildMessages(
          "gemini",
          systemPrompt,
          userPrompt,
          "",
          { imageBatches },
        );
        const finalMessages = await this.buildMessagesWithKB(
          messages,
          textInput,
        );
        // Stream response with cumulative fallback matching OpenAI block
        const stream = await this.geminiClient.chat.completions.create({
          model: config.solutionModel || "gemini-flash-latest",
          messages: finalMessages,
          max_tokens: 8000,
          temperature: 0.2,
          stream: true,
        });
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const choice = chunk.choices?.[0] || {};
          let content = choice?.delta?.content || "";
          if (!content) {
            const cumulative = choice?.message?.content || "";
            if (
              typeof cumulative === "string" &&
              cumulative.length > full.length
            ) {
              content = cumulative.slice(full.length);
            }
          }
          const done =
            choice?.finish_reason === "stop" ||
            choice?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed()) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "gemini",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        // Finalize with structured parse so Solution page can render code when applicable
        const parseStructured = (raw) => {
          const clean = (raw || "").replace(/```json|```/g, "").trim();
          try {
            return JSON.parse(clean);
          } catch {}
          const decoded = clean
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\\"/g, '"')
            .replace(/\\\\/g, "\\");
          try {
            return JSON.parse(decoded);
          } catch {}
          try {
            const once = JSON.parse(clean);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          try {
            const once = JSON.parse(decoded);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          return null;
        };
        const canonicalize = (obj) => {
          if (!obj || typeof obj !== "object") return obj;
          const out = { ...obj };
          if (out.solution == null)
            out.solution = out.solution_code ?? out.code;
          return out;
        };
        const parsed = parseStructured(full);
        const structured = parsed ? canonicalize(parsed) : null;
        if (
          full &&
          full.trim() &&
          this.shouldCommitTurn(signal, "text-gemini-stream")
        ) {
          ContextManager_1.contextManager.commitTurn(
            (0, prompts_1.getTextUserPrompt)(textInput, answerLang),
            full,
          );
        }
        {
          const win = this.deps.getMainWindow?.();
          if (win && !win.isDestroyed() && !signal?.aborted) {
            win.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "gemini",
                structured,
                sessionId,
              },
            );
          }
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error:
              "Anthropic API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const systemPrompt = (0, prompts_1.getTextSolvePrompt)(answerLang);
        const userPrompt = (0, prompts_1.getTextUserPrompt)(
          textInput,
          answerLang,
        );
        const messages = ContextManager_1.contextManager.buildMessages(
          "anthropic",
          systemPrompt,
          userPrompt,
          "",
          { imageBatches },
        );
        // [DiveDeep 多轮记忆] - Anthropic: 注入知识库资料
        const finalMessages = await this.buildMessagesWithKB(
          messages,
          textInput,
        );
        const anthropicResponse = await this.anthropicClient.messages.create(
          {
            model: config.solutionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 8000,
            messages: finalMessages,
            temperature: 0.2,
          },
          { signal },
        );
        const responseText = anthropicResponse.content[0].text;
        const jsonText = responseText.replace(/```json|```/g, "").trim();
        const result = JSON.parse(jsonText);
        if (
          responseText &&
          responseText.trim() &&
          this.shouldCommitTurn(signal, "text-anthropic")
        ) {
          ContextManager_1.contextManager.commitTurn(
            (0, prompts_1.getTextUserPrompt)(
              textInput,
              config?.answerLanguage === "en" ? "en" : "zh",
            ),
            responseText,
          );
        }
        // 🔧 转换数据结构以匹配前端期望
        const formattedResult = {
          code: result.solution_code || result.code || "",
          thoughts: this.formatThoughts(
            result.explanation || result.thoughts || "No explanation provided",
          ),
          time_complexity: result.time_complexity || "Not specified",
          space_complexity: result.space_complexity || "Not specified",
          problem_statement: result.problem_statement || "",
        };
        return { success: true, data: formattedResult };
      } else if (config.apiProvider === "qwen") {
        if (!this.qwenClient) {
          return {
            success: false,
            error: "Qwen API key not configured. Please check your settings.",
          };
        }
        // 使用统一的 prompt，支持语言切换，保留 DeepSeek 兼容（DeepSeek 不支持 system role）
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const systemPrompt = (0, prompts_1.getTextSolvePrompt)(answerLang);
        const userPrompt = (0, prompts_1.getTextUserPrompt)(
          textInput,
          answerLang,
        );
        const modelName = config.solutionModel || DEFAULT_QWEN_MODEL;
        // [DiveDeep 多轮记忆] - Qwen: 构建并注入知识库资料
        const messages = ContextManager_1.contextManager.buildMessages(
          "qwen",
          systemPrompt,
          userPrompt,
          modelName,
          { imageBatches },
        );
        const finalMessages = await this.buildMessagesWithKB(
          messages,
          textInput,
        );
        // 🚀 Qwen流式调用 - 文本处理
        const stream = await this.qwenClient.chat.completions.create({
          model: config.solutionModel || DEFAULT_QWEN_MODEL,
          ...getQwenThinkingParams(config.solutionModel || DEFAULT_QWEN_MODEL),
          messages: finalMessages,
          max_tokens: 8000, // 增加token限制，支持更详细的解释
          temperature: 0.4, // 提升创造性
          stream: true,
        });
        let fullResponse = "";
        let chunkCount = 0;
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          const isLastChunk =
            chunk.choices[0]?.finish_reason === "stop" ||
            chunk.choices[0]?.finish_reason === "length";
          if (content) {
            fullResponse += content;
            chunkCount++;
            // 🚀 发送流式进度到前端
            const mainWindow = this.deps.getMainWindow();
            if (mainWindow) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content: content,
                  fullContent: fullResponse,
                  chunkIndex: chunkCount,
                  isComplete: isLastChunk,
                  provider: "qwen",
                  sessionId,
                },
              );
            }
          }
          // 如果是最后一个chunk，提前退出循环
          if (isLastChunk) {
            break;
          }
        }
        // 🔥 返回流式完成标志
        if (
          fullResponse &&
          fullResponse.trim() &&
          this.shouldCommitTurn(signal, "text-qwen-stream")
        ) {
          ContextManager_1.contextManager.commitTurn(
            (0, prompts_1.getTextUserPrompt)(
              textInput,
              config?.answerLanguage === "en" ? "en" : "zh",
            ),
            fullResponse,
          );
        }
        return {
          success: true,
          data: null,
          assistantText: fullResponse,
          isStreamingComplete: true,
        };
      }
      return {
        success: false,
        error: "Unsupported API provider for text processing",
      };
    } catch (error) {
      console.error("Error in processTextOnlyHelper:", error);
      // 优先返回 OpenRouter 平台返回的原始错误信息
      const errorMessage =
        error?.error?.message ||
        error?.message ||
        "Failed to process text input";
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
  // 🔄 新增：处理截图+文本组合的Helper方法
  async processScreenshotsWithTextHelper(
    screenshots,
    textInput,
    signal,
    sessionId = "",
  ) {
    try {
      const config = ConfigHelper_1.configHelper.loadConfig();
      const language =
        (await this.deps
          .getMainWindow()
          ?.webContents.executeJavaScript(
            "window.__LANGUAGE__ || 'javascript'",
          )) || "javascript";
      console.log("[Screenshot+Text][Diag] helper start", {
        provider: config.apiProvider,
        sessionId,
        screenshotCount: screenshots.length,
        screenshots: screenshots
          .slice(0, 4)
          .map((s) => node_path_1.default.basename(s.path)),
        textLength: textInput.length,
        textPreview: this.summarizeTextForLog(textInput),
      });
      if (config.apiProvider === "openai") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const messages = [
          {
            role: "system",
            content: (0, prompts_1.getScreenshotSolvePrompt)(answerLang),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: (0, prompts_1.getScreenshotUserPrompt)(
                  language,
                  answerLang,
                  textInput,
                ),
              },
              ...screenshots.map((screenshot) => ({
                type: "image_url",
                image_url: { url: `data:image/png;base64,${screenshot.data}` },
              })),
            ],
          },
        ];
        // Stream response with cumulative fallback
        const stream = await this.openaiClient.chat.completions.create({
          model: config.solutionModel || "gpt-5.4",
          messages,
          ...this.getOfficialOpenAIChatLimit(8000),
          stream: true,
        });
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const choice = chunk.choices?.[0] || {};
          let content = choice?.delta?.content || "";
          if (!content) {
            const cumulative = choice?.message?.content || "";
            if (
              typeof cumulative === "string" &&
              cumulative.length > full.length
            ) {
              content = cumulative.slice(full.length);
            }
          }
          const done =
            choice?.finish_reason === "stop" ||
            choice?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed() && !signal?.aborted) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "openai",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        // Finalize with structured parse so Solution page can render code when applicable
        const parseStructured = (raw) => {
          const clean = (raw || "").replace(/```json|```/g, "").trim();
          try {
            return JSON.parse(clean);
          } catch {}
          const decoded = clean
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\\"/g, '"')
            .replace(/\\\\/g, "\\");
          try {
            return JSON.parse(decoded);
          } catch {}
          try {
            const once = JSON.parse(clean);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          try {
            const once = JSON.parse(decoded);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          return null;
        };
        const canonicalize = (obj) => {
          if (!obj || typeof obj !== "object") return obj;
          const out = { ...obj };
          if (out.solution == null)
            out.solution = out.solution_code ?? out.code;
          const exp =
            out.explanation ??
            out.explantion ??
            out.analysis ??
            out.reasoning ??
            out.thoughts;
          if (exp != null) out.explanation = exp;
          if (out.time_complexity == null)
            out.time_complexity =
              out.timeComplexity ??
              out["time-complexity"] ??
              (out.complexity && (out.complexity.time || out.complexity.Time));
          if (out.space_complexity == null)
            out.space_complexity =
              out.spaceComplexity ??
              out["space-complexity"] ??
              (out.complexity &&
                (out.complexity.space || out.complexity.Space));
          if (out.problem_statement == null)
            out.problem_statement = out.problem ?? out.description ?? out.title;
          return out;
        };
        const parsed = parseStructured(full);
        const structured = parsed ? canonicalize(parsed) : null;
        {
          const win = this.deps.getMainWindow?.();
          if (win && !win.isDestroyed() && !signal?.aborted) {
            win.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "openai",
                structured,
                sessionId,
              },
            );
          }
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "gemini") {
        if (!this.geminiClient) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const messages = [
          {
            role: "system",
            content: (0, prompts_1.getScreenshotSolvePrompt)(answerLang),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: (0, prompts_1.getScreenshotUserPrompt)(
                  language,
                  answerLang,
                  textInput,
                ),
              },
              ...screenshots.map((screenshot) => ({
                type: "image_url",
                image_url: { url: `data:image/png;base64,${screenshot.data}` },
              })),
            ],
          },
        ];
        // ⏱️ 故意延迟（防风控）
        // Gemini screenshot+text uses the direct request path, so this delay is disabled.
        // Restore the next line if this branch ever needs the same pre-request delay again.
        // await new Promise(resolve => setTimeout(resolve, AI_PRE_REQUEST_DELAY_MS))
        if (signal?.aborted) return { success: false, error: "Cancelled" };
        const stream = await this.geminiClient.chat.completions.create({
          model: config.solutionModel || "gemini-flash-latest",
          messages,
          max_tokens: 8000,
          temperature: 0.2,
          stream: true,
        });
        let full = "";
        let chunks = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const choice = chunk.choices?.[0] || {};
          let content = choice?.delta?.content || "";
          if (!content) {
            const cumulative = choice?.message?.content || "";
            if (
              typeof cumulative === "string" &&
              cumulative.length > full.length
            ) {
              content = cumulative.slice(full.length);
            }
          }
          const done =
            choice?.finish_reason === "stop" ||
            choice?.finish_reason === "length";
          if (content) {
            full += content;
            chunks++;
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed() && !signal?.aborted) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: full,
                  chunkIndex: chunks,
                  provider: "gemini",
                  sessionId,
                },
              );
            }
          }
          if (done) break;
        }
        const parseStructured = (raw) => {
          const clean = (raw || "").replace(/```json|```/g, "").trim();
          try {
            return JSON.parse(clean);
          } catch {}
          const decoded = clean
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\\"/g, '"')
            .replace(/\\\\/g, "\\");
          try {
            return JSON.parse(decoded);
          } catch {}
          try {
            const once = JSON.parse(clean);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          try {
            const once = JSON.parse(decoded);
            if (typeof once === "string") {
              try {
                return JSON.parse(once);
              } catch {}
            }
          } catch {}
          return null;
        };
        const canonicalize = (obj) => {
          if (!obj || typeof obj !== "object") return obj;
          const out = { ...obj };
          if (out.solution == null)
            out.solution = out.solution_code ?? out.code;
          const exp =
            out.explanation ??
            out.explantion ??
            out.analysis ??
            out.reasoning ??
            out.thoughts;
          if (exp != null) out.explanation = exp;
          if (out.time_complexity == null)
            out.time_complexity =
              out.timeComplexity ??
              out["time-complexity"] ??
              (out.complexity && (out.complexity.time || out.complexity.Time));
          if (out.space_complexity == null)
            out.space_complexity =
              out.spaceComplexity ??
              out["space-complexity"] ??
              (out.complexity &&
                (out.complexity.space || out.complexity.Space));
          if (out.problem_statement == null)
            out.problem_statement = out.problem ?? out.description ?? out.title;
          return out;
        };
        const parsed = parseStructured(full);
        const structured = parsed ? canonicalize(parsed) : null;
        {
          const win = this.deps.getMainWindow?.();
          if (win && !win.isDestroyed() && !signal?.aborted) {
            win.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: full,
                chunkIndex: chunks + 1,
                isComplete: true,
                provider: "gemini",
                structured,
                sessionId,
              },
            );
          }
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error:
              "Anthropic API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const systemPrompt = (0, prompts_1.getScreenshotSolvePrompt)(
          answerLang,
        );
        const userPrompt = (0, prompts_1.getScreenshotUserPrompt)(
          language,
          answerLang,
          textInput,
        );
        const messages = [
          {
            role: "user",
            content: [
              { type: "text", text: `${systemPrompt}\n\n${userPrompt}` },
              ...screenshots.map((screenshot) => ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: screenshot.data,
                },
              })),
            ],
          },
        ];
        const stream = await this.anthropicClient.messages.stream({
          model: config.solutionModel || "claude-3-7-sonnet-20250219",
          max_tokens: 8000,
          messages: messages,
          temperature: 0.2,
        });
        let full = "";
        let chunks = 0;
        for await (const event of stream) {
          if (signal?.aborted) break;
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            full += event.delta.text;
            chunks++;
            const win = this.deps.getMainWindow();
            if (win && !win.isDestroyed() && !signal?.aborted) {
              win.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content: event.delta.text,
                  fullContent: full,
                  chunkIndex: chunks,
                  isComplete: false,
                  provider: "anthropic",
                  sessionId,
                },
              );
            }
          }
        }
        const win = this.deps.getMainWindow();
        if (win && !win.isDestroyed() && !signal?.aborted) {
          win.webContents.send(this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS, {
            content: "",
            fullContent: full,
            chunkIndex: chunks + 1,
            isComplete: true,
            provider: "anthropic",
            sessionId,
          });
        }
        return {
          success: true,
          data: null,
          assistantText: full,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "openrouter") {
        if (!this.openrouterClient) {
          return {
            success: false,
            error:
              "OpenRouter API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const openrouterModel =
          config?.openrouterModel || "google/gemini-2.5-flash-lite";
        const messages = [
          {
            role: "system",
            content: (0, prompts_1.getSolutionPrompt)(answerLang),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: (0, prompts_1.getScreenshotUserPrompt)(
                  language,
                  answerLang,
                  textInput,
                ),
              },
              ...screenshots.map((screenshot) => ({
                type: "image_url",
                image_url: { url: `data:image/png;base64,${screenshot.data}` },
              })),
            ],
          },
        ];
        const stream = await this.openrouterClient.chat.completions.create(
          {
            model: openrouterModel,
            messages,
            max_tokens: 8000,
            temperature: 0.2,
            stream: true,
          },
          { signal },
        );
        let fullResponse = "";
        let chunkCount = 0;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          const content = chunk.choices?.[0]?.delta?.content || "";
          if (content) {
            fullResponse += content;
            chunkCount++;
            const mainWindow = this.deps.getMainWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: fullResponse,
                  chunkIndex: chunkCount,
                  isComplete: false,
                  provider: "openrouter",
                  sessionId,
                },
              );
            }
          }
        }
        if (!signal?.aborted) {
          const mainWindow = this.deps.getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
              {
                content: "",
                fullContent: fullResponse,
                chunkIndex: chunkCount + 1,
                isComplete: true,
                provider: "openrouter",
                sessionId,
              },
            );
          }
        }
        return {
          success: true,
          data: null,
          assistantText: fullResponse,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "custom") {
        if (!this.customClient) {
          return {
            success: false,
            error:
              "Custom provider not configured. Please check your settings.",
          };
        }
        const systemPrompt =
          config?.customPrompt && String(config.customPrompt).trim().length > 0
            ? String(config.customPrompt)
            : prompts_1.CUSTOM_DEFAULT_PROMPT;
        const contents = [];
        if (textInput && textInput.trim().length > 0) {
          contents.push({ type: "text", text: textInput });
        }
        for (const screenshot of screenshots) {
          contents.push({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${screenshot.data}` },
          });
        }
        if (contents.length === 0)
          contents.push({ type: "text", text: "请直接回答：" });
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: contents },
        ];
        const modelId = config?.customModelId || "";
        if (!modelId) {
          return { success: false, error: "自定义模型ID未设置" };
        }
        const finalMessages = messages;
        const stream = await this.customClient.chat.completions.create(
          {
            model: modelId,
            ...getQwenThinkingParams(modelId),
            messages: finalMessages,
            max_tokens: 8000,
            temperature: 0.2,
            stream: true,
          },
          { signal },
        );
        let fullResponse = "";
        let chunkCount = 0;
        for await (const chunk of stream) {
          const content = chunk?.choices?.[0]?.delta?.content || "";
          const isLastChunk =
            chunk?.choices?.[0]?.finish_reason === "stop" ||
            chunk?.choices?.[0]?.finish_reason === "length";
          if (content) {
            fullResponse += content;
            chunkCount++;
            const mainWindow = this.deps.getMainWindow();
            if (mainWindow) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: fullResponse,
                  chunkIndex: chunkCount,
                  isComplete: false,
                  provider: "custom",
                  sessionId,
                },
              );
            }
          }
          if (isLastChunk) break;
        }
        const mainWindow = this.deps.getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
            {
              content: "",
              fullContent: fullResponse,
              chunkIndex: chunkCount + 1,
              isComplete: true,
              provider: "custom",
              sessionId,
            },
          );
        }
        return {
          success: true,
          data: null,
          assistantText: fullResponse,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "qwen") {
        if (!this.qwenClient) {
          return {
            success: false,
            error: "Qwen API key not configured. Please check your settings.",
          };
        }
        const answerLang = config?.answerLanguage === "en" ? "en" : "zh";
        const messages = [
          {
            role: "system",
            content: (0, prompts_1.getSolutionPrompt)(answerLang),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: (0, prompts_1.getScreenshotUserPrompt)(
                  language,
                  answerLang,
                  textInput,
                ),
              },
              ...screenshots.map((screenshot) => ({
                type: "image_url",
                image_url: { url: `data:image/png;base64,${screenshot.data}` },
              })),
            ],
          },
        ];
        // 截图输入优先走共享/视觉模型配置，不再依赖模型名里是否包含 "vl"
        const qwenVisionModel = this.getPreferredQwenVisionModel(config);
        const stream = await this.qwenClient.chat.completions.create(
          {
            model: qwenVisionModel,
            ...getQwenThinkingParams(qwenVisionModel),
            messages,
            max_tokens: 8000,
            temperature: 0.4,
            stream: true,
          },
          { signal },
        );
        let fullResponse = "";
        let chunkCount = 0;
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          const isLastChunk =
            chunk.choices[0]?.finish_reason === "stop" ||
            chunk.choices[0]?.finish_reason === "length";
          if (content) {
            fullResponse += content;
            chunkCount++;
            const mainWindow = this.deps.getMainWindow();
            if (mainWindow) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: fullResponse,
                  chunkIndex: chunkCount,
                  isComplete: false,
                  provider: "qwen",
                  sessionId,
                },
              );
            }
          }
          if (isLastChunk) break;
        }
        // ✅ 结束：宽松解析 + 结构化 + 完成事件
        const mainWindow = this.deps.getMainWindow();
        if (mainWindow) {
          const parseStructured = (raw) => {
            const clean = (raw || "").replace(/```json|```/g, "").trim();
            // direct
            try {
              return JSON.parse(clean);
            } catch {}
            // decode simple escapes then parse
            const decoded = clean
              .replace(/\\n/g, "\n")
              .replace(/\\t/g, "\t")
              .replace(/\\\"/g, '"')
              .replace(/\\\\/g, "\\");
            try {
              return JSON.parse(decoded);
            } catch {}
            // double-parse if payload itself is a JSON string
            try {
              const once = JSON.parse(clean);
              if (typeof once === "string") {
                try {
                  return JSON.parse(once);
                } catch {}
              }
            } catch {}
            try {
              const once = JSON.parse(decoded);
              if (typeof once === "string") {
                try {
                  return JSON.parse(once);
                } catch {}
              }
            } catch {}
            return null;
          };
          const canonicalize = (obj) => {
            if (!obj || typeof obj !== "object") return obj;
            const out = { ...obj };
            if (out.solution == null)
              out.solution = out.solution_code ?? out.code;
            const exp =
              out.explanation ??
              out.explantion ??
              out.analysis ??
              out.reasoning ??
              out.thoughts;
            if (exp != null) out.explanation = exp;
            if (out.time_complexity == null)
              out.time_complexity =
                out.timeComplexity ??
                out["time-complexity"] ??
                (out.complexity &&
                  (out.complexity.time || out.complexity.Time));
            if (out.space_complexity == null)
              out.space_complexity =
                out.spaceComplexity ??
                out["space-complexity"] ??
                (out.complexity &&
                  (out.complexity.space || out.complexity.Space));
            if (out.problem_statement == null)
              out.problem_statement =
                out.problem ?? out.description ?? out.title;
            return out;
          };
          const parsed = parseStructured(fullResponse);
          const structured = parsed ? canonicalize(parsed) : null;
          try {
            electron_log_1.default.info("Qwen stream (combined) complete", {
              contentLength: (fullResponse || "").length,
              structuredKeys: structured ? Object.keys(structured) : [],
              hasProblem: !!(structured && structured.problem_statement),
              hasExplanation: !!(structured && structured.explanation),
              hasSolution: !!(
                structured &&
                (structured.solution ||
                  structured.code ||
                  structured.solution_code)
              ),
              hasTime: !!(structured && structured.time_complexity),
              hasSpace: !!(structured && structured.space_complexity),
            });
          } catch {}
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
            {
              content: "",
              fullContent: fullResponse,
              chunkIndex: chunkCount + 1,
              isComplete: true,
              provider: "qwen",
              structured,
              sessionId,
            },
          );
        }
        // 🔥 返回流式完成标志，避免再触发 SOLUTION_SUCCESS
        return {
          success: true,
          data: null,
          assistantText: fullResponse,
          isStreamingComplete: true,
        };
      } else if (config.apiProvider === "custom2") {
        if (!this.custom2Client) {
          return {
            success: false,
            error:
              "Custom2 provider not configured. Please check your settings.",
          };
        }
        const systemPrompt =
          config?.custom2Prompt &&
          String(config.custom2Prompt).trim().length > 0
            ? String(config.custom2Prompt)
            : prompts_1.CUSTOM_DEFAULT_PROMPT;
        const contents = [];
        if (textInput && textInput.trim().length > 0) {
          contents.push({ type: "text", text: textInput });
        }
        for (const screenshot of screenshots) {
          contents.push({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${screenshot.data}` },
          });
        }
        if (contents.length === 0)
          contents.push({ type: "text", text: "请直接回答：" });
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: contents },
        ];
        const modelId = config?.custom2ModelId || "";
        if (!modelId) {
          return { success: false, error: "自定义2模型ID未设置" };
        }
        const finalMessages = messages;
        const stream = await this.custom2Client.chat.completions.create(
          {
            model: modelId,
            messages: finalMessages,
            max_tokens: 8000,
            temperature: 0.2,
            stream: true,
          },
          { signal },
        );
        let fullResponse = "";
        let chunkCount = 0;
        for await (const chunk of stream) {
          const content = chunk?.choices?.[0]?.delta?.content || "";
          const isLastChunk =
            chunk?.choices?.[0]?.finish_reason === "stop" ||
            chunk?.choices?.[0]?.finish_reason === "length";
          if (content) {
            fullResponse += content;
            chunkCount++;
            const mainWindow = this.deps.getMainWindow();
            if (mainWindow) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
                {
                  content,
                  fullContent: fullResponse,
                  chunkIndex: chunkCount,
                  isComplete: false,
                  provider: "custom2",
                  sessionId,
                },
              );
            }
          }
          if (isLastChunk) break;
        }
        const mainWindow = this.deps.getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_PROGRESS,
            {
              content: "",
              fullContent: fullResponse,
              chunkIndex: chunkCount + 1,
              isComplete: true,
              provider: "custom2",
              sessionId,
            },
          );
        }
        return {
          success: true,
          data: null,
          assistantText: fullResponse,
          isStreamingComplete: true,
        };
      }
      return {
        success: false,
        error: "Unsupported API provider for combined processing",
      };
    } catch (error) {
      console.error("Error in processScreenshotsWithTextHelper:", error);
      // 优先返回 OpenRouter 平台返回的原始错误信息
      const errorMessage =
        error?.error?.message ||
        error?.message ||
        "Failed to process combined input";
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
  formatThoughts(thoughts) {
    if (!thoughts) {
      return ["No explanation provided"];
    }
    // If it's a single long paragraph, split by sentences or logical breaks
    if (!thoughts.includes("\n")) {
      // Split by sentence endings, but keep reasonable length
      const sentences = thoughts
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (sentences.length > 1) {
        return sentences
          .slice(0, 5)
          .map((s) =>
            s.endsWith(".") || s.endsWith("!") || s.endsWith("?") ? s : s + ".",
          );
      } else {
        // If it's one very long sentence, break it into chunks
        const words = thoughts.split(" ");
        const chunks = [];
        let currentChunk = "";
        for (const word of words) {
          if (currentChunk.length + word.length + 1 > 150) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = word;
          } else {
            currentChunk += (currentChunk ? " " : "") + word;
          }
        }
        if (currentChunk) chunks.push(currentChunk.trim());
        return chunks.length > 0 ? chunks : [thoughts];
      }
    }
    // Split by newlines and clean up
    const lines = thoughts
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines : [thoughts];
  }
  cancelOngoingRequests(preserveProblemInfo = false) {
    let wasCancelled = false;
    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort();
      this.currentProcessingAbortController = null;
      wasCancelled = true;
    }
    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort();
      this.currentExtraProcessingAbortController = null;
      wasCancelled = true;
    }
    if (!preserveProblemInfo) {
      this.deps.setHasDebugged(false);
      this.deps.setProblemInfo(null);
    }
    // const mainWindow = this.deps.getMainWindow()
    // if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
    //   mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
    // }
  }
  extractUserTextForKB(messages) {
    if (!Array.isArray(messages)) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "user") continue;
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        const p = m.content.find(
          (x) => x && x.type === "text" && typeof x.text === "string",
        );
        if (p && typeof p.text === "string") return p.text;
      }
    }
    return "";
  }
  async buildMessagesWithKB(messages, queryText) {
    try {
      const cfg = ConfigHelper_1.configHelper.loadConfig();
      if (!cfg || !cfg.enableKB) return messages;
      const question =
        String(queryText || "").trim() || this.extractUserTextForKB(messages);
      if (!question || !this.kb) return messages;
      const topK = Math.max(1, Number(cfg.kbTopK ?? 3));
      const hits = await this.kb.searchTopWithScores(question, topK);
      if (!hits || hits.length === 0) return messages;
      const minScore = Number(cfg.kbScoreThreshold ?? 0.05);
      const filteredHits = hits.filter((hit) => (hit?.score ?? 0) >= minScore);
      if (filteredHits.length === 0) {
        try {
          console.log(
            `[KB] skip: all hits below threshold minScore=${minScore}`,
          );
        } catch {}
        return messages;
      }
      try {
        filteredHits.forEach((hit, idx) => {
          const score = typeof hit.score === "number" ? hit.score : NaN;
          console.log(
            `[KB] hit#${idx + 1}: score=${score.toFixed(4)} len=${hit.text?.length ?? 0}`,
          );
        });
      } catch {}
      const maxChars = Math.max(120, Number(cfg.kbMaxChunkChars ?? 500));
      const kbBlock = filteredHits
        .map((hit, i) => `[S${i + 1}] ${String(hit.text).slice(0, maxChars)}`)
        .join("\n\n");
      const refText = `参考资料（可选）：仅在与问题相关时酌情参考；若和问题本身无关，绝对不要参考。\n${kbBlock}`;
      // Inject into the first user message (text segment). Do not modify existing system prompts
      const cloned = Array.isArray(messages) ? [...messages] : messages;
      // FIX: Use findLastIndex for multi-turn history. We want KB appended to the latest question.
      // @ts-ignore
      const userIdx =
        typeof cloned.findLastIndex === "function"
          ? cloned.findLastIndex((m) => m && m.role === "user")
          : (() => {
              for (let i = cloned.length - 1; i >= 0; i--) {
                if (cloned[i] && cloned[i].role === "user") return i;
              }
              return -1;
            })();
      if (userIdx >= 0) {
        const u = cloned[userIdx];
        if (typeof u.content === "string") {
          cloned[userIdx] = { ...u, content: `${u.content}\n\n${refText}` };
        } else if (Array.isArray(u.content)) {
          const firstImageIndex = u.content.findIndex(
            (block) => block?.type === "image" || block?.type === "image_url",
          );
          const insertAt =
            firstImageIndex >= 0 ? firstImageIndex : u.content.length;
          cloned[userIdx] = {
            ...u,
            content: [
              ...u.content.slice(0, insertAt),
              { type: "text", text: refText },
              ...u.content.slice(insertAt),
            ],
          };
        } else {
          cloned[userIdx] = {
            ...u,
            content: [{ type: "text", text: refText }],
          };
        }
      } else {
        // Fallback: no user message found, append one
        cloned.push({
          role: "user",
          content: [{ type: "text", text: refText }],
        });
      }
      try {
        const preview = refText.replace(/\n/g, " ").slice(0, 160);
        console.log(
          `[KB] inject(user): hits=${hits.length}, kbChars=${kbBlock.length}, preview="${preview}"`,
        );
      } catch {}
      return cloned;
    } catch (e) {
      console.warn("buildMessagesWithKB failed:", e);
      return messages;
    }
  }
  async kbRebuild() {
    try {
      if (!this.kb) this.kb = new LocalVectorDB_1.LocalVectorDB();
      if (this.kb.forceRebuild) {
        await this.kb.forceRebuild();
      } else {
        await this.kb.buildOrLoadIndex();
      }
    } catch (e) {
      console.warn("KB rebuild via IPC failed:", e);
    }
  }
  kbGetStats() {
    try {
      return this.kb?.getStats() || { chunks: 0, lastBuiltAt: 0 };
    } catch {
      return { chunks: 0, lastBuiltAt: 0 };
    }
  }
}
exports.ProcessingHelper = ProcessingHelper;
