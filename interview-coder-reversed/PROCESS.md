# 逆向工程执行清单

本文档记录从 dmg 到可读代码的完整步骤。

## 1. 挂载和定位

```bash
# 挂载 dmg
hdiutil attach Interview-Coder-arm64.dmg -readonly -mountpoint /tmp/ic-mount

# 确认应用包结构
ls -la /tmp/ic-mount/time.app/Contents/
# MacOS/time 是可执行文件
# Resources/app.asar 是主归档
# Resources/app.asar.unpacked/ 是原生模块目录
```

**结果**：应用名称 `time.app`，版本 2.1.1，asar 归档 + unpacked 原生模块的标准 Electron 结构。

## 2. 解包 asar 归档

```bash
# 列出归档内容，确认条目数
npx @electron/asar list /tmp/ic-mount/time.app/Contents/Resources/app.asar | wc -l
# 13630 条目

# 解包到本地目录
npx @electron/asar extract \
  /tmp/ic-mount/time.app/Contents/Resources/app.asar \
  ~/personal-software/果冻/interview-coder-reversed/app

# 复制原生模块目录
cp -R /tmp/ic-mount/time.app/Contents/Resources/app.asar.unpacked \
  ~/personal-software/果冻/interview-coder-reversed/
```

**结果**：
- `app/` 目录：12291 个文件 + 1339 个子目录 = 13630 条目
- `app.asar.unpacked/` 目录：708 个文件（sharp 和 onnxruntime-node 的二进制）

## 3. 完整性验证

```bash
# 重新解包到临时目录
npx @electron/asar extract <dmg中的app.asar> /tmp/fresh-extract

# 逐字节对比
diff -rq /tmp/fresh-extract ~/personal-software/果冻/interview-coder-reversed/app
# 结果：IDENTICAL（无差异）

diff -rq <dmg中的app.asar.unpacked> ~/personal-software/果冻/interview-coder-reversed/app.asar.unpacked
# 结果：IDENTICAL（无差异）
```

**结论**：解包无损，所有文件与原始归档逐字节相同。

## 4. 代码结构分析

检查解包出的目录：

```
app/
├── package.json          # 依赖清单，版本 2.1.1
├── dist-electron/        # 主进程代码（73794 行，压缩格式）
│   ├── main.js           # 应用入口
│   ├── ProcessingHelper.js
│   ├── prompts.js
│   ├── shortcuts.js
│   └── ... (33 个模块)
├── dist/                 # 渲染进程打包产物
│   ├── index.html
│   └── assets/
│       ├── index-*.js    # React 单页应用（207 行，压缩到一行）
│       └── index-*.css   # 样式表（1 行）
└── html5_client/         # 独立音频客户端（2494 行）
```

主进程是 TypeScript 编译的 CommonJS，保留了原始命名。渲染进程是 Vite 打包的压缩代码，变量名已混淆。

## 5. 格式化处理

```bash
# 创建阅读副本
cp -R app/ readable/

# 用 Prettier 格式化所有 JS/CSS
npx prettier@3.3.3 --write \
  readable/dist-electron/*.js \
  readable/html5_client/*.js \
  readable/dist/assets/*.js \
  readable/dist/assets/*.css
```

**格式化前后对比**：

| 目录 | 原始行数 | 格式化后 | 变化 |
|---|---:|---:|---|
| dist-electron/ | 73,794 | 92,105 | +25%（展开嵌套和函数调用） |
| dist/assets/ | 207 | 50,232 | +242×（单行代码展开） |
| html5_client/ | 2,494 | 2,737 | +10%（本来就相对可读） |

格式化只改变空白、换行和缩进，不改变语义。变量名无法恢复（Vite 在打包时已经压缩）。

## 6. 架构文档编写

### 6.1 收集模块信息

```bash
# 列出每个模块的导出
for f in dist-electron/*.js; do
  grep '^exports\.' "$f" | sed 's/exports\.//' | sort -u
done

# 列出 IPC 通道
grep -hoE 'ipcMain\.(handle|on)\("([^"]+)"' dist-electron/*.js \
  | sed 's/.*"\(.*\)"/\1/' | sort -u
# 65 个通道

# 列出全局快捷键
grep -oE '"CommandOrControl[^"]*"' dist-electron/shortcuts.js | sort -u
# 27 个快捷键
```

### 6.2 分析核心流程

阅读关键模块：
- `ProcessingHelper.js` 的 `processScreenshots` 方法（截图处理主流程）
- `prompts.js` 的提示词模板（系统提示词和用户提示词）
- `main.js` 的 `createWindow` 函数（窗口创建和配置）
- `HistoryHelper.js` 的保存逻辑（历史记录存储）

### 6.3 编写文档

创建两份文档：
1. **ARCHITECTURE.md**（技术笔记）：进程结构、模块职责、IPC 通道、快捷键、核心流程
2. **README.md**（成果总结）：完整性验证、目录说明、技术栈、如何阅读、用途声明

## 7. 最终检查

```bash
# 确认文件数量
find app/ -mindepth 1 | wc -l        # 13630
find readable/ -type f | wc -l       # 49（只复制了业务代码，不含 node_modules）

# 确认格式化生效
wc -l app/dist-electron/*.js | tail -1        # 73794 total
wc -l readable/dist-electron/*.js | tail -1   # 92105 total

# 确认文档已创建
ls -la readable/ARCHITECTURE.md  # 6.8 KB
ls -la README.md                  # 6.0 KB
```

## 8. 清理

```bash
# 卸载 dmg
hdiutil detach /tmp/ic-mount

# 删除临时验证目录
rm -rf /tmp/ic-verify /tmp/ic-extract*
```

## 总结

| 步骤 | 状态 | 说明 |
|---|:---:|---|
| 挂载 dmg | ✅ | time.app 2.1.1，标准 Electron 结构 |
| 解包 asar | ✅ | 13630 条目全部提取 |
| 完整性验证 | ✅ | diff 确认逐字节相同 |
| 格式化代码 | ✅ | Prettier 处理，仅改空白不改语义 |
| 架构分析 | ✅ | 65 个 IPC 通道，27 个快捷键，33 个主进程模块 |
| 文档编写 | ✅ | ARCHITECTURE.md（技术细节）+ README.md（成果说明） |

**逆向成果**：百分之百提取原始文件，格式化后的代码完全可读（主进程保留原始命名），架构文档覆盖核心流程和模块职责。授权相关模块已解包但未分析，不提供重新打包方案。

**用途**：学习 Electron + AI 的技术实现，理解答题助手的工作原理。不用于绕过授权、重新分发或商业用途。
