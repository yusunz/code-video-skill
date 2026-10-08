# 音乐分析与裁切踩点（scripts/audio）

覆盖节拍解析、时长适配（裁切）与校验回路。

| 脚本 | 作用 | 产物 |
|---|---|---|
| `analyze-music.py` | 离线解析音乐：BPM、拍点、downbeats、onset、能量包络 | `audio-analysis.json` + 校验图 PNG |
| `cut-to-length.py` | 在拍点网格上选出与目标时长相符的窗口 | `cut-plan.json` |
| `process-audio.py` | **按需**音频加工：淡入淡出 / 响度标准化（默认不做） | 加工后的音频（+ 可选 `--report` JSON） |
| `ffmpeg_locate.py` | 公共模块：ffmpeg / ffprobe 定位（标准 PATH 查找；未找到时给出安装指引） | 无（被上面脚本导入） |

**边界**：只做"解析"与"裁切方案"。不做音乐生成/获取、不做混音、不做变速拉伸、不做循环拼接，也不改动用户提供的音乐文件本体——裁切由 Remotion 侧用帧号参数完成。
音频加工是例外：只有用户明确要求时才用 `process-audio.py` 执行（见 §6），且必然重新编码、不可逆。

## 1. 环境准备

依赖装在项目内 venv（`.gitignore` 已排除 `.venv*/`），不污染全局：

```powershell
python -m venv scripts/audio/.venv-music
scripts/audio/.venv-music/Scripts/python.exe -m pip install `
  numpy==2.5.3 librosa==1.0.0 matplotlib==3.11.2 soundfile==0.14.0
