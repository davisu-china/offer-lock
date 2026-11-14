# time.app（Interview Coder 2.1.1）结构分析笔记

## 目录说明

| 目录 | 内容 |
|---|---|
| `../app/` | 从 app.asar 原样解出的文件，没有改动 |
| `../app.asar.unpacked/` | 原生模块（sharp、onnxruntime-node） |
| `./` | `app/` 的副本，用 Prettier 格式化过，供阅读 |

格式化只改变空白和换行，不改变代码含义。渲染进程的变量名在打包时已经被压缩，原名无法恢复。

## 技术栈

- **外壳**：Electron。主进程是 TypeScript 编译出的 CommonJS（`dist-electron/`，92105 行），保留了模块名和函数名。
- **界面**：React 18 + React Router + TanStack Query + Tailwind，由 Vite 打成一个文件 `dist/assets/index-*.js`（50232 行，变量名已压缩）。
- **大块依赖**：`main-D408EjhS.js` 是 Vite 打进主进程的第三方库合集（HTTP、WebSocket、OpenAI SDK 等），不是业务代码，阅读时可以跳过。
- **配置**：`electron-store` 保存设置，`.env` 里的 `VITE_APP_REGION` 决定国内版还是海外版。

### 核心依赖

主进程：
- `openai` ^4.28.4、`@anthropic-ai/sdk` ^0.39.0：调用 OpenAI 和 Anthropic 模型
- `axios` ^1.7.7、`ws` ^8.20.1：HTTP 请求和 WebSocket 连接（实时语音转写）
- `electron-store` ^10.0.0、`electron-updater` ^6.3.9：配置持久化和自动更新
- `screenshot-desktop` ^1.15.0：跨平台截图
- `@xenova/transformers` ^2.17.2：本地运行嵌入模型（知识库向量检索）
- `sharp`（app.asar.unpacked）：图像处理原生模块
- `onnxruntime-node`（app.asar.unpacked）：运行 ONNX 模型

界面：
- `react` ^18.2.0、`react-dom` ^18.2.0、`react-router-dom` ^6.28.1
- `@tanstack/react-query` ^5.64.0：异步状态管理
- `@radix-ui/*`：无样式 UI 组件库（Dialog、Toast 等）
- `tailwindcss`（devDependencies）：样式框架
- `react-syntax-highlighter` ^15.6.1：代码高亮显示

## 进程结构

```
main.js  ──创建──>  主窗口（React 界面）
   │                    │
   │              preload.js 通过 contextBridge 暴露 electronAPI
   │                    │
   └── ipcHandlers.js <─┘  渲染进程用 ipcRenderer.invoke 调用主进程
```

主进程大约注册了 65 个进程间通信通道。按功能分组：

- **窗口**：toggle-window、set-window-dimensions、trigger-move-*、set-mouse-ignore、set-zoom-level
- **截图队列**：take-screenshot、get-screenshot-queue、delete-screenshot、reset-queues
- **处理请求**：process-screenshots、process-text-only、trigger-process-with-input
- **语音**：start-voice-recognition、stop-voice-recognition、voice-transcript、get-desktop-audio-source-id
- **知识库**：kb-import-files、kb-rebuild、kb-stats、kb-clear
- **历史记录**：history-list、history-delete、history-open-html
- **配置与更新**：get-config、update-config、validate-api-key、start-update、install-update

preload.js 里的 `PROCESSING_EVENTS` 定义了主进程推给界面的事件，例如 problem-extracted、solution-progress（流式输出）、solution-success、debug-success。

## 主要功能模块（dist-electron/）

| 模块 | 作用 |
|---|---|
| `main.js` | 应用入口。创建透明置顶窗口和语音窗口，管理截图队列和视图状态 |
| `shortcuts.js` | 注册全局快捷键，见下一节 |
| `ScreenshotHelper.js`、`WindowsScreenshotWorker.js`、`RegionSelector.js` | 全屏截图、Windows 下的截图子进程、框选区域截图 |
| `ProcessingHelper.js` | 核心流程：把截图或文字发给模型，解析 JSON 结果，流式推送给界面 |
| `prompts.js` | 所有提示词模板，分截图解题、纯文字解题、调试、行测图形题四类，各有中英文版本 |
| `ContextManager.js` | 维护多轮对话上下文 |
| `LocalBM25.js`、`LocalVectorDB.js` | 本地知识库。BM25 关键词检索加向量检索，向量部分用 onnxruntime-node 跑嵌入模型 |
| `HistoryHelper.js` | 把每次答题结果存成本地 HTML 历史 |
| `deepgramSession.js`、`doubaoSession.js`、`paraformerSession.js`、`openAISession.js` | 不同厂商的实时语音转写，都走 WebSocket |
| `liveTranslateSession.js` | 实时翻译会话 |
| `MobileBridge.js` | 在本机起一个服务，让手机扫码查看转写内容 |
| `MouseGestureHelper.js` | 鼠标手势触发操作 |
| `ConfigHelper.js`、`ConfigBackupHelper.js`、`store.js` | 读写配置和备份 |
| `autoUpdater.js` | 基于 electron-updater 的自动更新 |

