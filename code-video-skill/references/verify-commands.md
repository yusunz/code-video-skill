# 验证命令速查（步骤 3–5）

原则：验证要求写具体——命令 + 阈值 + 判断标准，不写"检查质量"。一条命令一关，
**退出码就是成功门**。脚本路径相对本 skill 根目录；产物路径指到用户项目（如 `videos/my-video/out/full.mp4`）。

## 1 退出码与机器可读输出（四个脚本统一）

| 码 | 含义 | 处理 |
|---|---|---|
| `0` | 通过 | 放行 |
| `1` | 有告警：质检不通过 | 必须处理，或明确记录取舍后再交付 |
| `2` | 用法错误或环境问题 | 先修参数 / 环境（如 ffmpeg 不在 PATH） |

`--json` 时 stdout 只有一份 JSON，`passed` 与退出码一致，`issues[].code` 便于分派：

```powershell
node scripts/verify/verify-video.mjs out/full.mp4 --json | ConvertFrom-Json | Select-Object -ExpandProperty passed
```

ffmpeg / ffprobe 按标准 PATH 解析（同一份完整版构建），找不到时退 `2` 并打印处理办法。

## 2 抽帧与拼图（步骤 3 / 4 的眼睛）

```powershell
# 项目目录内：渲染单个关键帧（单帧约 3.4s，不要等全片）
npx remotion still <composition-id> out/stills/<name>.png --frame=<N>

# 从成片等间隔抽帧拼图（首帧与末帧一定在内）
node scripts/verify/contact-sheet.mjs out/full.mp4 out/check/sheet.png
node scripts/verify/contact-sheet.mjs out/full.mp4 out/check/sheet.png --at 0,104,240,299 --cols 2
```

`--frames 12`（默认）/ `--cols 4` / `--thumb-width 480`；`--at` 按给定帧号与顺序摆放。
告警码：`frame-shortage`（片长不足，抽帧数收窄）、`empty-output`。

## 3 verify-video.mjs —— 规格 / 帧数 / 黑帧 / CRF

```powershell
# 交付前核对 10 秒 300 帧 1080p 基线，并卡死 CRF
node scripts/verify/verify-video.mjs out/full.mp4 --expect-frames 300 --expect-crf 18
```

输出：容器（大小 / 封装 / 时长 / 码率）、视频流（编码 / 分辨率 / 帧率 / 像素格式 / 色彩标注与范围 /
声明帧数 vs **实际解码帧数** / 流时长）、编码参数（x264 SEI 里的 `rc=crf`）、逐帧亮度 YAVG
（最低 / 最高 / 平均 / 黑帧 / 最大跳变）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--black-threshold <0-255>` | `20` | YAVG ≤ 阈值判黑帧（有限范围纯黑 = 16） |
| `--flicker-delta <0-255>` | `0` | 相邻帧亮度跳变告警阈值；`0` = 只报告 |
| `--expect-pix-fmt / --expect-color / --expect-range` | `yuv420p` / `bt709` / `tv` | 基线核对；`any` = 不检查 |
| `--expect-width / -height / -fps / -frames / -duration` | 不传 | 传了才核对 |
| `--expect-crf <N>` | 不传 | 传了才核对（模板未显式设置时 h264 默认 CRF = 18；读不到 SEI 会告警，NVENC 成片读不出属正常） |
| `--duration-tolerance <秒>` | `0.002` | 容器时长与视频流时长允许偏差 |

告警码：`no-video-stream`、`pix-fmt`、`color-tags`、`color-range`、`duration-drift`（AAC 补齐多出约 5 ms，
跑 finalize 修正）、`frame-count`、`frame-count-scan`、`black-frames`、`flicker`、`crf`、`crf-missing`。

## 4 verify-audio.mjs —— 响度 / 真峰 / 静音 / 落点 / 拍点 / 时长

```powershell
node scripts/verify/verify-audio.mjs out/full.mp4                                   # 常规体检
node scripts/verify/verify-audio.mjs out/full.mp4 --max-tp -1 --max-silence 2        # 限真峰与静音段
node scripts/verify/verify-audio.mjs public/audio/bed/bed.wav --expect-duration 30 --beat-grid out/audio-analysis.json --edge-window 5
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `--max-tp <dBTP>` | `-1` | 真峰上限（**以解码后 PCM 为准**，不看容器元数据） |
| `--min-lufs / --max-lufs` | `-40` / `-9` | 集成响度合理区间 |
| `--min-kbps <kbps>` | `64` | AAC 流码率下限；`0` = 不检查 |
| `--silence-noise <dB>` / `--silence-duration <秒>` | `-50` / `0.4` | 静音门限与最短静音段 |
| `--max-silence <秒>` | `0` | 单段静音上限；`0` = 只报告 |
| `--expect-duration <秒>` | 不传 | 容器与音频流各核一遍（音床、裁切踩点用） |
| `--duration-tolerance <秒>` | `0.002` | 容器时长容许偏差（音频流额外放宽 1 个 AAC 帧 ≈ 21 ms） |
| `--beat-grid <JSON>` | 不传 | 拍点网格（`analyze-music.py` 输出）：查打击点偏差与瞬态余量 |
| `--beat-tolerance <秒>` / `--beat-margin-db` / `--beat-min-coverage` | `0.03` / `8` / `0.8` | 偏差中位上限 / 拍点峰值相对拍间电平的最小余量 / 达标拍点比例下限 |
| `--edge-window <ms>` / `--edge-max-db` | `0` / `-40` | 首尾爆音检查窗口（各取首尾一段）；峰值超上限告警 |

