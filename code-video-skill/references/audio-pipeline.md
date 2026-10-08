# 音频链路速查（步骤 2）

音乐是时间基准：**音频先行，画面跟着时间轴走**。本文件讲"什么时候用哪个工具、输入输出是什么、
边界在哪"；参数与实测数据以脚本 `--help`、`scripts/audio/README-analyze.md`
（分析 / 裁切 / 按需加工）与 `scripts/audio/README-lyrics.md`（歌词对齐）为准。
下面命令假设当前目录 = skill 根目录；输出路径写到用户项目里（如 `videos/my-video/out/`）。

## 0 决策树

```text
用户提供音乐？
├─ 是 → analyze-music.py → audio-analysis.json + 校验图
│        ├─ 用户提供 LRC（带时间戳）→ align-lyrics.py --lrc …
│        ├─ 用户提供纯文本歌词     → align-lyrics.py --audio … --text …（词级对齐）
│        └─ 无歌词                 → 跳过歌词链路，画面用节拍 / 段落驱动
│        然后 cut-to-length.py → cut-plan.json（拍点网格上选窗口）
└─ 否 → 不做外部获取；在项目里 npm run bed 拼一条完整音床兜底（见 §5）
        画面需要拍点时：对 bed.wav 补跑 analyze-music.py（或直接读 npm run bed --json 的网格），
        再回来填场景表的"音频事件"列——即"先 bed → 再分析 → 再拆镜头"这条链。
```

音效两条路径都要走：`src/audio/sfx-definitions.ts`（音效即代码）→ `npm run sfx` →
`public/audio/sfx/*.wav` → Remotion `<Audio>` 挂载（见 §6）。

**固定一步：拿到用户曲目后先人工标注段落表**（前奏 / 主歌 / 副歌 / 高潮 / 尾奏）。
自动分析只给拍点，不做段落检测；段落表是画面骨架，写进场景表的"音频事件"列。
曲目无明显曲式（均匀 groove）时如实写"无明显段落，按拍点推进"并注明选窗理由，不必强凑段落。
节奏不清的曲目（无鼓、自由节奏）BPM 不稳，需人工标拍或降低卡点精度。

## 1 环境准备（venv 建在脚本旁，不污染全局）

音频脚本的依赖装在 `scripts/audio/` 下的 venv 里（不改全局环境；复制 / 组装 skill 时不要带上
`.venv*/`）。Windows 用 `Scripts/python.exe`，macOS / Linux 换成 `bin/python`：

```powershell
# 分析 / 裁切：librosa 一套
python -m venv scripts/audio/.venv-music
scripts/audio/.venv-music/Scripts/python.exe -m pip install numpy==2.5.3 librosa==1.0.0 matplotlib==3.11.2 soundfile==0.14.0

# 歌词对齐：Demucs + faster-whisper（PyAV 必须钉 18.1.0，19 与 faster-whisper 不兼容）
python -m venv scripts/audio/.venv-lyrics
scripts/audio/.venv-lyrics/Scripts/python.exe -m pip install numpy soundfile matplotlib torch torchaudio faster-whisper demucs "av==18.1.0"
```

首次运行会下载模型（faster-whisper 权重来自 HuggingFace、Demucs 来自 Meta），网络受限时可用镜像。
`ffmpeg` / `ffprobe` 需在标准 PATH 中：`m4a` / `aac` 解码回退与响度处理都依赖它们。
如果 skill 目录只读，把 venv 建到用户项目里并用其解释器路径运行脚本即可——脚本与 venv 位置无关。

## 2 analyze-music.py —— 音乐离线解析

什么时候用：拿到用户音乐的**第一件事**。把音乐解析成静态 JSON，渲染期只读 JSON，
不在渲染期做实时分析。

```powershell
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/analyze-music.py 音乐.mp3 `
  -o out/audio-analysis.json --levels-fps 30