```

实测环境：Windows + Python 3.13，`librosa 1.0.0` / `numpy 2.5.3` / `matplotlib 3.11.2` / `soundfile 0.14.0`（随附 `numba 0.68.0`、`scipy 1.18.1`）。

`ffmpeg` 可选但推荐：`m4a` / `aac` 等容器 soundfile 解不了，脚本会自动回退到 ffmpeg 解码（需在 PATH 中可用）。

## 2. analyze-music.py

```powershell
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/analyze-music.py 音乐.mp3
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/analyze-music.py 音乐.m4a `
  -o out/audio-analysis.json --levels-fps 30
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `audio` | 必填 | 输入音频路径（mp3 / wav / flac / ogg / m4a / aac…） |
| `-o, --output` | 音频同目录 `audio-analysis.json` | 输出 JSON 路径 |
| `--plot` | 与 JSON 同名的 `.png` | 校验图路径 |
| `--no-plot` | 关 | 跳过校验图 |
| `--levels-fps` | `30` | 能量包络采样率，建议与视频 fps 一致 |
| `--hop-length` | `128` | 分析帧移（采样点）。512 会把 120 BPM 量化成 117.5 BPM（实测），128 误差 <0.2% |
| `--n-fft` | `1024` | onset 分析窗长。窗越大低频分辨率越高、起音定位越钝 |
| `--no-beat-refine` | 关 | 关闭拍点对齐修正（见 §2.2） |
| `--sr` | `22050` | 分析采样率，只影响分析，不改动原文件 |

退出码：成功 `0`，参数/解码/分析错误 `1`（错误信息为中文，直接说明原因）。

### 2.1 输出 schema（audio-analysis.json）

```json
{
  "bpm": 120.1853,
  "duration": 60.5,
  "beats": [0.048929, 0.510839],
  "downbeats": [0.048929],
  "onsets": [0.0464],
  "levels": [0.0123, 0.9987],
  "levels_fps": 30.0,
  "meta": { "…": "工具/参数/假设/自检结果，见下" }
}
```

| 字段 | 说明 |
|---|---|
| `bpm` | `librosa.beat.beat_track` 的节奏估计（拍/分）；拍点是否做了对齐修正见 `meta.beat_refinement` |
| `duration` | 音频时长（秒） |
| `beats` | 拍点时间数组（秒），升序 |
| `downbeats` | **4/4 假设**下的强拍 = `beats[::4]`（第 1 拍视为强拍）。这是约定而非检测结果，换拍号需自行重算 |
| `onsets` | 起音点时间数组（秒），`backtrack=True` 回退到能量上升处 |
| `levels` | 逐帧 RMS，按整段峰值归一化到 0-1；第 `i` 点对应 `t = i / levels_fps` |
| `levels_fps` | 上述包络的采样率（受采样率与整数 hop 限制，可能被轻微吸附） |
| `meta` | 工具版本、参数、加载方式（`librosa/soundfile` 或 `ffmpeg`）、downbeat 规则、自检项与 `warnings` |

`meta.source_file` 只写文件名（不写绝对路径），便于把 JSON 带出本机时不含本机目录结构。

### 2.2 拍点对齐修正（默认开启）

`librosa` 的 DP 拍点会稳定滞后于真实起音（实测 +9.6~12.3 ms；用更粗的 `--hop-length 512` 时放大到 +14~19 ms——这也是默认 hop=128 的原因之一）。脚本在 `onset` 强度包络上取峰值（±4 帧内 argmax + 抛物线亚帧插值），用**全部拍点偏移的中位数**做一次全局平移，幅度上限 ±35 ms（`meta.beat_refinement` 记录实际值）；只平移、不改变拍点间隔的均匀性；需要原始输出时用 `--no-beat-refine`。

实测效果（合成素材，真值网格已知，统计时去掉受文件边界影响的首末拍）：

| 素材 | 关闭修正（`--no-beat-refine`） | 默认（含修正） |
|---|---|---|
| 120 BPM click（60 s） | +9.6 ms（最大 12.7 ms） | **+6.3 ms**（最大 9.3 ms） |
| 100 BPM 鼓点+旋律（48 s） | +12.3 ms（最大 15.3 ms） | **+10.3 ms**（最大 13.3 ms） |

### 2.3 校验图（PNG）

三行：① 全曲波形 + 拍点线（橙）+ downbeat 线（红）+ BPM/参数标注；② **前 8 秒放大**——用来确认拍点线是否压在起音上；③ 能量包络 + onset 刻度。BPM 异常、拍点抖动过大、拍点数量与 BPM 推算不符时，图上会显示红色警告框（同一份内容也写进 `meta.warnings`）。

### 2.4 已知局限

- 首拍/末拍受文件边界影响（onset 看不到文件外的上升沿），实测偏晚 27~49 ms；中段拍点不受影响。
- 无鼓、自由节奏或弱起拍的曲目 BPM 不稳定，脚本会在 `meta.warnings` 提示，需要人工标拍或降低卡点精度。
- 只做 4/4：其他拍号需自行按 `beats` 重算强拍。

## 3. cut-to-length.py

```powershell
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/cut-to-length.py `
  --analysis out/audio-analysis.json --duration 15 --fps 30
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/cut-to-length.py `
  -a out/audio-analysis.json -d 30 --fps 60 --start 5.2 -o out/cut-plan.json
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/cut-to-length.py `
  -a out/audio-analysis.json -d 30 --emit-film-grid out/beatgrid-film.json
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-a, --analysis` | 必填 | `analyze-music.py` 产物 |
| `-d, --duration` | 必填 | 目标时长（秒） |
| `--fps` | `30` | 视频帧率，用于帧号换算 |
| `--start` | 第一个不早于 0 s 的网格点 | 起点（秒），**向前吸附**到网格；吸附偏移记录在输出里 |
| `-o, --output` | 与分析文件同目录 `cut-plan.json` | 输出路径 |
| `--emit-film-grid` | 不输出 | 同时写出**成片拍点网格**（已减窗口起点、只含窗口内拍点），直接喂 `verify-audio --beat-grid` |

