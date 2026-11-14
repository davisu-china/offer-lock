"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.configHelper = exports.ConfigHelper = void 0;
// ConfigHelper.ts
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const events_1 = require("events");
const openai_1 = require("openai");
// 默认语音触发关键词（与 src/utils/voiceKeywords.ts 保持同步）
const DEFAULT_KEYWORDS = [
  "我想想",
  "我想下",
  "我理解",
  "我得想下",
  "我得想想",
  "我得回忆下",
  "让我想想",
  "好的",
  "好的面试官",
  "知道的",
  "这我知道",
  "let me think",
  "let me considerate",
  "copy that",
  "give me some times",
  "give me some time",
];
// 默认截图触发关键词
const DEFAULT_SCREENSHOT_KEYWORDS = ["我看一下", "let me see", "let me check"];
const DEFAULT_QWEN_MODEL = "qwen3.8-flash";
class ConfigHelper extends events_1.EventEmitter {
  constructor() {
    super();
    this.defaultConfig = {
      apiKey: "",
      apiProvider: "qwen", // Default to Qwen
      extractionModel: DEFAULT_QWEN_MODEL, // Default Qwen model for multimodal extraction
      solutionModel: DEFAULT_QWEN_MODEL, // Default Qwen model for solution generation
      debuggingModel: DEFAULT_QWEN_MODEL, // Default Qwen model for debugging
      language: "python",
      opacity: 1.0,
      screenshotMode: "full",
      xingceMode: false,
      customApiKey: "",
      customBaseUrl: "",
      customModelId: "",
      customPrompt: "",
      custom2ApiKey: "",
      custom2BaseUrl: "",
      custom2ModelId: "",
      custom2Prompt: "",
      enableKB: false,
      kbTopK: 3,
      kbMaxChunkChars: 500,
      // 语音识别配置
      voiceAsrProvider: "ali",
      voiceInputMode: "both",
      aliAsrApiKey: "",
      doubaoAppId: "",
      doubaoToken: "",
      doubaoClusterId: "volc.seedasr.sauc.duration",
      deepgramApiKey: "",
      deepgramLanguage: "en-US",
      // OpenAI 语音识别配置
      openaiAsrApiKey: "",
      openaiAsrBaseUrl: "https://api.openai.com/v1",
      // Gummy 实时翻译配置
      gummyApiKey: "",
      gummySourceLang: "auto",
      gummyTargetLang: "zh",
      liveTranslateApiKey: "",
      liveTranslateSourceLang: "auto",
      liveTranslateTargetLang: "zh",
      // Legacy
      voiceProvider: "paraformer",
      paraformerApiKey: "",
      // Voice trigger keywords
      voiceTriggerKeywords: DEFAULT_KEYWORDS,
      // Screenshot trigger keywords
      voiceScreenshotKeywords: DEFAULT_SCREENSHOT_KEYWORDS,
      // UI 语言
      uiLanguage: "zh",
    };
    // Use the app's user data directory to store the config
    try {
      this.configPath = node_path_1.default.join(
        electron_1.app.getPath("userData"),
        "config.json",
      );
      console.log("Config path:", this.configPath);
    } catch (err) {
      console.warn("Could not access user data path, using fallback");
      this.configPath = node_path_1.default.join(process.cwd(), "config.json");
    }
    // Ensure the initial config file exists
    this.ensureConfigExists();
  }
  /**
   * Ensure config file exists
   */
  ensureConfigExists() {
    try {
      if (!node_fs_1.default.existsSync(this.configPath)) {
        this.saveConfig(this.defaultConfig);
      }
    } catch (err) {
      console.error("Error ensuring config exists:", err);
    }
  }
  /**
   * Validate and sanitize model selection to ensure only allowed models are used
   */
  sanitizeModelSelection(model, provider) {
    // 【修复】：允许用户自由输入任何有效模型名称，解除过时的硬编码白名单限制，防止模型被重置
    // 如果用户输入为空，则提供默认的安全兜底值
    if (!model || model.trim() === "") {
      if (provider === "openai") return "gpt-5.4";
      if (provider === "gemini") return "gemini-flash-latest";
      if (provider === "anthropic") return "claude-3-7-sonnet-20250219";
      if (provider === "qwen") return DEFAULT_QWEN_MODEL;
    }
    // 不再检查 allowedModels 数组，完全信任用户的输入
    return model.trim();
  }
  loadConfig() {
    try {
      if (node_fs_1.default.existsSync(this.configPath)) {
        const configData = node_fs_1.default.readFileSync(
          this.configPath,
          "utf8",
        );
        const config = JSON.parse(configData);
        // Ensure apiProvider is a valid value
        if (
          config.apiProvider !== "openai" &&
          config.apiProvider !== "gemini" &&
          config.apiProvider !== "anthropic" &&
          config.apiProvider !== "qwen" &&
          config.apiProvider !== "openrouter" &&
          config.apiProvider !== "custom" &&
          config.apiProvider !== "custom2"
        ) {
          config.apiProvider = "qwen"; // Default to Qwen if invalid
        }
        // Sanitize model selections to ensure only allowed models are used
        if (config.extractionModel) {
          config.extractionModel = this.sanitizeModelSelection(
            config.extractionModel,
            config.apiProvider,
          );
        }
        if (config.solutionModel) {
          config.solutionModel = this.sanitizeModelSelection(
            config.solutionModel,
            config.apiProvider,
          );
        }
        if (config.debuggingModel) {
          config.debuggingModel = this.sanitizeModelSelection(
            config.debuggingModel,
            config.apiProvider,
          );
        }
        return {
          ...this.defaultConfig,
          ...config,
        };
      }
      // If no config exists, create a default one
      this.saveConfig(this.defaultConfig);
      return this.defaultConfig;
    } catch (err) {
      console.error("Error loading config:", err);
      return this.defaultConfig;
    }
  }
  /**
   * Save configuration to disk
   */
  getConfigPath() {
    return this.configPath;
  }
  saveConfig(config) {
    try {
      // Ensure the directory exists
      const configDir = node_path_1.default.dirname(this.configPath);
      if (!node_fs_1.default.existsSync(configDir)) {
        node_fs_1.default.mkdirSync(configDir, { recursive: true });
      }
      // Write the config file
      node_fs_1.default.writeFileSync(
        this.configPath,
        JSON.stringify(config, null, 2),
      );
      // Backup listeners must never change the result of a successful local save.
      for (const listener of this.listeners("config-saved")) {
        try {
          listener();
        } catch {
          /* isolated optional background work */
        }
      }
    } catch (err) {
      console.error("Error saving config:", err);
    }
  }
  /**
   * Update specific configuration values
   */
  updateConfig(updates) {
    try {
      const currentConfig = this.loadConfig();
      let provider = updates.apiProvider || currentConfig.apiProvider;
      // Auto-detect provider based on API key format if a new key is provided
      if (updates.apiKey && !updates.apiProvider) {
        // If API key starts with "sk-", it's likely an OpenAI key
        if (updates.apiKey.trim().startsWith("sk-")) {
          provider = "openai";
          console.log("Auto-detected OpenAI API key format");
        } else if (updates.apiKey.trim().startsWith("sk-ant-")) {
          provider = "anthropic";
          console.log("Auto-detected Anthropic API key format");
        } else if (
          updates.apiKey.trim().startsWith("DASHSCOPE_API_KEY") ||
          updates.apiKey.includes("dashscope")
        ) {
          provider = "qwen";
          console.log("Auto-detected Qwen API key format");
        } else {
          provider = "gemini";
          console.log("Using Gemini API key format (default)");
        }
        // Update the provider in the updates object
        updates.apiProvider = provider;
      }
      // If provider is changing, set defaults ONLY for fields not explicitly provided
      if (
        updates.apiProvider &&
        updates.apiProvider !== currentConfig.apiProvider
      ) {
        if (updates.apiProvider === "openai") {
          if (updates.extractionModel === undefined)
            updates.extractionModel = "gpt-5.4";
          if (updates.solutionModel === undefined)
            updates.solutionModel = "gpt-5.4";
          if (updates.debuggingModel === undefined)
            updates.debuggingModel = "gpt-5.4";
        } else if (updates.apiProvider === "anthropic") {
          if (updates.extractionModel === undefined)
            updates.extractionModel = "claude-3-7-sonnet-20250219";
          if (updates.solutionModel === undefined)
            updates.solutionModel = "claude-3-7-sonnet-20250219";
          if (updates.debuggingModel === undefined)
            updates.debuggingModel = "claude-3-7-sonnet-20250219";
        } else if (updates.apiProvider === "qwen") {
          if (updates.extractionModel === undefined)
            updates.extractionModel = DEFAULT_QWEN_MODEL;
          if (updates.solutionModel === undefined)
            updates.solutionModel = DEFAULT_QWEN_MODEL;
          if (updates.debuggingModel === undefined)
            updates.debuggingModel = DEFAULT_QWEN_MODEL;
        } else if (updates.apiProvider === "gemini") {
          // Gemini 默认 flash-latest
          if (updates.extractionModel === undefined)
            updates.extractionModel = "gemini-flash-latest";
          if (updates.solutionModel === undefined)
            updates.solutionModel = "gemini-flash-latest";
          if (updates.debuggingModel === undefined)
            updates.debuggingModel = "gemini-flash-latest";
        } else if (updates.apiProvider === "custom") {
          // For custom provider, don't touch extraction/solution/debugging defaults
        } else if (updates.apiProvider === "custom2") {
          // For custom2 provider, don't touch extraction/solution/debugging defaults
        }
      }
      // Sanitize model selections in the updates
      if (updates.extractionModel) {
        updates.extractionModel = this.sanitizeModelSelection(
          updates.extractionModel,
          provider,
        );
      }
      if (updates.solutionModel) {
        updates.solutionModel = this.sanitizeModelSelection(
          updates.solutionModel,
          provider,
        );
      }
      if (updates.debuggingModel) {
        updates.debuggingModel = this.sanitizeModelSelection(
          updates.debuggingModel,
          provider,
        );
      }
      // 自动同步 Qwen Key 到 Ali ASR / Gummy (保证后端兜底，直接覆盖)
      const qwenKey =
        updates.qwenApiKey ||
        (provider === "qwen" && updates.apiKey ? updates.apiKey : "");
      if (qwenKey) {
        updates.aliAsrApiKey = qwenKey;
        updates.gummyApiKey = qwenKey;
        updates.liveTranslateApiKey = qwenKey;
        updates.paraformerApiKey = qwenKey;
      }
      const newConfig = { ...currentConfig, ...updates };
      this.saveConfig(newConfig);
      // Only emit update event for changes other than opacity
      // This prevents re-initializing the AI client when only opacity changes
      if (
        updates.apiKey !== undefined ||
        updates.apiProvider !== undefined ||
        updates.extractionModel !== undefined ||
        updates.solutionModel !== undefined ||
        updates.debuggingModel !== undefined ||
        updates.language !== undefined ||
        updates.customBaseUrl !== undefined ||
        updates.customModelId !== undefined ||
        updates.customPrompt !== undefined ||
        updates.custom2BaseUrl !== undefined ||
        updates.custom2ApiKey !== undefined ||
        updates.custom2ModelId !== undefined ||
        updates.custom2Prompt !== undefined ||
        updates.enableKB !== undefined ||
        updates.kbTopK !== undefined ||
        updates.kbMaxChunkChars !== undefined
      ) {
        this.emit("config-updated", newConfig);
      }
      return newConfig;
    } catch (error) {
      console.error("Error updating config:", error);
      return this.defaultConfig;
    }
  }
  /**
   * Check if the API key is configured
   */
  hasApiKey() {
    const config = this.loadConfig();
    return !!config.apiKey && config.apiKey.trim().length > 0;
  }
  /**
   * Validate the API key format
   */
  isValidApiKeyFormat(apiKey, provider) {
    // If provider is not specified, attempt to auto-detect
    if (!provider) {
      if (apiKey.trim().startsWith("sk-")) {
        if (apiKey.trim().startsWith("sk-ant-")) {
          provider = "anthropic";
        } else {
          provider = "openai";
        }
      } else {
        provider = "gemini";
      }
    }
    if (provider === "openai") {
      // Basic format validation for OpenAI API keys
      return /^sk-[a-zA-Z0-9]{32,}$/.test(apiKey.trim());
    } else if (provider === "gemini") {
      // Basic format validation for Gemini API keys (usually alphanumeric with no specific prefix)
      return apiKey.trim().length >= 10; // Assuming Gemini keys are at least 10 chars
    } else if (provider === "anthropic") {
      // Basic format validation for Anthropic API keys
      return /^sk-ant-[a-zA-Z0-9]{32,}$/.test(apiKey.trim());
    }
    return false;
  }
  /**
   * Get the stored opacity value
   */
  getOpacity() {
    const config = this.loadConfig();
    return config.opacity !== undefined ? config.opacity : 1.0;
  }
  /**
   * Set the window opacity value
   */
  setOpacity(opacity) {
    // Ensure opacity is between 0.1 and 1.0
    const validOpacity = Math.min(1.0, Math.max(0.1, opacity));
    this.updateConfig({ opacity: validOpacity });
  }
  /**
   * Get the preferred programming language
   */
  getLanguage() {
    const config = this.loadConfig();
    return config.language || "python";
  }
  /**
   * Set the preferred programming language
   */
  setLanguage(language) {
    this.updateConfig({ language });
  }
  /**
   * Test API key with the selected provider
   */
  async testApiKey(apiKey, provider) {
    // Auto-detect provider based on key format if not specified
    if (!provider) {
      if (apiKey.trim().startsWith("sk-")) {
        if (apiKey.trim().startsWith("sk-ant-")) {
          provider = "anthropic";
          console.log("Auto-detected Anthropic API key format for testing");
        } else {
          provider = "openai";
          console.log("Auto-detected OpenAI API key format for testing");
        }
      } else {
        provider = "gemini";
        console.log("Using Gemini API key format for testing (default)");
      }
    }
    if (provider === "openai") {
      return this.testOpenAIKey(apiKey);
    } else if (provider === "gemini") {
      return this.testGeminiKey(apiKey);
    } else if (provider === "anthropic") {
      return this.testAnthropicKey(apiKey);
    }
    return { valid: false, error: "Unknown API provider" };
  }
  /**
   * Test OpenAI API key
   */
  async testOpenAIKey(apiKey) {
    try {
      const openai = new openai_1.OpenAI({ apiKey });
      // Make a simple API call to test the key
      await openai.models.list();
      return { valid: true };
    } catch (error) {
      console.error("OpenAI API key test failed:", error);
      // Determine the specific error type for better error messages
      let errorMessage = "Unknown error validating OpenAI API key";
      if (error.status === 401) {
        errorMessage =
          "Invalid API key. Please check your OpenAI key and try again.";
      } else if (error.status === 429) {
        errorMessage =
          "Rate limit exceeded. Your OpenAI API key has reached its request limit or has insufficient quota.";
      } else if (error.status === 500) {
        errorMessage = "OpenAI server error. Please try again later.";
      } else if (error.message) {
        errorMessage = `Error: ${error.message}`;
      }
      return { valid: false, error: errorMessage };
    }
  }
  /**
   * Test Gemini API key
   * Note: This is a simplified implementation since we don't have the actual Gemini client
   */
  async testGeminiKey(apiKey) {
    try {
      // For now, we'll just do a basic check to ensure the key exists and has valid format
      // In production, you would connect to the Gemini API and validate the key
      if (apiKey && apiKey.trim().length >= 20) {
        // Here you would actually validate the key with a Gemini API call
        return { valid: true };
      }
      return { valid: false, error: "Invalid Gemini API key format." };
    } catch (error) {
      console.error("Gemini API key test failed:", error);
      let errorMessage = "Unknown error validating Gemini API key";
      if (error.message) {
        errorMessage = `Error: ${error.message}`;
      }
      return { valid: false, error: errorMessage };
    }
  }
  /**
   * Test Anthropic API key
   * Note: This is a simplified implementation since we don't have the actual Anthropic client
   */
  async testAnthropicKey(apiKey) {
    try {
      // For now, we'll just do a basic check to ensure the key exists and has valid format
      // In production, you would connect to the Anthropic API and validate the key
      if (apiKey && /^sk-ant-[a-zA-Z0-9]{32,}$/.test(apiKey.trim())) {
        // Here you would actually validate the key with an Anthropic API call
        return { valid: true };
      }
      return { valid: false, error: "Invalid Anthropic API key format." };
    } catch (error) {
      console.error("Anthropic API key test failed:", error);
      let errorMessage = "Unknown error validating Anthropic API key";
      if (error.message) {
        errorMessage = `Error: ${error.message}`;
      }
      return { valid: false, error: errorMessage };
    }
  }
}
exports.ConfigHelper = ConfigHelper;
// Export a singleton instance
exports.configHelper = new ConfigHelper();
