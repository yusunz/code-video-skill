# code-video-skill 模板工程 v0

用代码做视频的起手工程：**Remotion 负责合成与渲染，three.js 负责 3D 帧，p5.js 负责手绘帧，
Tone.js 负责把音效离线合成成 WAV**。模板里不带任何具体画面的创作内容，只保留配置基线、
适配层、音效工具链，以及一个 10 秒的最小示例（p5 与 three 各 5 秒，带 3 个音效）。

## 模板纪律（先读这一条）

- **`template/` 是真源，不许在里面直接改片子。** 所有创作改动都落在用户项目目录里。
- 起新片子 = 复制一份到用户项目目录，再在副本里改；副本与模板互不影响。
- 只有当你要升级**所有**片子时才动模板，而且改完必须重跑一遍模板验收（见文末）。
- 配置基线（PNG 中间帧 + swangle + bt709 + h264 + finalize）不得绕过 —— 见下文「配置基线」。

## 前置要求

| 项 | 说明 |
|---|---|
| Node.js | 实测 v24.15.0（Node 20 及以上） |
| npm | 实测 11.12.1；依赖已精确锁版本，`package-lock.json` 一并入库 |
| Chrome Headless Shell | 首次渲染时 Remotion 自动下载到 `node_modules/.remotion`（约 270MB），之后复用缓存 |
| ffmpeg / ffprobe | **必须在 PATH 里**：`render:full` 的收尾封装与质检命令都要用（实测 9.0.2 full build） |

## 起一条新视频：五步

```powershell
# 1) 复制模板到用户项目目录（排除依赖与产物）
robocopy .\template ..\videos\my-video /E /XD node_modules out build     # Windows
# cp -r template ../videos/my-video && rm -rf ../videos/my-video/{node_modules,out,build}   # macOS / Linux

cd ..\videos\my-video
npm ci
```

```powershell
# 2) 改配置：标题、时长、段落、音效落点 —— 只动 src/config.ts
#    （标题改 VIDEO_TITLE；段落秒数改 SEGMENT_DURATION_IN_SECONDS，帧数会自动换算并自校验）

# 3) 抽帧自检：先看画面，再谈渲染
npm run still:p5        # p5 段第 75 帧 → out/stills/p5.png
npm run still:three     # three 段第 75 帧 → out/stills/three.png
npm run still:cover     # 成片第 240 帧 → out/cover.png
npm run dev             # 需要连续预览时开 Remotion Studio
```

```powershell
# 4) 成片渲染（Remotion 渲染 + 收尾封装，约 20-30s / 300 帧 / 1080p）
npm run render:full     # → out/full.mp4（容器时长精确等于视频流时长）

# 5) 质检：规格 / 黑帧 / 响度 / 落点（命令见下文「质检」一节）
```

## 改片子的三处

| 你想改什么 | 改哪里 |
|---|---|
| 标题 / 时长 / 段落长度 / 段落切换 / 音效落点 / 随机种子 | `src/config.ts`（全片唯一事实来源） |
| 画面 | `src/scenes/ExampleP5Scene.tsx`（p5）、`src/scenes/ExampleThreeScene.tsx`（three）；段落装配在 `src/segments.tsx` |
| 音效本体 | `src/audio/sfx-definitions.ts`（音效即代码）→ `npm run sfx` 重新生成 WAV |

加段落：在 `src/config.ts` 补时长与起始帧（模块加载时会校验总帧数），再在 `src/Main.tsx`
补一个 `<Sequence>`、在 `src/Root.tsx` 补一个自检用的单段落 composition（可选）。

## 目录结构

```
template/
├─ remotion.config.ts        渲染配置基线（rspack / swangle / PNG 中间帧 / bt709 / h264）
├─ src/
│  ├─ config.ts              规格与时间轴：全片唯一的事实来源（含总帧数自校验）
│  ├─ Root.tsx               composition 注册：Main + 单段落自检用 SegP5 / SegThree
│  ├─ Main.tsx               成片时间轴：段落 Sequence + 音效轨
│  ├─ segments.tsx           段落装配：场景层 + HUD 层
│  ├─ theme.ts               配色 / 字体 / rgba 助手
│  ├─ components/
│  │  ├─ P5Canvas.tsx        p5 2.x 适配层（instance mode + noLoop + 固定种子 + delayRender）
│  │  ├─ rough.ts            rough.js 的 canvas 缓存（与 p5 共用同一个 2D context）
│  │  └─ Hud.tsx             Remotion DOM 图层：标题 / 进度条（帧号与分镜卡为调试层，SHOW_DEBUG_HUD 控制，默认关）
│  ├─ scenes/                最小示例画面（换成自己的画面时替换这两个文件）
│  ├─ audio/                 音效链：sfx-definitions.ts（定义）+ wav.ts（编码）+ render-client.ts（浏览器入口）
│  │                         + bed-plan.ts / bed-render.ts（音床编排与合成）
│  └─ utils/seededRandom.ts  mulberry32 定点随机（与 Math.random 无关，逐帧可复现）
├─ scripts/
│  ├─ bundle-sfx.mjs         esbuild 打包音效源码为浏览器 bundle
│  ├─ generate-sfx.mjs       无头 Chrome + Tone.Offline 渲染 WAV → public/audio/sfx/
│  ├─ generate-bed.mjs       无音频兜底 BGM：按拍点铺一条完整音床（npm run bed）
│  └─ finalize-mp4.mjs       纯流拷贝收尾：修掉 AAC 补齐造成的容器时长偏差
├─ public/audio/sfx/         音效资产（进版本库，复制模板后开箱即可渲染）
└─ out/                      渲染产物（不进版本库）
```

