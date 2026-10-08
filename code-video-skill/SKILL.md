---
name: code-video-skill
description: 用代码从创意到成片制作整条视频或动效短片的总导演工作流（创意简报 → 场景拆解 → 音频先行 → 逐场景实现 → 集成验证 → 成片质检），面向动效片、歌词卡点、音乐可视化、数据可视化、手绘/生成艺术与 3D 场景。用户要求用代码或程序化方式做一条视频时使用；不覆盖 Remotion API 写法（那类问题读 remotion-* skills），也不做写实素材混剪与 AI 生成视频素材。
metadata:
  short-description: 用代码做视频的总导演工作流
---

# 总导演层：用代码做一条视频

你的角色是导演：把一句话需求变成一条**可复现、经得起验证**的成片，并让每一步都留下可检查的产物。
工程正确性（逐帧确定性、编码规格、验证回路）由本工作流约束；**审美自由原则**——
构图、配色、字体、动效、节奏、风格等一切审美决策不设规则，按用户要求自由发挥即可，
本项目不做审美打分，也不强加风格偏好。

## 前置条件（开工前逐项确认）

1. **领域知识**：Remotion 的 API 与写法一律读官方 skills，优先 `remotion-best-practices`（路由器，按需加载）；
   已知具体需求可直接指名：画面写法 `remotion-markup`、字幕 `remotion-captions`、出片 `remotion-render`、
   预览 `remotion-studio`、新工程 `remotion-create`。
   - 安装：`npx skills add remotion-dev/skills`（需要 git）
   - **降级规则：环境中没有 remotion skills 时，不要凭记忆硬写 Remotion API**，按顺序尝试：
     ① 上面这条命令；② 无 git / 命令失败 → 手动下载 `remotion-dev/skills` 仓库 zip 解压到
     技能的 skills 目录（或工作区 `.agents/skills/`）；③ 仍不可行 → 直接下载并阅读对应的
     SKILL.md / REFERENCE.md 作为参考（等效满足"不凭记忆写 API"的本意）。过程记进报告。
2. **运行环境**：Node.js ≥ 20 与 npm；`ffmpeg` / `ffprobe` 在标准 PATH 中（音频工具与质检都依赖）。
   音频链路另需项目内 venv（见 `references/audio-pipeline.md`）。
   缺什么就报错并给安装指引，不为某台机器写环境适配。
   开工先跑一遍**环境就绪检查**：`node -v`、`npm -v`、`ffmpeg -version`、`git --version`
   都应能直接输出——常见坑：
   - Windows 下 PowerShell 执行策略禁用 `npm.ps1` / `npx.ps1` → 改用 `npm.cmd` / `npx.cmd`；
   - ffmpeg 的 PATH 改动不会传导进已开的会话——必要时在每次调用前脚本内拼 PATH；
   - npm 走代理偶发 `ECONNRESET` → 重试或清 `node_modules` 重装；
   - `npm ci` 对 esbuild 等包的 postinstall 限制（allow-scripts）会告警——是否真装好以渲染验证为准。
3. **随包资源**（本 skill 内所有路径均相对 skill 根目录）：

   ```text
   references/        工作流细节（按需读，见文末路由）
   scripts/audio/     音频：分析 / 歌词对齐 / 裁切踩点 / 按需加工（Python）
   scripts/verify/    质检：视频 / 确定性 / 音频 / 拼图（Node，零 npm 依赖）
   assets/template/   视频工程模板（真源，只复制、不修改）
   ```

4. **信息确认**：用户是否提供音乐与歌词；目标时长、平台、画幅、帧率；必须出现 / 不出现的文案与元素；
   谁对文案有最终决定权（用户授权自由发挥则你主导，用户给歌词则不得改写）。

## 工作流主干

六步，每步一个**成功门**；没通过就停在原地修复，不要带着问题往下走。

### 0 创意简报与文案

一句话主题 → 风格、时长、平台、画幅与帧率、情绪、核心信息；有叙事或字幕时起草文案并与用户对齐。

- 先读 `references/brief-and-storyboard.md`（简报字段、文案写法、场景表模板）。
- 用户提供歌词时**不得改写歌词**；需要用户拍板的地方一次问清，别边问边做。
- **成功门**：简报各项无空缺；文案定稿（或明确"无文案"）；时长已换算成整帧数。

### 1 场景拆解

把简报拆成"一句话主题 → 可执行方案"的场景表：画面描述、起止帧、时长、技术选型、素材需求、
**切换方式**（cut / 微溶解 / 转场——区分准则见 `references/brief-and-storyboard.md`）；
时间轴首尾相接、总和精确等于总帧数。技术选型读 `references/capability-map.md`（参考，不是规定）。

