# code-video-skill

> 让 AI 用代码制作视频的完整工作流（Agent Skill）。

## 这是什么

一套**"总导演层"工作流 skill**：把一句话需求变成可复现、经得起验证的视频成片，供 AI 编程助手（Codex / Claude Code / Cursor 等支持 Agent Skills 的工具）使用。覆盖全流程：

**创意简报与文案 → 场景拆解 → 音频先行（拍点解析 / 歌词对齐 / 裁切踩点）→ 逐场景实现（Remotion / three.js / p5.js / Tone.js）→ 集成验证 → 成片质检**

随包附带三件套：

- **视频工程模板**（`code-video-skill/assets/template/`）：渲染配置基线、p5/three 适配层、音效工具链、音床兜底；
- **音频工具**（`code-video-skill/scripts/audio/`）：音乐分析、歌词对齐、裁切踩点、按需加工（Python）；
- **质检脚本**（`code-video-skill/scripts/verify/`）：黑帧扫描 / 帧级确定性 / 音频体检 / 抽帧拼图（Node，零依赖）。

## 安装

只需要一步：**把本仓库内的 `code-video-skill/` 整个放入你的 AI 工具的 skill 读取目录**，即可被自动识别。

- Codex：`~/.agents/skills/`
- Claude Code：`~/.claude/skills/`
- 其它工具：放入其文档约定的 skills 目录

skill 内全部使用相对路径，放在哪里都能运行，无需其它安装步骤。

## 依赖

**需要你自备：**

| 依赖 | 说明 |
|---|---|
| Remotion skills（必需） | `npx skills add remotion-dev/skills`。本 skill 不重复 Remotion 的 API 知识，画面写法由官方 skills 提供 |
| Node.js ≥ 20 + npm | 视频工程模板的运行环境 |
| ffmpeg / ffprobe（完整版） | 必须在 PATH 中：音频处理与质检依赖（`signalstats` / `loudnorm` / `silencedetect` 等滤镜） |

**由模板自动安装（`npm ci`，无需手工处理）：**

- Remotion（含 `@remotion/three`、`@remotion/media`）、**three.js**、**p5.js**、**Tone.js**——版本已在模板 `package-lock.json` 中精确锁定

**音频工具依赖（Python，按需——只做画面与音效时无需安装）：**

| 用途 | 库 |
|---|---|
| 音乐分析（BPM / 拍点 / 能量） | **librosa**（+ numpy / matplotlib / soundfile） |
| 歌词对齐（人声分离 + 词级时间戳） | **Demucs** + **faster-whisper**（+ torch 等） |

安装方式见 `code-video-skill/scripts/audio/` 下的工具说明（引导你在本地建独立 venv，不污染全局环境）。

## 定位声明

**本项目只是一套"给 AI 的工作流"。** 它提供的是流程、工程基线与验证方法；构图、配色、动效、风格等一切审美决策**不设规则**，没有预设风格偏好。**最终产物的质量取决于你所使用模型的能力与审美。** 工作流保证的是工程正确性——逐帧确定性、编码合规、可复现、每一步可验证——而不是替模型做审美判断，也不做审美打分。

## 目录结构

```text
（仓库根，名称随你）
├─ LICENSE
├─ README.md              ← 本文件（仓库说明，不进入 skill）
└─ code-video-skill/      ← 把这个目录放进 skills 读取目录
   ├─ SKILL.md
   ├─ references/         工作流细节（按需加载）
   ├─ scripts/audio/      音频工具
   ├─ scripts/verify/     质检脚本
   └─ assets/template/    视频工程模板
```