## 命令

```powershell
npm ci                 # 按 lockfile 精确安装
npm run dev            # Remotion Studio 实时预览
npm run lint           # eslint + tsc（提交前必跑）
npm run sfx            # 音效源码 → public/audio/sfx/*.wav（先 bundle 后离线渲染）
npm run bed -- --duration=30 [--analysis=…] [--transitions=…]   # 无音频兜底 BGM → public/audio/bed/bed.wav
npm run still:p5       # 抽帧自检：p5 段
npm run still:three    # 抽帧自检：three 段
npm run still:cover    # 抽帧自检：成片封面帧
npm run render:raw     # 只渲染，不收尾 → out/full-remotion-raw.mp4
npm run render:full    # 渲染 + 收尾封装 → out/full.mp4（交付用）
npm run build          # remotion bundle（打包产物，供离线部署排查）
```

音效已随模板入库，开箱即可 `render:full`；只有改 `sfx-definitions.ts` 时才需要重跑 `npm run sfx`。

## 无音频兜底 BGM（`npm run bed`）

用户没提供音乐时，用音效元素铺一条完整音床，保证成片不静音。

```powershell
# 30 秒音床，固定 120 BPM
npm run bed -- --duration=30

# 有拍点数据：按 analyze-music.py 的 audio-analysis.json 铺（推荐）
npm run bed -- --duration=30 --analysis=out\audio-analysis.json --intensity=0.6

# 与成片段落对齐：--transitions 传剪辑点（riser 提前 2 拍抬起、impact 压在切换点上）
npm run bed -- --duration=10 --transitions=5
```

输出 `public/audio/bed/bed.wav`（时长精确到样本，峰值默认归一化到 -3 dBFS），挂载：

```tsx
<Audio src={staticFile("audio/bed/bed.wav")} premountFor={fps} />
```

- 三层编排：节奏层（底鼓落强拍 / 滴答落拍点，强度高时补反拍）、氛围层（持续垫音，
  有能量数据时跟随能量起伏）、点缀（riser 抬起 + impact 压在切换点 + 收尾音贴片尾）。
- `--intensity 0~1` 控制密度与响度；`--peak-db` 改归一化目标；`--mp3` 顺带转一份试听用 MP3；
  `--transition-every` 在没给 `--transitions` 时按固定间隔自动铺切换点。
- 显式切换点只在 60ms 容差内吸附拍点——切换点是剪辑点，impact 必须压在那一帧上。
- 音床全用振荡器合成（不含噪声源），重跑差异 ≤ 1 LSB；但资产仍以落盘那一份为准（同 `npm run sfx`）。
- 改编排只碰 `src/audio/bed-plan.ts`（纯规则、不碰 Tone），改音色只碰 `src/audio/bed-render.ts`。

## 配置基线（不得绕过）

来自 `remotion.config.ts`，每一项都有实测理由：

```ts
Config.setRspack(true);
Config.setChromiumOpenGlRenderer("swangle"); // 字节级可复现的必要条件
Config.setVideoImageFormat("png");           // JPEG 中间帧会产出 yuvj420p(pc) 全范围色彩
Config.setColorSpace("bt709");
Config.setCodec("h264");
```

配合 `scripts/finalize-mp4.mjs`：渲染后用**纯流拷贝**丢掉 AAC 补齐的最后一个包，
让容器时长精确等于视频流时长（不重新编码）。

## 硬性约定（写代码时别破坏）

- **p5.js**：只用 `new p5(sketch, container)` instance mode；`setup()` 里必须 `noLoop()`，
  画面由 `useCurrentFrame()` 驱动的 `redraw()` 决定；每帧重绘前重置 `randomSeed` /
  `noiseSeed`；只用 2D canvas，不开 WEBGL。
- **three.js**：只用 `@remotion/three` 的 `<ThreeCanvas>`，禁用 `useFrame()`，所有位移与旋转
  都由帧号推导；移动相机后必须 `camera.updateMatrixWorld()` 再 `lookAt()`。
- **Tone.js**：绝不在渲染期生成音频。音效一律 `Tone.Offline()` → WAV → `<Audio>` 挂载。
- **确定性**：渲染后端固定 `swangle`；不要引入 `Math.random()`、`Date.now()`、`millis()` 等
  真实时间 / 环境依赖，随机数走 `src/utils/seededRandom.ts` 或 p5 的固定种子。