`--emit-film-grid` 输出 `{"beats": [...]}`（含窗口元信息）：把拍点从整曲轴换算到成片轴
（`t − window.start_seconds`）——**不要再手工换算**；`verify-audio --beat-grid` 直接吃这个文件。

### 3.1 输出 schema（cut-plan.json）

```json
{
  "fps": 30, "target_seconds": 15.0, "requested_start_seconds": null,
  "audio": { "duration": 60.5, "bpm": 120.1853, "beat_seconds": 0.499229, "beats_detected": 120 },
  "assumptions": { "time_signature": "4/4", "grid_extrapolation": "…", "grid_index_semantics": "…" },
  "window": {
    "scheme": "beat_aligned",
    "start_seconds": 0.048929, "end_seconds": 15.008385, "duration_seconds": 14.959456,
    "start_frame": 1, "duration_frames": 449, "end_frame": 450,
    "start_beat_index": 0, "end_beat_index": 30, "beat_count": 30,
    "beat_seconds": 0.499229, "local_beat_seconds": 0.498649, "beat_aligned": true,
    "start_on_grid": true, "end_on_grid": true,
    "start_on_detected_beat": true, "end_on_detected_beat": true,
    "starts_on_downbeat": true, "downbeat_aligned": false,
    "delta_from_target_seconds": -0.040544, "effective_seconds": 14.966667,
    "frame_rounding_error_seconds": 0.007211, "start_frame_error_seconds": -0.015596,
    "start_shift_from_request_seconds": null,
    "checks": { "…": "本方案自身的断言" }, "checks_passed": true
  },
  "alternatives": [ { "scheme": "exact_seconds", "…": "…" } ],
  "recommended": "beat_aligned",
  "notes": ["…取舍说明…"],
  "remotion": { "fps": 30, "trimBefore": 1, "durationInFrames": 449, "snippet": "…" }
}
```

要点：

- `window` 是推荐方案，`alternatives` 是另一种；两种方案都带 `checks` 与 `checks_passed`（各自断言，互不混用）。
- `start_on_detected_beat` / `end_on_detected_beat` 区分"落在实测拍点上"与"落在网格外推点上"——后者会在 `notes` 里点明精度依赖外推。
- `delta_from_target_seconds` = 实际时长 − 目标时长；`effective_seconds` 是帧取整后的真实时长。
- `beat_seconds` 是全曲中位拍长（用于外推），`local_beat_seconds` 是本窗口的实际平均拍长（= 时长 ÷ 拍数）——检测拍点有毫秒级抖动，两者会有千分之几的差别。

### 3.2 两种方案的取舍

| 方案 | 时长 | 端点 | 适用 |
|---|---|---|---|
| `beat_aligned`（默认推荐） | 与目标最多差半个拍长 | 起止都在网格点上 | 画面卡点、节奏驱动 |
| `exact_seconds` | 精确等于目标 | 起点在拍点，终点可能落在拍与拍之间 | 平台时长上限等硬性要求 |

### 3.3 拍点网格与外推

网格 = 检测到的拍点 + 两端按中位拍长（`median(相邻拍点间隔)`）的外推点。索引语义：`0 <= index < beats_detected` 为实测拍点，`index < 0` / `index >= beats_detected` 为外推点。外推只用于让窗口落进音频范围（例如检测到的首拍在 0.52 s 时，仍能排出贴近 0 的窗口），**不会修改检测到的拍点**。

### 3.4 Remotion 消费

```tsx
import { Audio, staticFile } from "remotion";
import plan from "./out/cut-plan.json";

<Audio
  src={staticFile("音乐.mp3")}          // 换成工程 public/ 下的实际 BGM
  trimBefore={plan.remotion.trimBefore}  // 帧
  durationInFrames={plan.remotion.durationInFrames}
/>
```

组合时长（composition `durationInFrames`）需 ≥ `trimBefore + durationInFrames`；具体 props 名称以当前 remotion-* skill 为准，本工具只负责给出帧号。