拍点检查看两件事（都不看整体响度）：① **偏差**——打击点对到最近拍点的中位偏差（"打在拍上"）；
② **瞬态余量**——拍点窗口峰值减拍间 RMS（"每个拍点上确实有东西响"）。

**判据失效形态（高密度流行曲尤要留意）**：

- **空真值**：高潮段没有人声间隙时"检出打击点 0 个、偏差中位 0.0 ms"看起来完美，实际什么都没测到
  ——**先看检出数量，为 0 时偏差判据无意义**；
- **覆盖率天然偏严**：瞬态余量阈值（默认 8 dB）为干净节奏层设计；全编配流行母带持续人声下，
  覆盖率可能只有 60% 上下——若同源与切点抽查无偏移证据，按"源曲目特性"记录取舍（不要调阈值假装通过）。

**`--beat-grid` 的时间轴从被检音频自身 0 秒算起**：被检的是裁切后的 BGM / 成片时，
**首选 `cut-to-length.py --emit-film-grid out/beatgrid-film.json` 直接产出已减偏移的网格**再喂进来；
或直接检 0 起点的音床。不要手工换算拍点。

告警码：`no-audio-stream`、`audio-bitrate`、`loudness-low`、`loudness-high`、`true-peak`、`silent-track`、
`long-silence`、`no-sounding`、`expect-duration`、`beat-alignment`、`beat-coverage`、`edge-click`。
点状音效、段间大量留白的片子集成响度偏低属正常（默认只在近乎全静音或过响时告警）。

## 5 verify-determinism.mjs —— 帧级一致性

```powershell
node scripts/verify/verify-determinism.mjs out/full.mp4 out/full-b.mp4            # 视频流 framemd5 逐帧
node scripts/verify/verify-determinism.mjs out/full.mp4 out/full-b.mp4 --audio    # 加 PCM 帧
```

同参数再渲染一份 A/B（约 +20 s / 300 帧），逐帧比对解码帧；同时检查尺寸 / 时基 / 帧数 / pts 漂移。
**MP4 文件 SHA256 只记录、不作判据**（编码基本流有 ±0.1% 漂移，解码帧才是判据）。
告警码：`structure`、`frame-count`、`video-frames`、`video-pts`、`audio-count`、`audio-frames`、`audio-pts`、`no-audio-stream`。

## 6 三档最小闭环

```powershell
# 场景自检（步骤 3，每个场景）
npx remotion still <composition-id> out/stills/<scene>.png --frame=<N>     # 看画面
npm run lint                                                                # eslint + tsc

# 集成验证（步骤 4）
npm run render:raw
node scripts/verify/verify-video.mjs out/full-remotion-raw.mp4              # 黑帧 / 帧数（raw 未收尾，duration-drift 属预期）
node scripts/verify/contact-sheet.mjs out/full-remotion-raw.mp4 out/check/sheet.png

# 成片交付（步骤 5）
npm run render:full
node scripts/verify/verify-video.mjs out/full.mp4 --expect-frames <总帧数>
node scripts/verify/verify-audio.mjs out/full.mp4
node scripts/verify/contact-sheet.mjs out/full.mp4 out/check/sheet.png
node scripts/verify/verify-determinism.mjs out/full.mp4 out/full-b.mp4      # 需要复现证据时
```

