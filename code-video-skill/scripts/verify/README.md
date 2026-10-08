# scripts/verify —— 质检脚本集

质检回路的命令行层：**一条命令一关，退出码就是成功门**。全部是 Node ESM，只用 Node 内置模块，
不引入任何 npm 依赖；滤镜走系统 ffmpeg 完整版（`signalstats` / `loudnorm` / `silencedetect` / `framemd5`）。

| 脚本 | 作用 | 判据 |
|---|---|---|
| `verify-video.mjs` | 成片体检 | 规格 / 解码帧数 / 逐帧亮度（黑帧）/ x264 CRF |
| `verify-determinism.mjs` | 帧级一致性 | 两条成片的视频流 `framemd5` 逐帧比对 |
| `verify-audio.mjs` | 音频体检 | 集成响度 / 真峰 / 静音段 / AAC 参数与码率 / 时长核对 / 拍点对齐 / 首尾边界 |
| `contact-sheet.mjs` | 等间隔抽帧拼图 | 产出肉眼可查的 PNG |
| `lib.mjs` | 公共库 | ffmpeg 定位 / 子进程封装 / 参数解析 / 输出格式化 |

除 `contact-sheet.mjs` 写出一张 PNG 外，其余脚本都是只读的（不改动输入成片）。

## 退出码约定（四个脚本统一）

| 码 | 含义 | 典型触发 |
|---|---|---|
| `0` | 通过 | 全部判据都在阈值内 |
| `1` | 有告警：质检不通过 | 黑帧、帧级不一致、真峰超限、缺帧、静音轨…… |
| `2` | 用法错误或环境问题 | 参数缺失 / 非法、文件不存在、找不到 ffmpeg |

`--json` 时 **stdout 只有一份 JSON**（标题、备注等人类信息不混进 stdout），`passed` 字段与退出码一致，
`issues[]` 里每条带 `code`，便于工作流按码分派。四个脚本的 JSON 结构都是
`{ tool, subjects, passed, issues, notes, …明细, sections }`。

```powershell
node scripts/verify/verify-video.mjs out/full.mp4 --json | ConvertFrom-Json | Select-Object -ExpandProperty passed
```

## ffmpeg / ffprobe 定位

`lib.mjs` 按名字直接调用，依赖**标准 PATH** 解析到成对的 ffmpeg + ffprobe（同一份完整版构建，避免混版本）。找不到时退 `2`，并打印处理办法——环境问题在本机解决，工具不读取特定环境变量或注册表。

定位结果会写进报告（版本 + 来源），出问题时先看这一行：

```
备注
  · ffmpeg 9.0.2 · PATH（按名字直接调用）
```

## verify-video.mjs

```powershell
node scripts/verify/verify-video.mjs <mp4> [选项]

# 例：交付前核对 10 秒 300 帧 1080p 基线，并卡死 CRF
node scripts/verify/verify-video.mjs out/full.mp4 --expect-frames 300 --expect-crf 18
```

输出四组信息：容器（大小 / 封装 / 容器时长 / 总码率）、视频流（编码 / 分辨率 / 帧率 / 像素格式 /
色彩标注与范围 / 声明帧数 vs **实际解码帧数** `count_frames` / 流时长 / 码率）、编码参数
（从 x264 的 SEI 里读 `rc=crf crf=…`）、逐帧亮度 YAVG（最低 / 最高 / 平均 / 黑帧 / 最大跳变）。

主要选项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--black-threshold <0-255>` | `20` | YAVG ≤ 阈值即判黑帧（有限范围视频的纯黑是 16） |
| `--flicker-delta <0-255>` | `0` | 相邻帧亮度跳变告警阈值；`0` = 只报告 |
| `--expect-pix-fmt / --expect-color / --expect-range` | `yuv420p` / `bt709` / `tv` | 基线核对；`any` = 不检查 |
| `--expect-width / -height / -fps / -frames / -duration` | 不传 | 传了才核对 |
| `--expect-crf <N>` | 不传 | 传了才核对（读不到 SEI 会告警） |
| `--duration-tolerance <秒>` | `0.002` | 容器时长与视频流时长的允许偏差 |

告警码：`no-video-stream`、`pix-fmt`、`color-tags`、`color-range`、`duration-drift`（AAC 补齐会多出约 5ms，
需跑 finalize）、`frame-count`、`frame-count-scan`、`black-frames`、`flicker`、`crf`、`crf-missing`、
`expect-width/-height/-fps/-frames/-duration`。

## verify-determinism.mjs

```powershell
node scripts/verify/verify-determinism.mjs <mp4a> <mp4b> [--audio] [--json]
```

对两条成片的视频流做 `framemd5`（**解码帧**的 MD5），逐帧按序比对，同时检查尺寸 / 时基 / 帧数 /
pts 漂移；`--audio` 额外比对音频流的 PCM 帧。

**MP4 文件哈希不作判据**：编码基本流在不同次渲染之间有 ±0.1% 的字节漂移，而解码帧完全一致——
所以报告里的 SHA256 只放在"文件（仅记录）"一节，不参与判定。

告警码：`structure`（尺寸 / 时基不同）、`frame-count`、`video-frames`、`video-pts`、
`audio-count`、`audio-frames`、`audio-pts`、`no-audio-stream`。

## verify-audio.mjs

```powershell
node scripts/verify/verify-audio.mjs <mp4> [选项]

# 例：要求真峰守住 -1 dBTP，并限制单段静音不超过 2 秒
node scripts/verify/verify-audio.mjs out/full.mp4 --max-tp -1 --max-silence 2