## 4. 校验回路

1. **BPM 合理性**：60-180 之外脚本自动写 warning，需结合校验图人工确认半速/双速；
2. **拍点数量**：`meta.checks.beat_count_actual` vs `beat_count_expected`（≈ 时长 ÷ 拍长），偏差 >10% 报 warning；
3. **看图**：打开 PNG，重点看第 2 行前 8 秒放大——拍点线应压在每次起音上，downbeat 线应落在最强拍；
4. **能量包络**：`levels` 数量应 ≈ `duration × levels_fps`（`meta.checks` 已核对），且能看到小节级起伏。

## 5. 实测与性能

> 参考基线：用于判断数值"是否正常"，不是验收阈值；不同机器与版本会有差异。

| 场景 | 结果 |
|---|---|
| 120 BPM click 60 s（合成） | BPM **120.19**；拍点 120 个，中位间隔 **0.499229 s**（真值 0.5）；中段拍点偏差 +6.3 ms |
| 100 BPM 鼓点+旋律 48 s（合成） | BPM **100.35**；拍点 81 个，中位间隔 **0.597914 s**（真值 0.6）；中段偏差 +10.3 ms |
| 15 s 裁切（30 fps，120 BPM click） | 窗口 0.048929 → 15.008385 s，30 拍；`trimBefore=1`、`durationInFrames=449`；起止均在实测拍点 |
| 20 s 裁切（60 fps，100 BPM 小曲，`--start 5.2`） | 起点吸附 5.408 s（+0.208 s）；整拍方案 19.801 s / 33 拍，精确方案 20.000 s |
| 格式 | wav/mp3 走 soundfile；m4a 走 ffmpeg 回退，分析结果与 wav 一致 |
| 耗时 | 60 s 音频端到端 ≈ 3.0 s；5 分钟音频 ≈ 6.8 s（均含解释器启动与库导入约 2 s） |

复现自测脚本（开发期生成，未入库、不随组装分发）放在工具目录下的 `.selftest/`：`make_click.py` / `make_song.py` 生成素材，`check_analysis.py` / `verify_plan.py` 独立复核 BPM、拍点、对齐与帧号。

## 6. 按需音频加工：process-audio.py

### 6.1 边界（先读这一段）

* 本项目**默认不做**任何音频加工——不做闪避、不做重混、不改动用户音乐本体；
* 本工具只服务"用户明确要求"的场景，**必须显式传参**：`--fade-in` / `--fade-out` / `--loudnorm`；
  一个都没传时脚本什么都不做，直接报错退出（退出码 1），不会隐式产出任何文件；
* 加工**必然重新编码**音频（有损格式会再损失一代），且改动不可逆——执行前终端会再提示一次；
* 输出不会覆盖已存在文件（需显式 `--overwrite`），也禁止输出路径与输入相同（不做原地加工）。

### 6.2 用法

```powershell
# 淡入 1.5 s + 淡出 2 s
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/process-audio.py `
  -i 音乐.wav -o out/音乐-淡化.wav --fade-in 1.5 --fade-out 2