- **有用户在场时：开工前把分镜表（场景表 + 大特效清单：出现在哪个边界、什么效果）给用户过目确认**——
  文案有拍板环节，画面更需要一个（实测教训：转场特效铺满每个切点，返工三轮）。无用户在场时按默认
  准则执行，并在报告里标注特效清单。分镜表可先不含音频事件列：已跑完音频链路就带着一起呈交，
  否则先确认"画面列 + 切换方式 + 大特效清单"，等步骤 2 回填后再对一次。
- **成功门**：场景表覆盖全片、无空档与重叠；每行都能直接落到代码，没有"待定"。
  （音频事件列在步骤 2 分析完成后回填，见 `references/brief-and-storyboard.md` 的自查清单。）

### 2 音频先行

**先建工程**：从 `assets/template/` 复制一份到用户项目目录（排除 `node_modules/`、`out/`、`build/`）→
`npm ci` → 只改副本。音床与音频工具都要求用户项目已存在，这一步是后续所有步骤的载体。
用户素材（BGM 等）复制进 `public/audio/`（如 `public/audio/bgm.mp3`，语义化小写命名）；
工程建议以子目录与素材隔离（如 `<用户目录>/video/`，命名可自定）。

音乐是时间基准。用户提供音乐 → 解析拍点与能量 →（有歌词时）对齐歌词 → 按目标时长裁切踩点；
用户没提供音频 → 在项目里用音效元素拼一条完整音床（`npm run bed`）兜底，成片不得静音。
（无音乐且画面需要拍点：对生成的音床补跑一次 `analyze-music.py`，或直接读 `npm run bed --json`
的网格——即"先 bed → 再分析 → 再拆镜头"这条链。）
拿到曲目后先人工标注段落表（前奏 / 主歌 / 副歌 / 高潮）作为画面骨架——自动分析只给拍点，不给段落。

- 读 `references/audio-pipeline.md`（工具输入输出、"什么时候用"、边界与校验图）。
- **成功门**（按实际分支核对，不适用项显式记 N/A，不要假装通过）：
  - 用户提供音乐：`audio-analysis.json` 与校验图通过（BPM 合理、拍点数量相符）；有歌词时 `lyrics.json`
    行数一致、时间单调、末行不超时长；需要裁切时 `cut-plan.json checks_passed` 为真；
  - 无音乐（音床兜底）：音床时长与目标一致（`--expect-duration`），`verify-audio` 通过（响度 / 真峰 / 无异常静音）；
  - 音效 / 音床一律以落盘 WAV 资产为准。

### 3 逐场景实现

在步骤 2 建好的工程里逐场景实现；规格与时间轴只写在 `src/config.ts`（全片唯一事实来源），
画面写法按需读 remotion skills（先 `remotion-best-practices` 路由器）；**模板既有写法为基准**
（普通 `div` + `Sequence`），remotion skill 的增强写法（`Interactive.withSchema`、`premountFor` 等）
按需用于局部增强，不强制全面替换。

- 每实现一个场景就抽关键帧自检：`npx remotion still <composition-id> out/stills/<name>.png --frame=<N>`
  （模板自带 `npm run still:p5` / `still:three` / `still:cover` 作范例；单帧约 3.4s，等全片渲染完再看才是浪费。
  **段落结构改变后同步改写这些示例脚本与逐段 composition**——它们写死的 id 会随段落重排失效。
  推荐改成通用形态：`npm run still -- <CompId> out/stills/<name>.png --frame=<N>`（脚本把参数转发给
  `remotion still`），段落重排时只改参数、不改脚本本身）。
- **切换与转场是两回事**：场景边界默认用干脆切换（cut 或几帧微溶解）；**转场特效只用于画面场景
  "大幅变动"的边界**（时间大跳跃、空间大迁移），作用是交代变化，不是每个切点的装饰。
  大特效（满屏笔触之类）先出 1–2 张样张或短预览给用户看过，再铺全片。
- 官方指引建议尽早开 Studio 预览（`npm run dev`）；自动化环境以 still 抽帧为验证回路，两者冲突时以 still 为准。
- 跨栈集成细节与坑读 `references/engineering-pitfalls.md`。
- **成功门**：`npm run lint` 通过；每个场景的关键帧通过——判据可量化：自检定位靠 still 文件名
  （如 `out/stills/scene2-f240.png`；更推荐全程不开调试 HUD——如确需画面内帧号，临时打开
  `SHOW_DEBUG_HUD`，用后立即关回并复跑一次 still 核对）、
  文字与元素不越出 1920×1080 边界、画面非全黑（对 still 做像素统计兜底——图片查看工具的结果可能有误，
  见坑清单）。**成片不得含帧号 / 秒数 / 分镜编号与名称等制作信息**（见硬约束"成片清洁"）。