## 7 成功门数据参考（实测基线，供判断"是否正常"）

| 项 | 判据 / 阈值 | 实测基线 |
|---|---|---|
| 规格与编码 | 1920×1080 / h264 / yuv420p / bt709 / tv | 模板 10 s 成片全项通过 |
| 帧数 | `--expect-frames` 与解码帧数一致 | 10 s @ 30fps = 300 帧 |
| 容器时长 | 与视频流一致（±0.002 s） | finalize 后 10.000000 s |
| 黑帧 | YAVG > `--black-threshold`（默认 20） | 模板 300 帧最低 24.75（3D 段最低 28.26） |
| 集成响度 | `-40 ~ -9 LUFS` 区间内 | 只挂音效 -18.2 LUFS；音效 + 音床 -20.9 LUFS；纯音床 -28.0 LUFS |
| 真峰（解码后） | ≤ `-1 dBTP` | 模板 -2.4 dBTP；挂音床 -2.98 dBTP |
| AAC 码率 | ≥ 64 kbps | 模板 48 kHz / AAC LC 通过 |
| 音床拍点 | 偏差中位 ≤ 30 ms、瞬态余量 ≥ 8 dB、覆盖率 ≥ 0.8 | 8.3 ms / 16.4 dB / 59 个拍点 59 达标 |
| 首尾爆音 | `--edge-window` 内峰值 ≤ `-40 dB` | 音床首尾 -∞ dBFS |
| 帧级复现 | still SHA256 相同 + framemd5 全同 | swangle 基线下 300/300 帧一致 |

## 8 常见告警的处理方向

| 告警码 | 先查什么 |
|---|---|
| `duration-drift` | 是不是忘了跑 `npm run render:full`（finalize 收尾）；再对一下帧率与帧数 |
| `black-frames` | 定位帧号 → 抽该帧看画面；3D / WebGL 段白屏、图层透明都会造成 |
| `loudness-low` | 点状音效 + 长留白属正常；整片近乎静音则检查音频是否真的挂上 |
| `true-peak` | 降总增益（模板 `SFX_MASTER_VOLUME` 一处控制）或降音频素材电平 |
| `beat-alignment` / `beat-coverage` | 音床没按拍点铺，或 `--beat-grid` 的时间轴没做偏移 |
| `edge-click` | 检查首尾是否截在半波形上；必要时用 `process-audio.py --fade-in/--fade-out`（需用户同意） |
| `frame-count` | 渲染被中断、段落帧数之和 ≠ 总帧数，或 composition 与配置不一致 |

**exit 1 的分诊规则**：能通过**合成层增益 / 淡化**消除的告警（响度、真峰、首尾爆音）→ 必须修；
修不掉的（如 `beat-coverage` 的源曲目特性）→ 按"明确记录取舍"处理，写进 QC 报告的决策记录。

## 9 音画同步抽查（步骤 4，无现成命令）

判据 = **同源 + 抽查**，三种证据叠加（实测路径）：

1. **同源检查**：切点帧号、字幕 / 歌词行起点、音效落点全部来自同一份数据链下游
   （`audio-analysis.json` → `cut-plan.json` → `config.ts` / `lyrics.json`）；
   有音床的场景另核对"切点秒数同时喂给草稿与 `bed --transitions`"；
2. **切点帧抽查**：每个切点的前 1 帧 / 当帧 / 后 1 帧拼图，确认换场确实发生在切点（`contact-sheet --at`）；
3. **音频侧**：对成片跑 `verify-audio out/full.mp4 --beat-grid out/beatgrid-film.json`，
   偏差中位 ≤ 30 ms 证明打击点压在网格上（成片网格用 `--emit-film-grid` 生成）。

## 10 质检报告骨架（QC-报告.md，落盘到用户项目）

报告放**用户视频工程目录内**（如 `videos/my-video/QC-报告.md`）；用户点名要的交付文档（如摩擦点清单）
放用户指定位置（如项目根）。项目无 git 时无需入库，落盘即可。

- **成片**：路径 / 规格（分辨率 / fps / 帧数 / 时长 / 编码）
- **时间轴**：场景表（帧区间与切点依据）
- **质检结果**：每个脚本一行（命令 → 退出码 → 关键数值）
- **决策记录**：取舍（增益数值、淡化帧数、大特效清单、已知告警的处理方式）
- **产物清单**：成片 / 证据（拼图、stills）/ 数据（analysis、cut-plan、网格）