# 响度标准化到 -14 LUFS（只写 --loudnorm 即 -14；写数值则用该值）
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/process-audio.py `
  -i 音乐.wav -o out/音乐-14LUFS.m4a --loudnorm

# 目标 -12 LUFS + 加工记录（含 ffmpeg 命令、测量值与自检结果）
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/process-audio.py `
  -i 音乐.wav -o out/音乐-12LUFS.m4a --loudnorm -12 --report out/process.json
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-i, --input` / `-o, --output` | 必填 | 输入音频 / 输出音频（扩展名决定编码器） |
| `--fade-in` / `--fade-out` | 不做 | 淡入 / 淡出时长（秒），ffmpeg `afade` 线性斜坡 |
| `--loudnorm [LUFS]` | 不做 | 响度标准化目标；只写 `--loudnorm` 时为 `-14` |
| `--true-peak` / `--lra` | `-1.5` / `11` | loudnorm 的真峰上限与响度范围目标 |
| `--bitrate` | `192k` | 有损输出的码率（wav / flac 等无损输出忽略） |
| `--tolerance-lu` | `0.5` | 响度自检容差，超差返回退出码 2 |
| `--report` | 不写 | 加工记录 JSON 路径（ffmpeg 命令、pass1 测量、自检、淡化窗口能量） |
| `--overwrite` | 关 | 允许覆盖已存在的输出 |
| `--ffmpeg` / `--ffprobe` | 自动定位 | 手动指定可执行文件 |

**处理顺序：先响度标准化、后叠加淡化。** loudnorm 用两遍法（先测量、再用 `linear=true` 施加恒定增益），
淡化放最后，淡入淡出形状才精确，响度测量也只针对未淡化的节目本体。

### 6.3 自检与"达不到目标"的诚实告警

加工完成后脚本会独立再量一遍**输出文件**的响度（loudnorm 测量 pass），与目标比较：
偏差 ≤ `--tolerance-lu` 记 `checks.loudness_within_tolerance = true`；超差则打印告警并返回退出码 2。

为什么有时达不到目标（重要）：线性增益要求素材**峰均比 ≤（真峰上限 − 目标响度）**。
`-14 LUFS` + `-1.5 dBTP` 允许的峰均比是 `12.5 LU`；稀疏鼓点、未做母带的素材峰均比可达 `20 LU`，
此时 loudnorm 会退回**动态模式**（压缩动态范围）且实际响度低于目标。脚本在**处理前**就会预判并提示，
结尾给出可选处理：放宽 `--true-peak`（例如 `-1.0`）、降低目标响度，或先对素材限幅。

退出码：`0` 成功（自检通过）；`1` 失败（参数 / 环境 / ffmpeg 错误）；`2` 已产出文件但响度自检超出容差。

### 6.4 ffmpeg 定位（`ffmpeg_locate.py`）

只做**标准 PATH 查找**（`shutil.which`）——不扫描注册表、不展开 PATH 中的变量引用；找不到时抛出带
"尝试记录 + 处理办法"的错误（环境适配边界：只依赖标准环境）。
`analyze-music.py` 的 m4a 解码回退也走这套定位。

### 6.5 实测（ffmpeg 9.0.2 完整版）

| 场景 | 结果 |
|---|---|
| 0.5 s 淡入淡出（10 s 稳态正弦） | 首/末 0.5 s RMS `-23.02 → -27.78 dBFS`，恰为线性斜坡理论值 `-4.77 dB`；0.1 s 步进单调（-41.8 → -23.9 dBFS）；独立复核（ffprobe + astats）9/9 PASS |
| 响度 `-14 LUFS`（密集音乐，峰均比 7.2 LU） | 线性模式，输出 summary `-13.95 LUFS`；独立测量 `-14.00 LUFS`（偏差 0.00 LU）；`--report` 记录完整命令 |
| 响度 `-14 LUFS`（稳态正弦） | `-14.05 LUFS`（偏差 0.05 LU） |
| 综合（密集音乐 → m4a，淡化 + 响度） | 淡入/淡出 PASS；输出 `-14.11 LUFS`（偏差 0.11 LU）；时长 22.500 s 不变 |
| 稀疏素材（峰均比 20.03 LU） | 预判不可线性达标 → 回退动态模式，实测 `-16.80 LUFS`，退出码 2 + 告警（含可选处理） |
| 中文路径 / m4a 输出 / 负值参数 `--loudnorm -12` | 均正常 |

自测素材与复核脚本（未入库）：`make_tone.py`（稳态音）、`make_dense_music.py`（密集音乐）、`verify_process.py`（astats / loudnorm 独立复核）。