### 4 集成验证

全片预渲染 `npm run render:raw` → 抽帧核对：段间衔接、无空白 / 越界 / 黑帧。

- 命令与判读读 `references/verify-commands.md`（含音画同步抽查方法与报告骨架）。
- 注意：raw 未跑 finalize，`verify-video` 会报**预期内的 `duration-drift`**——跑 `render:full` 即消；
  除此之外的告警都要处理。
- **音画同步的判据是"同源 + 抽查"，不存在现成的跨模态检查命令**：让音效落点与画面切点来自同一份
  时间数据（切点秒数同时喂给草稿与 `bed --transitions`），再在切点帧抽帧、对照音频波形核对；
  四个 verify 脚本只覆盖"音频自身对拍点"与"画面自身规格"，不要以为有命令能替你验证音画对齐。
- **成功门**：拼图与关键帧证据齐全；切点帧抽查通过；verify-video 无黑帧、无异常空档（退出码 0）。

### 5 成片渲染与质检

`npm run render:full`（配置基线 + finalize 收尾）→ 跑质检脚本 → 归档报告
（报告骨架见 `references/verify-commands.md`）。

- **成功门**：`verify-video` / `verify-audio` / `contact-sheet` 退出码全 0；退出码 1 的告警必须先处理
  或明确记录取舍。
- **需要复现证据的场合**：改了渲染配置、升级了依赖、或你观察到任何随机差异时——才需要
  `verify-determinism` 做帧级 A/B（约 +20 s/300 帧；MP4 文件哈希不作判据）；其余情况可跳过。
- 媒体产物（`out/`）不进 git；质检报告落盘归档（项目有 git 时同步进库——本工作流不要求初始化 git）。

## 硬约束

- **配置基线不得绕过**：`assets/template/remotion.config.ts` 的 rspack / swangle / PNG 中间帧 / bt709 / h264
  五项与 `assets/template/scripts/finalize-mp4.mjs` 收尾是帧级可复现与编码合规的前提；
  换分辨率 / 帧率 / CRF 可以，换掉这五项不行。原因与实测数据见 `references/engineering-pitfalls.md`。
- **模板真源不改**：`assets/template/` 只读；一切创作改动落在复制出来的用户项目目录里。
- **确定性**：禁用 `Math.random()` / `Date.now()` / `millis()` 等真实时间与环境依赖；
  随机数走 `src/utils/seededRandom.ts` 或 p5 固定种子；所有动画由 `useCurrentFrame()` 推导。
- **音频边界**：不生成音乐、不获取音乐；歌词一律由用户提供（不做 ASR 听写凑歌词）；
  默认不改动**素材文件**（不 ducking、不重混、不变速、不循环）。
  **合成层的音量与包络（`<Audio volume>`）属于混音、不算改动素材**：素材真峰超标（BGM 自身 > -1 dBTP）
  或首尾硬切时，优先在合成层做增益与淡化（方法见 `references/audio-pipeline.md` 音效一节）；素材侧
  加工（`process-audio.py`）只在用户明确要求时执行，并说明副作用（重新编码、不可逆）。
- **Remotion 知识不重复**：API 与写法一律读官方 remotion-* skills；本 skill 只保留工作流、
  渲染基线、跨栈集成坑与音频链路。
- **成片清洁**：交付成片不得包含制作期调试信息——帧号、秒数、分镜 / 场景编号与名称等元数据；
  设计性文字（标题、字幕、文案、叙事标签）不受此限。模板的调试层由 `SHOW_DEBUG_HUD` 控制（默认关闭）。
- **隐私**：交付物与报告不写本机私有路径与凭据；示例一律用相对路径或占位符。

## references 路由

| 什么时候读 | 读哪个 |
|---|---|
| 步骤 0–1：写简报 / 文案 / 场景表 | [references/brief-and-storyboard.md](references/brief-and-storyboard.md) |
| 步骤 1、3：选画风与技术栈 | [references/capability-map.md](references/capability-map.md) |
| 步骤 2：音频解析 / 歌词对齐 / 裁切踩点 / 音床 | [references/audio-pipeline.md](references/audio-pipeline.md) |
| 步骤 3–5：验证命令、阈值、成功门数据 | [references/verify-commands.md](references/verify-commands.md) |
| 步骤 3–4：集成坑、配置基线、确定性 | [references/engineering-pitfalls.md](references/engineering-pitfalls.md) |
| 写具体画面 / 字幕 / 出片 API | 官方 remotion-* skills（先 `remotion-best-practices`） |