### 模型调用流程

`ProcessingHelper.js` 支持这些提供方：openai、anthropic、gemini、qwen、openrouter，以及两个自定义 OpenAI 兼容接口 custom 和 custom2。每个提供方的 API key 和 base URL 从 `ConfigHelper` 读取。

**处理一次截图的完整流程**（`processScreenshots` 方法）：

1. **读取截图队列**：从 `ScreenshotHelper` 拿到待处理的截图文件路径，读成 Buffer 并转 base64。
2. **选择提示词**：根据当前模式（solve / debug / xingce）和界面语言（zh / en），从 `prompts.js` 选对应的系统提示词和用户提示词。调试模式会附加之前的解答作为上下文。
3. **知识库检索**（可选）：如果 `LocalVectorDB` 初始化成功且用户开启了知识库，用问题文本做检索，过滤掉低于分数阈值的结果，把剩下的片段拼接后插进第一条用户消息的文字部分，系统提示词不动。
4. **构造消息数组**：系统消息 + 用户消息（文字 + 图片数组）。图片按各家 API 格式封装（OpenAI 是 `image_url`，Anthropic 是 `image` type）。
5. **流式调用模型**：用当前 provider 的 SDK 发起 stream 请求，设置 `AbortController` 用于取消。每收到一个 chunk，累积到 `fullResponse` 并立即发 `solution-progress` 事件给渲染进程。
6. **解析 JSON 结果**：模型返回应该是纯 JSON（prompts 里要求不要代码块包裹）。提取 `problem_statement`、`solution`、`explanation`、`time_complexity`、`space_complexity` 五个字段。
7. **发送成功事件**：`solution-success` 事件携带解析后的结构化数据，渲染进程更新界面。
8. **写入历史记录**：`HistoryHelper` 把题目、答案、截图保存成本地 HTML 文件，目录是 Electron 的 userData 下的 `records/`，在 macOS 上通常是 `~/Library/Application Support/interview-coder-v1/records/`。
调试模式的差别：会把之前的 solution 和新截图一起发给模型，走 `DEBUG_SYSTEM_PROMPT_*`，提示词要求模型指出错误并给出修正后的代码。

纯文字模式（`processTextOnly`）跳过截图步骤，直接把界面输入框的文字作为问题发给模型。

## 全局快捷键（shortcuts.js）

| 快捷键 | 动作 |
|---|---|
| Cmd/Ctrl+H | 截图（全屏或框选，取决于配置） |
| Cmd/Ctrl+Enter | 处理截图队列 |
| Cmd/Ctrl+S | 发送纯文本（不带截图） |
| Cmd/Ctrl+Shift+S | 发送最近的语音转写文本 |
| Cmd/Ctrl+D | 发送文本+截图组合 |
| Cmd/Ctrl+R | 取消请求并重置队列 |
| Cmd/Ctrl+方向键 | 移动窗口位置 |
| Cmd/Ctrl+Shift+上/下 | 滚动答案内容 |
| Cmd/Ctrl+B | 显示或隐藏窗口 |
| Cmd/Ctrl+Q | 退出应用 |
| Cmd/Ctrl+[ 和 ] | 减少/增加窗口透明度 |
| Cmd/Ctrl+- 0 = | 缩小/重置/放大界面 |
| Cmd/Ctrl+Shift+- 0 = | 减小/重置/增大答案字体 |
| Cmd/Ctrl+, 和 . | 切换到上一个/下一个答案页 |
| Cmd/Ctrl+L | 删除最后一张截图并清空文本输入框 |

具体动作以 `shortcuts.js` 里每个回调为准，表中部分描述是根据回调里调用的函数名推断的。

## 渲染进程（dist/assets/index-*.js）

界面代码被 Vite 打成一个文件，组件名和变量名已经压缩。可以按字符串常量定位：搜索界面上看到的中文文案，或搜索 `electronAPI.` 找到界面调用主进程的地方。

## html5_client/

一个独立的网页客户端，负责麦克风采集和音频编码，供语音窗口加载。

## 本笔记没有覆盖的部分

授权、卡密、设备绑定、额度扣减相关的模块（LicenseHelper、DomesticLicenseService、AuthHelperOverseas、AccessGuard、ClientServiceHttp 等）没有分析。