# 例：音床 / 裁切过的音频——时长必须精确，并检查拍点对齐与首尾爆音
node scripts/verify/verify-audio.mjs public/audio/bed/bed.wav --expect-duration 30 --beat-grid out/audio-analysis.json --edge-window 5
```

输出：AAC 参数与码率（profile / 采样率 / 声道 / 流码率 / 容器总码率 / 音频帧数）、
`loudnorm` 的集成响度与 LRA、**真峰（以解码后 PCM 为准，不用容器元数据）**、
`silencedetect` 的静音段与静音占比，并顺带给出反面——**发声段**（音效落点）；
传了对应选项时再加时长核对、拍点对齐与首尾边界三节。WAV / MP4 都能体检。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--max-tp <dBTP>` | `-1` | 真峰上限，超过即告警 |
| `--min-lufs / --max-lufs` | `-40` / `-9` | 集成响度合理区间 |
| `--min-kbps <kbps>` | `64` | AAC 流码率下限；`0` = 不检查 |
| `--silence-noise <dB>` | `-50` | 静音门限 |
| `--silence-duration <秒>` | `0.4` | 静音段最短时长 |
| `--max-silence <秒>` | `0` | 单段静音上限；`0` = 只报告 |
| `--expect-duration <秒>` | 不传 | 期望时长：容器与音频流各核一遍（音床、裁切踩点用） |
| `--duration-tolerance <秒>` | `0.002` | 容器时长容许偏差；音频流额外放宽 1 个编码帧（AAC ≈ 21ms） |
| `--beat-grid <JSON>` | 不传 | 拍点网格（`analyze-music.py` 的输出）：检查打击点偏差与拍点瞬态余量 |
| `--beat-tolerance <秒>` | `0.03` | 打击点与最近拍点的偏差上限（看中位值） |
| `--beat-margin-db <dB>` | `8` | 拍点上瞬态峰值相对拍间电平的最小余量 |
| `--beat-min-coverage <0-1>` | `0.8` | 达标拍点的比例下限 |
| `--edge-window <ms>` | `0` | 首尾爆音检查窗口（各取首尾一段）；`0` = 关闭 |
| `--edge-max-db <dB>` | `-40` | 首尾窗口内的峰值上限 |

**拍点检查的两个判据**（都不看整体响度，只看节奏层的形状）：

1. **偏差**：把 RMS 包络上检出的打击点对到最近拍点，取中位偏差——衡量"打在拍上"；
2. **瞬态余量**：每个拍点窗口的**峰值** 减去 拍间窗口的 RMS——衡量"每个拍点上确实有东西响"。
   用峰值而不是窗口 RMS：滴答这类短音摊进 60ms 窗口会被持续垫音稀释，判据会变钝。

实测参考：模板音床 `npm run bed`（30 秒 / 120 BPM / `--analysis` 真实拍点）——偏差中位 8.3ms、
瞬态余量中位 16.4dB、59/59 拍点达标、首尾窗口 -∞ dBFS、容器时长偏差 0.000000s、
集成响度 -28.0 LUFS / 真峰 -2.99 dBTP。

点状音效、段间大量留白的片子集成响度基数偏低属正常（模板示例实测 −18.2 LUFS / −2.4 dBTP），
所以默认只在"近乎全静音"或"过响"时告警。

告警码：`no-audio-stream`、`audio-bitrate`、`loudness-low`、`loudness-high`、`true-peak`、
`silent-track`、`long-silence`、`no-sounding`、`expect-duration`、`beat-alignment`、
`beat-coverage`、`edge-click`。

## contact-sheet.mjs

```powershell
node scripts/verify/contact-sheet.mjs <mp4> <out.png> [--frames 12 --cols 4] [--thumb-width 480]
node scripts/verify/contact-sheet.mjs out/full.mp4 out/check/sheet.png --at 0,104,240,299 --cols 2
```

默认等间隔抽 12 帧、4 列 3 行（**首帧与末帧一定在内**）；`--at` 换成指定帧号，按给定顺序摆放
（格序 = 从左到右、从上到下，报告里会打印帧号清单）。每格按 `--thumb-width` 缩放，整张 PNG 无损输出；
帧数不整除列数时末行空位是黑的。

告警码：`frame-shortage`（片长不足，抽帧数被收窄）、`empty-output`。

## 建议的最小闭环（成片交付前）

```powershell
node scripts/verify/verify-video.mjs out/full.mp4 --expect-frames 300      # 规格 + 黑帧
node scripts/verify/verify-audio.mjs out/full.mp4                           # 响度 + 真峰 + 落点
node scripts/verify/contact-sheet.mjs out/full.mp4 out/check/sheet.png      # 肉眼过一遍
# 需要复现性证据时（同参数再渲染一份 A/B）：
node scripts/verify/verify-determinism.mjs out/full.mp4 out/full-b.mp4
```

## 已知边界

- 黑帧阈值按有限范围（limited/tv）标定：纯黑 YAVG = 16；全范围（pc）源纯黑为 0，需自行调整阈值。
- 逐帧扫描要解码全片，耗时与片长成正比（10 秒 1080p 约 2–3 秒）。
- x264 的 CRF 从 SEI 里读；换用 NVENC 或剥离 SEI 的成片会显示"未知"（不告警，除非传了 `--expect-crf`）。
- `verify-video.mjs` 的 `--expect-color` 对"未标注色彩"的成片会告警——模板基线的要求就是标注齐全。