## 质检

四个质检脚本在仓库的 `scripts/verify/`（**属于仓库工具层，不在模板里、不会被复制到用户项目**），
从仓库根目录运行、用路径指到本项目的产物即可；退出码 `0` 通过 / `1` 有告警 / `2` 用法或环境问题。

```powershell
# 规格 + 解码帧数 + 逐帧亮度（黑帧）：交付前必跑
node scripts/verify/verify-video.mjs out/full.mp4 --expect-frames 300

# 响度 / 真峰（解码后）/ 静音段与发声落点；挂音床或裁切过音频时加时长核对
node scripts/verify/verify-audio.mjs out/full.mp4 --expect-duration 10 --edge-window 5

# 帧级复现：同参数再渲染一份（out/full-b.mp4），逐帧比 framemd5
node scripts/verify/verify-determinism.mjs out/full.mp4 out/full-b.mp4

# 肉眼过一遍：等间隔抽帧拼图（首末帧一定在内）
node scripts/verify/contact-sheet.mjs out/full.mp4 out/check/sheet.png

# 音床 / 卡点向成片再加拍点检查：偏差 + "每个拍点上都有东西响"的瞬态余量
node scripts/verify/verify-audio.mjs public/audio/bed/bed.wav --expect-duration 30 --beat-grid out/audio-analysis.json
```

口径、阈值与告警码见 `scripts/verify/README.md`（`--help` 也有）；`--json` 时 stdout 只有一份结构化结果，
便于工作流按 `issues[].code` 分派。模板示例的实测基线：只挂音效时 -18.2 LUFS / 真峰 -2.4 dBTP；
挂上音床后（音床铺满全片 + 三个音效）集成 -20.9 LUFS / 真峰 -2.98 dBTP、全片无静音段、首尾无爆音。

## 踩坑与结论（来自两轮冒烟实测）

1. **`camera.lookAt()` 用的是上一帧的位置**：three 的 `lookAt()` 以 `matrixWorld` 为准，
   而它只在渲染时刷新。顺序必须是 `position.set()` → `updateMatrixWorld()` → `lookAt()`。
2. **p5 2.x 的 `setup()` / `redraw()` 是异步的**：靠 `delayRender()`（渲染阶段登记）+
   `continueRender()`（`setup()` 完成时）保证首帧画完才截图，组件提前卸载也要释放句柄。
3. **p5 2.x 的 color 解析对 8 位十六进制不可靠**：统一用 `theme.ts` 的 `rgba()` 拼字符串。
4. **rough.js 与 p5 共用同一个 2D context**：`rough.canvas(el)` 拿到的就是 p5 的 context，
   调用顺序即 z 序；`rough.ts` 按 canvas 缓存实例。
5. **Tone.js**：`MetalSynth` 没有 `frequency` 构造参数；`Tone.Offline()` 会先建一次实时
   AudioContext（无害副作用，但必须保证浏览器可用）；尾音用 `FeedbackDelay` 而不是 `Freeverb`。
6. **确定性是"配置"不是"默认"，而且分两层**：默认 GPU 后端两次渲染会有 1 LSB 级
   像素差异，固定 `swangle` 后**帧级**完全一致（同帧 still 的 SHA256 相同、全量渲染
   解码后的 300 帧与音频帧逐一相同，代价约 +7s / 300 帧）。但**MP4 文件本身**在不同
   渲染之间会有字节漂移：实测 5 次全量渲染，解码帧全部一致，而 H.264 基本流大小在
   3710808–3714440 字节之间浮动（±0.1%，编码器 x264 core 165 设置完全相同，
   `--disallow-parallel-encoding` 也未能消除）。所以**验收用 still SHA256 + framemd5，
   不要用 MP4 文件哈希**（配方见下文）。
7. **AAC 编码补齐会让容器时长多出几毫秒**：`finalize-mp4.mjs` 丢掉最后一个包并原样拷贝。
8. **Remotion 的图片序列参数**：`--frames=145-155` 出的是 mp4；要出 PNG 必须加 `--sequence`。
9. **音频资产的生成不是逐字节可复现的**：带噪声源的音效差异明显（impact 实测两次生成有
   56% 的样本不同、最大 -16dB；whoosh 的合成峰值在 -12 ~ -15 dBFS 间浮动），全振荡器的
   配方（outro、音床）重跑只差 ±1 LSB（-90dBFS 量级，音床实测 0.018% 的样本）。
   所以 WAV 资产只生成一次、以落盘那一份为准，不要靠"重新生成"来复现旧成片。

## 模板验收（升级模板后必跑）

复制 `template/` 到临时目录 → 改 `VIDEO_TITLE` → `npm ci` → `npm run lint` → `npm run render:full`，
确认产出一条带音效的 10 秒成片（`ffprobe` 时长与帧数正确），再提交模板变更。
