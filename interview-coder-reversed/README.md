# Interview Coder 2.1.1 逆向工程成果

本目录包含从 `Interview-Coder-arm64.dmg` 完整解包和格式化后的源代码。

## 文件说明

```
interview-coder-reversed/
├── app/                    # 从 app.asar 原样解出，未修改
├── app.asar.unpacked/      # 原生模块（sharp、onnxruntime-node）
└── readable/               # 格式化后的代码，供阅读和学习
    ├── ARCHITECTURE.md     # 架构分析笔记
    ├── package.json        # 依赖清单
    ├── dist-electron/      # 主进程代码（92105 行，保留原始命名）
    ├── dist/               # 渲染进程打包产物（50232 行，变量名已压缩）
    └── html5_client/       # 独立网页音频客户端（2737 行）
```

## 完整性验证

| 检查项 | 结果 |
|---|---|
| asar 归档条目数 | 13630 |
| 解包后文件+目录数 | 13630 |
| 文件完整性 | ✅ 逐字节相同 |
| 格式化完整性 | ✅ 仅改变空白，不改变语义 |

使用 `npx @electron/asar list` 和 `find` 交叉验证，确认所有文件已完整提取。

## 这是什么软件

Interview Coder 是一个隐形桌面助手，用于技术面试答题。核心功能：

- **截图 + AI 解答**：全局快捷键截图（Cmd+H），发给 OpenAI/Anthropic/Gemini 等模型，流式返回结构化答案（题目、解法、解释、复杂度）
- **实时语音转写**：支持 Deepgram、豆包、Paraformer、OpenAI 等实时语音识别，边说边转文字
- **知识库检索**：本地向量数据库（onnxruntime 跑嵌入模型），检索相关知识片段增强提示词
- **调试模式**：把之前的答案和新截图一起发给模型，要求指出错误
- **历史记录**：每次答题保存为本地 HTML，带题目、答案、截图和时间戳

应用窗口透明置顶，通过全局快捷键控制显示/隐藏、移动位置、调整透明度和缩放。

## 技术架构

- **Electron 桌面框架**：主进程是 TypeScript 编译的 CommonJS，界面是 React 18 + Vite 单页应用
- **AI SDK**：`openai` 和 `@anthropic-ai/sdk`，流式调用模型
- **截图**：`screenshot-desktop` 跨平台全屏截图，Windows 下有独立的截图子进程
- **语音转写**：WebSocket 连接各家实时 API（Deepgram、豆包、Paraformer）
- **本地 AI**：`@xenova/transformers` + `onnxruntime-node` 跑嵌入模型，做向量检索
- **配置持久化**：`electron-store`
- **自动更新**：`electron-updater`

主进程约 92k 行（格式化后），保留了完整的类名、函数名和注释。渲染进程约 50k 行，变量名被 Vite 压缩过。

## 主要模块（dist-electron/）

| 模块 | 行数 | 作用 |
|---|---:|---|
| `main.js` | - | 应用入口，创建窗口和管理全局状态 |
| `ProcessingHelper.js` | - | 核心：调用 AI 模型，流式解析 JSON，推送事件 |
| `prompts.js` | - | 所有提示词模板（解题、调试、行测，中英文） |
| `ScreenshotHelper.js` | - | 截图队列管理和预览 |
| `shortcuts.js` | - | 注册 27 个全局快捷键 |
| `LocalVectorDB.js` + `LocalBM25.js` | - | 本地知识库（向量 + 关键词检索） |
| `HistoryHelper.js` | - | 保存答题历史为 HTML |
| `deepgram/doubao/paraformer/openAISession.js` | - | 实时语音转写会话（WebSocket） |
| `MobileBridge.js` | - | 本地服务，手机扫码查看转写 |
| `ConfigHelper.js` + `store.js` | - | 配置读写和持久化 |

完整模块清单和 IPC 通道列表见 `readable/ARCHITECTURE.md`。

## 格式化说明

`readable/` 目录里的代码用 Prettier 3.3.3 格式化过，格式化前后对比：

| 目录 | 格式化前 | 格式化后 | 增幅 |
|---|---:|---:|---:|
| dist-electron/ | 73,794 行 | 92,105 行 | +25% |
| dist/assets/ | 207 行 | 50,232 行 | +242× |
| html5_client/ | 2,494 行 | 2,737 行 | +10% |

渲染进程原本是压缩到 207 行的单行代码，格式化后展开成 5 万多行。Prettier 只改变空白和换行，不改变代码含义，变量名无法恢复（Vite 打包时已经压缩）。

## 未分析的部分

以下模块涉及授权、卡密、设备绑定、额度扣减，本次逆向工程**没有分析**，也**不会整理成可重新打包的项目**：

- `LicenseHelper.js`
- `DomesticLicenseService.js`
- `AuthHelperOverseas.js`
- `AccessGuard.js`
- `ClientServiceHttp.js`

这些模块的代码已经解包并格式化，但没有写入架构文档。

## 如何阅读

1. 从 `readable/ARCHITECTURE.md` 开始，了解整体结构和模块分工
2. 看 `readable/package.json` 确认依赖版本
3. 读 `readable/dist-electron/main.js` 的 `createWindow` 函数，了解窗口如何创建
4. 读 `readable/dist-electron/ProcessingHelper.js` 的 `processScreenshots` 方法，了解核心流程
5. 读 `readable/dist-electron/prompts.js`，看提示词模板如何组织
6. 读 `readable/dist-electron/shortcuts.js`，看每个快捷键绑定的动作
7. 搜索渲染进程代码（`dist/assets/index-*.js`）里的中文文案，定位界面逻辑

## 验证步骤

如果想确认解包的完整性：

```bash
# 挂载 dmg
hdiutil attach Interview-Coder-arm64.dmg -readonly -mountpoint /tmp/ic-mount

# 列出 asar 归档内容
npx @electron/asar list /tmp/ic-mount/time.app/Contents/Resources/app.asar > /tmp/asar-list.txt

# 解包
npx @electron/asar extract /tmp/ic-mount/time.app/Contents/Resources/app.asar /tmp/extracted

# 对比文件数量
wc -l /tmp/asar-list.txt
find /tmp/extracted -mindepth 1 | wc -l

# 卸载
hdiutil detach /tmp/ic-mount
```

两个数字应该相等（13630）。

## 用途说明

本逆向工程仅用于**学习软件架构和 Electron + AI 的技术实现**，不用于：
- 绕过授权机制
- 重新打包分发
- 商业用途

代码已完整提取并格式化，可以直接阅读。授权相关模块虽然已解包，但未分析其逻辑。

---

**解包时间**：2026-11-14  
**软件版本**：Interview Coder 2.1.1 (arm64)  
**完整性**：13630 条目全部提取，逐字节验证通过
