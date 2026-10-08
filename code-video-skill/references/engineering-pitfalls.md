# 工程坑与配置基线（步骤 3–4）

这些结论来自多轮生产实测，出问题先在这里找。Remotion 的通用写法
不在本文件范围内——那部分读官方 remotion-* skills。

## 1 渲染配置基线（不得绕过）

`assets/template/remotion.config.ts` 五项 + finalize 收尾，是帧级可复现与编码合规的前提：

| 配置 | 值 | 为什么 |
|---|---|---|
| rspack | `true` | 与冒烟工程一致的打包路径，Windows + p5 2.x 已验证 |
| OpenGL 后端 | `swangle` | 默认 GPU 后端有 1 LSB 级差异（300 帧中 50 帧不同）；固定 swangle 才能帧级复现 |
| 中间帧格式 | `png` | JPEG 中间帧会产出 `yuvj420p(pc)` 全范围色彩 |
| 色彩空间 | `bt709` | 交付标准色彩标注 |
| 编码 | `h264` | libx264，CRF 从 SEI 可读，便于质检核对 |
| 收尾 | `assets/template/scripts/finalize-mp4.mjs` | AAC 编码补齐会让容器时长多出约 5 ms（10.005s）；纯流拷贝丢掉最后一个包，得到 10.000000s |

换分辨率 / 帧率 / CRF 等交付参数可以（改副本），换掉以上五项不行。
质量与成本的现实：300 帧 1080p 全量渲染 15–24 s（swangle 约 +7 s），单帧 still 约 3.4 s——
"逐场景抽帧自检 → 全量渲染"两段式流程几乎零负担。

## 2 帧级复现（确定性）

- 判据是**帧级**：同帧 still 的 SHA256 一致 + 全量渲染的 `framemd5` 逐帧一致；
- **MP4 文件哈希不作判据**：H.264 基本流在不同次渲染间有 ±0.1% 字节漂移（5 次实测），解码帧却完全一致；
- 音效 / 音床 WAV 以**落盘入库的那份**为准：带噪声源的音效重跑差异明显（impact 两次生成 56% 样本不同），
  全振荡器配方（outro / 音床）只差 ±1 LSB——但都不要靠"重新生成"复现旧成片；
- 逻辑层确定性靠纪律：不用 `Math.random()` / `Date.now()` / `millis()`；随机走
  `src/utils/seededRandom.ts`（mulberry32）或 p5 的 `randomSeed` / `noiseSeed`；动画全部由 `useCurrentFrame()` 推导。
  三种常见用法：**静态分布** `createSeededRandom(seed)`（粒子初始位置等，全片一致）；
  **逐帧噪声** `createSeededRandom(seed + frame)`（数字抖动等，每帧变化但可复现）；
  **平滑轨迹** 固定 seed + 帧号插值（`interpolate(frame, …)`）。

## 3 跨栈集成坑（按症状查）

1. **three：相机 `lookAt()` 用的是上一帧的位置**。`lookAt()` 以 `matrixWorld` 为准，而它只在渲染时刷新；
   轨道运动时主体被挤出画面中心（实测第 105 / 194 帧偏移）。正确顺序：
   `camera.position.set(...)` → `camera.updateMatrixWorld()` → `camera.lookAt(...)`。
2. **p5 2.x 的 `setup()` / `redraw()` 是异步的**：`redraw()` 在微任务里调用 `draw()`，
   不能假设"调用即完成"。用 `delayRender()`（渲染阶段登记）+ `continueRender()`（`setup()` 完成时）
   保证首帧画完才截图；组件提前卸载要释放句柄，避免渲染卡死。
3. **p5 2.x 包结构与 1.x 不同**：入口是 ESM 的 `dist/app.js`，类型随包发布，rspack 直接吃下、无需 alias；
   不要按 1.x 的 `p5/lib/p5.min.js` 老写法接线。
4. **p5 2.x 的 color 解析对 8 位十六进制（`#rrggbbaa`）不可靠**：颜色统一走 `theme.ts` 的 `rgba()` 字符串。
5. **rough.js 与 p5 共用同一个 2D context**：`rough.canvas(el)` 拿到的就是 p5 的 context，
   二者可以混用，**调用顺序即 z 序**；`RoughCanvas` 按 canvas 元素用 `WeakMap` 缓存，
   每个形状带固定 `seed`，保证每帧手绘线条一致。
6. **Tone.js 三个坑**：`MetalSynth` 没有 `frequency` 构造参数（频率走 `triggerAttackRelease("C3", …)` 的音符参数）；
   `Tone.Offline()` 会先建一次实时 `AudioContext`（无害副作用，但浏览器必须可用）；
   尾音用 `FeedbackDelay` 而不是 `Freeverb`（后者是 AudioWorklet 实现）。
   渲染期**绝不**现场生成音频，一律离线渲染成 WAV 资产。