```

| 参数 | 要点 |
|---|---|
| `-o / --output` | JSON 输出（默认音频同目录） |
| `--plot` / `--no-plot` | 校验图（默认 `<JSON 同名>.png`） |
| `--levels-fps` | 能量包络采样率，**与成片 fps 一致**（默认 30） |
| `--hop-length` | 默认 `128`；512 会把 120 BPM 量化到 117.5 BPM（实测），不要随手改粗 |
| `--no-beat-refine` | 关闭拍点对齐修正（默认开启全局平移，上限 ±35 ms） |
| `--sr` | 分析采样率，默认 22050，只影响分析、不改文件 |

输出 `audio-analysis.json`：`bpm`、`duration`、`beats`、`downbeats`（4/4 假设 = `beats[::4]`）、
`onsets`、`levels`（逐帧 RMS，归一化 0–1，第 i 点对应 `t = i / levels_fps`）、`levels_fps`、`meta`。

读结果时：

- `meta.warnings` 是脚本的自检结论，先看这里；
- BPM 落在 60–180 之外要警惕半速 / 双速误判；拍点数量应 ≈ 时长 ÷ 拍长（偏差 >10% 会报 warning）；
- **打开 PNG 看第 2 行**（前 8 秒放大）：拍点线应压在每次起音上；
- 首 / 末拍受文件边界影响偏晚（实测 27–49 ms），中段可用；无鼓曲目需人工标拍。

## 3 align-lyrics.py —— 歌词对齐

何时用：**仅当用户提供歌词**。两条路径：

| 输入 | 路径 | 词级时间戳 |
|---|---|---|
| LRC（带时间戳） | 直接解析（最优先） | 默认无；`--split-words` 按权重**推导**（带标记） |
| 纯文本（无时间戳） | Demucs 人声分离 → faster-whisper 词级转写 → 用户歌词校准 | 有（实测，误差约 100–300 ms） |

```powershell
# LRC 直读（可加 --audio 做时长校验与校验图）
scripts/audio/.venv-lyrics/Scripts/python.exe scripts/audio/align-lyrics.py --lrc song.lrc --audio song.mp3 --out out/lyrics.json

# 纯文本对齐
scripts/audio/.venv-lyrics/Scripts/python.exe scripts/audio/align-lyrics.py --audio song.mp3 --text lyrics.txt --out out/lyrics.json
```

关键语义（**不要误用**）：

- 输出兼容 Remotion Caption 结构并扩展到词级：`[{ text, startMs, endMs, words: [{ word, startMs, endMs }] }]`；
- `wordsSource: "split-estimated"` 表示词级是 **LRC 行级时间戳的推导值**（行内顺序可信，绝对时间按权重摊派），
  可用于逐字高亮兜底，**不可**当"歌手实际唱到该字的时间"做精确卡点；
- `words` 非空且没有 `wordsSource` 才是真实对齐；`words: []` 表示无词级信息；
- 中文逐字可在消费端按字符均分（在词级时间戳基础上）；
- 用户不提供歌词 → 不跑本工具，画面改用节拍 / 段落驱动。

其他要点：`--no-separate`（素材已是纯人声时跳过 Demucs）、`--model`（默认 `small`）、
`--language`、`--last-line-ms`（LRC 末行默认 4000）、`--strict`（有校验警告时退出码 1）。
退出码：`0` 正常 / `1` 仅 `--strict` 且有警告 / `2` 参数或运行错误。

## 4 cut-to-length.py —— 拍点网格上裁切（非破坏）

何时用：目标时长与音乐长度不一致时。工具**只输出窗口参数，不改音频文件本体**。

**选窗四步**（全曲长于目标时长时，"选哪 60 秒"是创作判断）：

1. 用能量包络（`audio-analysis.json` 的 `levels` 或校验图）找"有完整叙事弧"的段落；
2. 列出候选窗口内的 LRC 行落点，确认首句可提前几帧弹入、末句完整；
3. 两端尽量压检测拍点（`--start` 会向前吸附；不传则从第一个网格点起）；
4. **核对人声实际落点**：LRC 的字面末行时间 ≠ 人声结束（拖腔 / 和声会延续）——用能量包络
   找"人声自然落下点"再定终点，避免演唱中途硬切。核对过程建议落一张 `window-check.png`
   （能量 + LRC 行落点 + 候选线）存进 `out/`。

**时长裁决规则**（`beat_aligned` 与 `exact_seconds` 两案都 `checks_passed` 时）：

- 用户给的是**硬时长**（平台上限 / 明确要求）→ 用 `exact_seconds`；
- 音乐完整性优先（末句人声、整拍收尾）→ 用 `beat_aligned`（推荐方案），并在 QC 报告的
  "决策记录"里写明实际时长与偏差（如"1804 帧 / 60.133s，用 +0.13s 换末句完整"）。

```powershell
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/cut-to-length.py `
  --analysis out/audio-analysis.json --duration 15 --fps 30 --start 5.2 -o out/cut-plan.json `
  --emit-film-grid out/beatgrid-film.json
