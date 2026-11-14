"use strict";
/**
 * Maintains the small text window used by follow-up questions and a separate,
 * bounded screenshot window. Provider-specific payloads are created only when
 * a request is sent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.contextManager = exports.ContextManager = void 0;
class ContextManager {
  constructor() {
    this.history = [];
    this.imageBatches = [];
    this.MAX_HISTORY_LEN = 6;
    this.MAX_IMAGE_BATCHES = 2;
  }
  commitTurn(userText, assistantText) {
    const cleanUserText = String(userText || "").trim();
    const cleanAssistantText = String(assistantText || "").trim();
    if (!cleanUserText || !cleanAssistantText) return;
    console.log(
      `[ContextManager] Committing text turn: user=${cleanUserText.length} chars, assistant=${cleanAssistantText.length} chars`,
    );
    this.history.push({ role: "user", content: cleanUserText });
    this.history.push({ role: "assistant", content: cleanAssistantText });
    if (this.history.length > this.MAX_HISTORY_LEN) {
      this.history = this.history.slice(-this.MAX_HISTORY_LEN);
    }
  }
  commitImageBatch(batch) {
    const normalized = this.normalizeImageBatch(batch);
    if (!normalized) return;
    this.imageBatches = [...this.imageBatches, normalized].slice(
      -this.MAX_IMAGE_BATCHES,
    );
    console.log(
      `[ContextManager] Committed screenshot batch: images=${normalized.images.length}, batches=${this.imageBatches.length}/${this.MAX_IMAGE_BATCHES}`,
    );
  }
  getCandidateImageBatches(newBatch) {
    const normalized = newBatch ? this.normalizeImageBatch(newBatch) : null;
    const batches = normalized
      ? [...this.imageBatches, normalized].slice(-this.MAX_IMAGE_BATCHES)
      : this.imageBatches;
    return [...batches];
  }
  hasImages() {
    return this.imageBatches.some((batch) => batch.images.length > 0);
  }
  clear() {
    console.log(
      `[ContextManager] Cleared ${this.history.length} text messages and ${this.imageBatches.length} screenshot batches`,
    );
    this.history = [];
    this.imageBatches = [];
  }
  buildMessages(
    provider,
    systemPrompt,
    currentUserInput,
    modelName = "",
    options = {},
  ) {
    const cleanHistory = [...this.history];
    const batches = options.imageBatches ?? this.imageBatches;
    const imageCount = batches.reduce(
      (count, batch) => count + batch.images.length,
      0,
    );
    const isAnthropic = provider === "anthropic";
    const isDeepSeek = provider === "qwen" && /^deepseek-/i.test(modelName);
    console.log(
      `[ContextManager] Building ${provider} messages: turns=${cleanHistory.length / 2}, imageBatches=${batches.length}, images=${imageCount}`,
    );
    const currentContent = this.buildCurrentUserContent(
      provider,
      currentUserInput,
      batches,
    );
    if (isAnthropic || isDeepSeek) {
      if (cleanHistory.length === 0) {
        return [
          {
            role: "user",
            content: this.prependSystemPrompt(
              currentContent,
              systemPrompt,
              isAnthropic,
            ),
          },
        ];
      }
      const messages = cleanHistory.map((message, index) => {
        const text =
          index === 0 && message.role === "user"
            ? `${systemPrompt}\n\n${message.content}`
            : message.content;
        return {
          role: message.role,
          content: isAnthropic ? [{ type: "text", text }] : text,
        };
      });
      messages.push({ role: "user", content: currentContent });
      return messages;
    }
    return [
      { role: "system", content: systemPrompt },
      ...cleanHistory.map((message) => ({
        role: message.role,
        content:
          provider === "custom" || provider === "custom2"
            ? [{ type: "text", text: message.content }]
            : message.content,
      })),
      { role: "user", content: currentContent },
    ];
  }
  buildCurrentUserContent(provider, currentUserInput, batches) {
    const text =
      String(currentUserInput || "").trim() || "请结合当前截图继续回答。";
    const hasImages = batches.some((batch) => batch.images.length > 0);
    if (!hasImages) {
      if (
        provider === "anthropic" ||
        provider === "custom" ||
        provider === "custom2"
      ) {
        return [{ type: "text", text }];
      }
      return text;
    }
    if (provider === "anthropic") {
      return [
        { type: "text", text },
        ...batches.flatMap((batch) => [
          ...(batch.accompanyingText
            ? [
                {
                  type: "text",
                  text: `截图补充说明：${batch.accompanyingText}`,
                },
              ]
            : []),
          ...batch.images.map((image) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.data,
            },
          })),
        ]),
      ];
    }
    return [
      { type: "text", text },
      ...batches.flatMap((batch) => [
        ...(batch.accompanyingText
          ? [{ type: "text", text: `截图补充说明：${batch.accompanyingText}` }]
          : []),
        ...batch.images.map((image) => ({
          type: "image_url",
          image_url: {
            url: `data:${image.mediaType};base64,${image.data}`,
          },
        })),
      ]),
    ];
  }
  prependSystemPrompt(content, systemPrompt, useTextBlocks) {
    if (Array.isArray(content)) {
      const [first, ...rest] = content;
      if (first?.type === "text") {
        return [
          { ...first, text: `${systemPrompt}\n\n${first.text}` },
          ...rest,
        ];
      }
      return [{ type: "text", text: systemPrompt }, ...content];
    }
    const merged = `${systemPrompt}\n\n${String(content || "")}`;
    return useTextBlocks ? [{ type: "text", text: merged }] : merged;
  }
  normalizeImageBatch(batch) {
    const images = Array.isArray(batch?.images)
      ? batch.images.filter((image) => Boolean(image?.data))
      : [];
    if (images.length === 0) return null;
    return {
      images,
      accompanyingText:
        String(batch.accompanyingText || "").trim() || undefined,
      createdAt: Number(batch.createdAt) || Date.now(),
    };
  }
}
exports.ContextManager = ContextManager;
exports.contextManager = new ContextManager();