7. **three 只用 `@remotion/three` 的 `<ThreeCanvas>`**：它把 R3F 的 `frameloop` 设为 `never`、由 Remotion 每帧推进，
   **禁用 `useFrame()`**；`three` 与 `@react-three/fiber` 是它的 peer 依赖，模板已显式锁版本。
8. **Remotion 图片序列参数**：`remotion render <id> <dir> --frames=145-155` 出的是 mp4；
   要出 PNG 必须加 `--sequence`（配 `--image-sequence-pattern`），或直接用 `remotion still`。
9. **无害告警**：`THREE.Clock: This module has been deprecated`（来自 @react-three/fiber 内部）与
   p5 的 `describe()` 提示不影响渲染，不要为此改架构。
10. **模板 HUD 是全屏覆盖层，场景内容必须避让**：`components/Hud.tsx` 由顶部横条、左下信息卡与底部
    进度条组成。场景文字 / 元素不得进入这些区域，也不得越出 1920×1080 边界——冷启动实测踩中：
    右下日志行溢出画面右缘（抽帧目检发现）。右上帧号与左下分镜卡是**调试层**
    （模板 `SHOW_DEBUG_HUD`，默认关闭）——交付前确认保持关闭；自绘 HUD 时同样先划好"内容安全区"。
11. **别依赖 `P5Canvas` 的 `progress` 当"段落进度"**：它的分母来自 `useVideoConfig().durationInFrames`。
    冷启动实测：在 60 帧的段落 Sequence 里运行时，progress 峰值只到 59/299（分母是全片 300 帧），
    动画会**静默走不完**（不报错，只是动得不对）。可靠做法：在 draw 回调里按段落帧数自行归一化。
12. **渲染卡死（timeout）没有告警可看**：verify 脚本管不到"渲染进程挂住"。先定位停住的帧号，
    再查该帧路径上的循环与几何函数——实测踩中：rough.js `arc()` 起点角 = 终点角导致确定性死循环。
    嫌疑模式：角度等于角度、零步长循环、无穷逼近；给循环加上限或 epsilon 判断。
13. **p5 2.x 与 1.x 有 API 断层**：模板锁 2.3.4——`quadraticVertex` 已移除；`text(str,x,y,size)`
    的四参形式是"盒子模式"（字号参数不生效、文字静默变形）。"参数没报错但效果不对"时先查 2.x 文档。

## 4 起项目的操作细节

- **复制模板排除 `node_modules/`、`out/`、`build/`**，然后 `npm ci` 重装：
  `node_modules` 体积大，且曾经出现过多线程复制（`robocopy /MT:16`）漏掉整个目录的事故；
  必须在副本内重装而不是搬依赖。
- **只改副本**：`assets/template/` 是共享真源，任何创作改动落在用户项目目录；
  要升级所有片子时才改模板，且必须重跑模板验收。
- **`npm run lint`（eslint + tsc）是编译期验证回路的一环**：类型错误往往先于渲染暴露接线问题
  （实例：`P5Canvas` 的 `transparent` 属性声明了却没使用，由 eslint 抓出）。
- **中文字体先验证再排版**：字体没真正加载会静默 fallback 到系统字体，改一行标题后仍要抽一帧确认
  字形正确；本地字体在 Remotion 侧用 `local-fonts` 方式加载（读 remotion-markup 的字体章节）。
- **ffmpeg / ffprobe 必须在标准 PATH 中**：工具只做标准 PATH 查找，找不到时"报错 + 指引安装"；
  不为特定机器扫描注册表或展开 PATH 变量（环境适配边界）。
- **含中文 / 特殊字符的数据文件一律显式 UTF-8**：PowerShell 5.1 读 UTF-8 JSON 会按 GBK 解码报错
  （`UnicodeDecodeError`）；Python 里 `open(..., encoding="utf-8")`，命令行优先 pwsh 7。
- **关键判断以数值为准，目视仅作辅助**：图片查看工具可能返回错位内容（三轮实测：读 A 帧显示 B 帧、
  大面积串图 / 复读旧图）。可靠替代流程：拼图（`contact-sheet`）→ **在图内加"盐"**（把帧号 /
  场景名直接烧进画面，防串图误读）→ HUD 区域裁剪放大 → 像素统计（全图均值亮度 / 暗列占比 /
  文字位置，PIL 测色）→ 与 verify 脚本交叉复核；切点核对可用亮度曲线证明换场确实发生在切点。
- **从成片抽帧注意 ffmpeg 9 的变更**：`-vsync` 已移除，改用 `-fps_mode`；写 `-ss <t> -frames:v 1` 即可。

## 5 交付与隐私

- `out/`、`node_modules/`、`build/` 不进 git；质检报告（如 `QC-报告.md`）进 git（项目有 git 时）；媒体产物单独交付给用户。
- 报告与代码不写本机私有路径、凭据、私人服务器信息；`analyze-music.py` 的 `meta.source_file`
  只写文件名，就是为了让 JSON 可以安全带出本机——其余产物照此办理。