```

- `--start` 会**向前吸附**到网格点，吸附偏移记录在输出里；不传则取第一个不早于 0 s 的网格点；
- 两种方案：`beat_aligned`（默认推荐，起止都落在拍点，时长最多差半个拍长）与
  `exact_seconds`（时长精确，终点可能落在拍之间）；各自带 `checks_passed`；
- 输出里 `remotion.trimBefore` / `durationInFrames` 直接喂给 `<Audio>`（帧单位）：

```tsx
<Audio src={staticFile("音乐.mp3")} trimBefore={plan.remotion.trimBefore} durationInFrames={plan.remotion.durationInFrames} />
```

- **裁切后时间轴整体左移**（`frame = Math.round((t - start_seconds) × fps)`）：
  - 拍点：用 `--emit-film-grid out/beatgrid-film.json` 直接输出**已减窗口起点**的成片网格，
    喂给 `verify-audio --beat-grid`——不要手工换算；
  - 歌词与音效落点：仍由消费端减去 `window.start_seconds`（工具不生成偏移后的副本）；
- 目标时长超过音频时长会直接报错；不做变速拉伸、不做循环拼接。

## 5 音床：无音频兜底（`npm run bed`，在用户项目里执行）

用户没提供任何音频时，用音效元素（节奏层 / 氛围层 / 点缀）按视频时长与节拍拼一条完整 BGM，
保证成片不静音。命令属于模板工具链，必须在用户项目目录内跑：

```powershell
npm run bed -- --duration=30                                          # 固定 120 BPM
npm run bed -- --duration=30 --analysis=out/audio-analysis.json        # 有拍点数据时按拍点铺（推荐）
npm run bed -- --duration=10 --transitions=2,5,7,9                     # 切换点：riser 提前抬起、impact 压点
```

参数：`--intensity 0~1`（密度与响度）、`--peak-db`（归一化目标，默认给上层音效留余量）、
`--transition-every <秒>`（没给 `--transitions` 时按间隔自动铺）、`--mp3`（额外试听用）。
`--transitions` 是**秒列表**（逗号分隔，如 `2,5,7,9`），不是"第几个切换点"；
`--json` 输出里 `grid.beats` 为空数组属正常（未提供 `--analysis` 时不生成拍点网格）。
输出 `public/audio/bed/bed.wav`（时长精确到样本），挂载：

```tsx
<Audio src={staticFile("audio/bed/bed.wav")} premountFor={fps} />
```

显式切换点只在 60 ms 容差内吸附拍点——切换点是剪辑点，impact 必须压在那一帧上。
编排规则在 `src/audio/bed-plan.ts`、音色在 `src/audio/bed-render.ts`，分开改。
音床自带收尾段（`--json` 的 `hasOutro: true`）；模板另有一套独立 `outro.wav` 音效——
两者可同时挂（冷启动实测做法），是否叠加、会不会过载以 `verify-audio` 的真峰为准（≤ -1 dBTP）。

## 6 音效（音效即代码）

1. 在 `src/audio/sfx-definitions.ts` 里加 / 改音效定义；
2. `npm run sfx` 离线渲染（`Tone.Offline()` → WAV）到 `public/audio/sfx/*.wav`；
3. 在时间轴上用 `<Audio from=… volume=…>` 挂载（模板 `src/Main.tsx` 有范例）。

**资产以落盘那一份为准**：带噪声源的音效（impact / whoosh）重跑不可逐字节复现，
不要靠"重新生成"复现旧成片；WAV 进版本库，源码（`sfx-definitions.ts`）同步进 git。
渲染期禁止现场生成音频（Remotion 渲染环境没有实时音频）。
**编排默认**：音效跟随"大特效清单"走（每个大特效处配 whoosh / impact），其余切点默认不挂；
"少而准"——过多音效会抬高真峰，也需要更多增益来压制。

### 合成层增益与首尾淡化（不改素材的正路）

素材真峰超标（BGM 自身 > -1 dBTP）或首尾硬切时，**先走合成层**、不动素材文件：

- 总增益：`<Audio volume={…}>`（模板的 `SFX_MASTER_VOLUME` 一类总线同理）——属混音，不算改动音频本体；
- 首尾淡化：用 `volume` 的帧号包络函数实现（常见进 5–10 帧、出 20–30 帧）；
- 调试方法（实测路径）：离线解码测算素材真峰与叠加后真峰 → 增益网格试探 → 实渲复测
  （`verify-audio` 真峰 ≤ -1 dBTP 与 `--edge-window` 首尾边界）；
- 素材侧加工（`process-audio.py`）只在用户明确要求时使用——有损重编码且不可逆。
- 采样率落差：音效 WAV 为 44.1 kHz、成片音频为 48 kHz——写离线混音测算时先统一采样率。

## 7 按需音频加工（默认不做）

`process-audio.py` 只在**用户明确要求**时使用（淡入淡出 / 响度标准化），且必须显式传参：

```powershell
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/process-audio.py -i 音乐.wav -o out/音乐-淡化.wav --fade-in 1.5 --fade-out 2
scripts/audio/.venv-music/Scripts/python.exe scripts/audio/process-audio.py -i 音乐.wav -o out/音乐-14LUFS.m4a --loudnorm
```

- 加工**必然重新编码**（有损再损失一代）、不可逆，不覆盖已存在文件、不做原地加工；
- 先响度、后淡化；`--report` 可留加工记录；
- 稀疏素材（峰均比高）可能达不到目标响度，脚本会告警并给出可选处理；
- 退出码 `0` 成功 / `1` 失败 / `2` 已产出但响度自检超差（需如实告知用户）。

## 8 边界（硬规矩）

- **不生成音乐、不获取音乐**：不做库检索、不做 AI 生成、不下载；BGM 版权责任随文件落在用户侧。
- **歌词一律由用户提供**：不做 ASR 听写凑歌词、不猜歌词；ASR 只贡献时间戳，文本永远用用户的。
- 默认不改动音乐本体：不 ducking、不重混、不变速拉伸、不循环拼接、不去改用户文件。
- 校验图与 JSON 的 `meta.source_file` 只写文件名，不外泄本机目录结构。

## 9 步骤 2 成功门（按实际分支核对；不适用项显式记 N/A，不要假装通过）

**用户提供音乐：**

- [ ] `audio-analysis.json` + 校验图：BPM 合理、拍点压在起音上、拍点数量相符、`meta.warnings` 已处理；
- [ ] 有歌词时 `lyrics.json`：行数 = 文本行数、时间单调递增、末行不超时长；
      （**同秒多行的"时间重叠"警告属良性**——合唱 / 标签行会出现，不是过门失败；
      消费端给零时长行补最小可见期即可。）
- [ ] 有裁切需求时 `cut-plan.json`：`checks_passed` 为真，`remotion.trimBefore` / `durationInFrames` 已确定；

**无音乐（音床兜底）：**

- [ ] `npm run bed` 产出的音床：时长与目标一致（`--expect-duration` 核验）、拍点达标
      （提供 `--analysis`，或对 bed 补分析后用 `--beat-grid` 复核）；
- [ ] `verify-audio` 通过（响度 / 真峰 / 无异常静音）——成片不得静音。

**两支共同**：音效 / 音床以落盘 WAV 资产为准；渲染期禁止现场生成音频。
