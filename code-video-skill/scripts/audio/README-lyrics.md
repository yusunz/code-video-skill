# align-lyrics.py —— 歌词对齐（LRC 直读 / 纯文本对齐）

**歌词一律由用户提供**，本工具只负责"给用户提供的准确歌词打时间戳"。
不用 ASR 听写凑歌词、不生成歌词、不改写歌词用词——ASR 只贡献时间戳，文本一律以用户输入为准。

两条路径：

| 输入 | 路径 | 音频 | 词级时间戳 |
|---|---|---|---|
| LRC（带时间戳） | 直接解析 | 可选（用于时长校验与校验图） | 默认无（`words: []`）；`--split-words` 可按权重推导（带 `split-estimated` 标记） |
| 纯文本（无时间戳） | Demucs 人声分离 → faster-whisper 词级转写 → 用户歌词校准 | 必需 | 有 |

---

## 1. 环境与依赖

依赖装在项目内 venv，不污染全局（`.gitignore` 已排除 `.venv*/`）：

```powershell
cd <本 skill 根目录>
python -m venv scripts/audio/.venv-lyrics
& scripts/audio/.venv-lyrics/Scripts/python.exe -m pip install --upgrade pip
& scripts/audio/.venv-lyrics/Scripts/python.exe -m pip install numpy soundfile matplotlib torch torchaudio faster-whisper demucs "av==18.1.0"
```

已实测通过的组合（Windows + Python 3.13）：

| 包 | 版本 | 用途 |
|---|---|---|
| numpy / soundfile / matplotlib | 2.5.3 / 0.14.0 / 3.11.2 | 解码、波形与校验图 |
| torch / torchaudio | 2.14.1 (CPU) / 2.11.0 | Demucs 推理后端 |
| faster-whisper | 1.2.1（ctranslate2 4.8.2） | 词级时间戳 |
| demucs | 4.1.0 | `htdemucs` 人声分离 |
| av (PyAV) | **18.1.0（必须钉住）** | faster-whisper 的音频解码 |

外部命令：`ffmpeg`（项目已全局安装）。用途一是解码 soundfile 不支持的容器，二是裁前导静音时重采样成 16 kHz 单声道。

### 1.1 依赖兼容性问题（务必看）

**PyAV 19 与 faster-whisper 1.2.1 不兼容**：faster-whisper 调用 `av.open(..., metadata_errors="ignore")`，
而 PyAV 19.0.1 移除了该参数，报错为
`TypeError: open() got an unexpected keyword argument 'metadata_errors'`。

- 解决：`pip install "av==18.1.0"`（已在安装命令里钉住）；
- 若误装 PyAV 19，工具会捕获该错误并直接提示降级命令，不用自己猜。

其余在 Python 3.13 上均无需编译、无替代方案。

### 1.2 模型下载

- faster-whisper 权重来自 HuggingFace（如 `Systran/faster-whisper-small`，约 480 MB），首次运行自动下载，缓存于 `%USERPROFILE%\.cache\huggingface`；
- Demucs `htdemucs` 权重来自 Meta 官方地址，首次运行自动下载；
- 网络受限时（如无法直连 HuggingFace）可设置 HF 镜像端点（以下为示例，替换为任意可用镜像）并静音符号链接警告：

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"   # 示例镜像；可按你所在网络替换
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
```

- 想换缓存位置用 `--model-dir <DIR>`。

---

## 2. 用法

设 `$py = "scripts/audio/.venv-lyrics/Scripts/python.exe"`（相对当前工作目录；组装进 skill 后该路径自动改写为 skill 内位置）。

### 模式 1：LRC 直读（不需要音频）

```powershell
& $py scripts/audio/align-lyrics.py --lrc song.lrc --out lyrics.json
& $py scripts/audio/align-lyrics.py --lrc song.lrc --audio song.mp3 --out lyrics.json   # 加时长校验 + 校验图
& $py scripts/audio/align-lyrics.py --lrc song.lrc --split-words --out lyrics.json     # 行级时间戳推导成词级（非真实对齐）
```

LRC 解析口径：

- `[mm:ss.xx]` / `[mm:ss.xxx]` / `[mm:ss]` 均支持；`.xx` 按**厘秒**、三位按**毫秒**换算（`[00:03.25]` → 3250 ms）；
- 一行多个时间戳（`[00:06.10][00:09.60]同一句`）会展开成多条记录；
- `[ti:]` `[ar:]` `[al:]` `[by:]` `[length:]` 等元数据标签行直接忽略；
- `[offset:+250]` 按 `时间 = 原时间 − offset` 处理（正值＝歌词提前出现），这是主流播放器约定；
- 行 `endMs` 取下一行起点；末行取 `start + 4000 ms`（可用 `--last-line-ms` 调整），给了 `--audio` 时会被音频时长截断；
- LRC 没有词级信息，默认 `words` 输出空数组，不做任何伪造；
- 加了 `--split-words` 才会把行级时间戳**推导**成词级：权重为「中文/日文/韩文按字数，拉丁词按 `max(1, 字符数/3)`（≈ 音节数）」，行内顺序分配，首词起点＝行起点、末词终点＝行终点，词间不重叠、不越行界。这种词级属**推导值**，每行会写入 `"wordsSource": "split-estimated"` 标记；行跨度连「每词 1 ms」都放不下时（例如末行被音频时长截断成 1 ms）该行保持 `words: []` 并在命令行提示。

### 模式 2：纯文本对齐（无时间戳）

```powershell
& $py scripts/audio/align-lyrics.py --audio song.mp3 --text lyrics.txt --out lyrics.json
& $py scripts/audio/align-lyrics.py --audio vocal.wav --text lyrics.txt --no-separate   # 素材已是纯人声时跳过分离
```

链路：

1. **Demucs 分离人声轨**（`htdemucs`，`--two-stems=vocals`）——人声轨干净，转写时间戳明显更稳；素材本就是纯人声/语音时用 `--no-separate` 省时间；
2. **裁前导静音**（默认开）：Whisper 对"开头是静音"的音频常把首词起点锚到 0 ms，整句偏早；裁掉前导静音再转写、把偏移加回时间戳，首词即落在真实起唱位置（`--no-trim` 关闭）；
3. **faster-whisper 词级转写**（`word_timestamps=True`，`condition_on_previous_text=False`）：只取时间戳，不管文字对不对；
4. **用户歌词校准**：按 token 序列做 `difflib.SequenceMatcher` 比对（英文按词、中文按字），命中即沿用该词时间戳，**输出文本一律替换成用户歌词**（含错字场景：ASR 的 "quick" 时间戳会给到用户的 "qwick"，文本保留用户写法）；
5. **未命中 token 插值**：用前后锚点在时间窗内按权重（中文按字数、拉丁词按约 3 字符）均摊；整句缺失则填在相邻行的空隙里；完全无匹配时按音频时长均摊并在控制台显著告警。

### 参数速查

| 参数 | 说明 |
|---|---|
| `--lrc FILE` | 模式 1 输入 |
| `--audio FILE` | 模式 2 输入；模式 1 下可选（时长校验 + 校验图） |
| `--text FILE` | 模式 2 歌词文本（每行一句，UTF-8 / GB18030 均可） |
| `--out FILE` | 输出 JSON，默认 `lyrics.json` |
| `--plot FILE` / `--no-plot` | 校验图路径 / 不生成校验图（默认 `<out 同名>-check.png`） |
| `--no-separate` | 跳过 Demucs |
| `--separation-model` | Demucs 模型，默认 `htdemucs` |
| `--model` | faster-whisper 模型，默认 `small`（可选 `small.en` / `medium` / `large-v3` 等） |
| `--device auto|cpu|cuda` | 推理设备，默认 auto（有 CUDA 版 torch 时自动用 GPU） |
| `--compute-type` | 默认 auto：GPU `float16`、CPU `int8` |
| `--language` | 语言提示（`en` / `zh`…），默认自动检测 |
| `--vad` | 启用 Silero VAD 过滤静音段 |
| `--no-trim` | 不裁前导静音 |
| `--model-dir DIR` | 模型缓存目录 |
| `--last-line-ms N` | LRC 末行默认时长，默认 4000 |
| `--split-words` | LRC 模式：把行级时间戳按权重推导成词级，输出行带 `wordsSource: "split-estimated"`（默认关闭；纯文本模式误用会直接报错） |
| `--strict` | 校验出现警告时以退出码 1 结束 |

退出码：`0` 正常、`1` 仅 `--strict` 且有校验警告、`2` 参数或运行错误。

---

## 3. 输出 schema

兼容 remotion-captions 的 Caption 结构并扩展到词级：

```json
[
  { "text": "There was a sun", "startMs": 5230, "endMs": 8120,
    "words": [ { "word": "There", "startMs": 5230, "endMs": 5560 } ] }
]
```

- 行按 `startMs` 单调递增，行间不重叠；`words` 内同样单调；
- LRC 路径默认 `words` 为空数组；
- JSON 为 UTF-8、`indent=2`、`ensure_ascii=false`。

### 词级时间戳的来源与精度等级（重要）

`words` 有两种**精度完全不同**的来源，工具用加法字段 `wordsSource` 显式区分，不会让消费端把推导值当成实测值：

| `words` 状态 | `wordsSource` | 来源 | 精度 |
|---|---|---|---|
| 非空 | `"split-estimated"` | LRC 行级时间戳按权重推导（`--split-words`） | **推导**：单行内相对顺序可信，绝对时间按权重摊派，不含真实发音位置 |
| 非空 | 字段不存在 | 纯文本对齐：ASR 词级时间戳 + 用户歌词校准 | **实测**：词级边界误差约 100–300 ms（见「已知限制」） |
| 空数组 | 字段不存在 | LRC 未启用 `--split-words`，或该行时长不足以拆分 | 无词级信息 |

即：**只要 `wordsSource` 存在就说明是均分/推导值**；`words` 非空且没有该字段才是真实对齐。

```json
[
  { "text": "First line here", "startMs": 500, "endMs": 3250,
    "words": [ { "word": "First", "startMs": 500, "endMs": 1558 },
               { "word": "line", "startMs": 1558, "endMs": 2404 },
               { "word": "here", "startMs": 2404, "endMs": 3250 } ],
    "wordsSource": "split-estimated" }
]
```

消费端建议：`wordsSource === "split-estimated"` 时可用于逐字高亮的兜底（例如没有纯文本歌词、只有 LRC），但**不要**把它当作"歌手实际唱到该字的时间"去做画面精确卡点或对外声称词级对齐；要真实词级就请用户提供纯文本歌词走模式 2。

### 校验图（PNG）

上图＝波形 + 歌词行时间带（相邻行交替配色）；下图＝逐行时间条 + 词级刻度线。
标题给出音频名、行数/词数、词命中率、使用的分离与转写配置，校验警告也会写进标题。
命令行打印同样的校验结论：行数一致、时间单调、末行未超时长。

---

## 4. 已知限制

1. **首词时间依赖前导静音处理**。混音里音乐从头响时，本工具检测不到"静音"就不裁（例如实测中不分离的混音首词会落到 0 ms）；先分离人声轨即可恢复。若素材开头就是人声，首词起点以 ASR 判断为准，误差约 ±100 ms。
2. **词级边界精度约 100–300 ms**，慢歌/拖腔/气声会更大。用于卡点高亮够用，用于逐帧严格对齐不够。
3. **尾部静音不延长末词**：末词 `endMs` 是 ASR 判定的人声结束，通常早于音频总时长（若音频结尾有 1 s 静音，差值就有 1 s，这是真实情况而非 bug）。
4. **重复副歌**：同一句唱多次时按出现顺序与 ASR 序列一一对应，不会串行；但用户文本行序与演唱顺序不一致时校准会退化（表现为命中率明显下降 + 控制台告警）。
5. **中文**：分词器把中文按单字切、拉丁词按词切，中英混排可用。中文人声的 whisper 时间戳精度低于英文（尤其押韵长音），建议中文素材优先请用户提供 LRC（中文 LRC 路径已实战验证）；中文纯文本对齐路径的现状与验证建议见下节。
6. **无歌词则跳过**：用户不提供歌词时不要跑本工具（也不要用 ASR 结果反推歌词），画面改用纯节拍/段落驱动。
7. **耗时**（CPU 版 torch 实测）：Demucs `htdemucs` ≈ 0.6× 实时（30 s 音频 17.3 s），faster-whisper `small` int8 ≈ 0.7× 实时（30 s 音频 19.5 s，含约 2 s 模型加载）；短音频由固定启动开销主导（6.3 s 音频分别约 7.6 s / 6.1 s）。据此 5 分钟歌曲全链路约 6–8 分钟；换 CUDA 版 torch 后 `--device auto` 会自动用 GPU，可快数倍。
8. **不保证 ASR 文本质量**：转写文字只用于比对定位，最终文本永远是用户歌词；ASR 听错不影响输出文本，只影响时间戳。
9. **`--split-words` 的推导值不含空档信息**：均分把整行跨度（含行内换气、间奏空档）都摊进词里，行尾空档会被算进末词，长句/长间奏下误差可达秒级；它只保证「行内先后顺序 + 行总时长」正确。这是精度等级低于真实对齐的根本原因，输出已用 `wordsSource: "split-estimated"` 标注。

### 逐字按字符均分（消费端建议）

6.3 的卡拉 OK 约定：中文在词级时间戳基础上按字符均分即可（英文同理按字符或音节）。
若只要"一个字一个时间片"，LRC 路径可直接用 `--split-words` 让工具在 JSON 里摊好（带推导标记）；
若需要真正的逐字（比词更细）或想自己控制摊派方式，则用下面的消费端写法——工具默认不预生成，避免把"均分猜的"当成"测出来的"：

```ts
// 把一行切成逐字时间轴：字符等分，标点随前一个可见字符
const chars = [...line.text].filter((c) => /\S/.test(c));
const span = (line.endMs - line.startMs) / chars.length;
const karaoke = chars.map((c, i) => ({
  char: c,
  startMs: Math.round(line.startMs + i * span),
  endMs: Math.round(line.startMs + (i + 1) * span),
}));
```

优先级：真实对齐的 `words`（无 `wordsSource`）＞ `--split-words` 产出的 `words`（带标记，已按词长加权）＞ 消费端整行均分（`words` 为空的 LRC 路径）。

---

## 5. 实测参考（自测数据）

> 参考基线：用于判断数值"是否正常"，不是验收阈值；不同机器与版本会有范围内的差异。

自测素材：`ffmpeg` 内建 flite 合成语音
`Hello. This is a lyric alignment test. The quick brown fox jumps over the lazy dog.`
（前导静音 400 ms、尾部静音 400 ms，总长 6.30 s；真实起唱 0.57 s，人声结束 5.74 s）。

| 行 | 真值 | 纯语音 + 裁静音 | 混入音乐 + 不分离 | 混入音乐 + Demucs |
|---|---|---|---|---|
| L1 | 0.57–1.08 s | 0.50–0.82 s | **0.00**–0.84 s | 0.50–0.82 s |
| L2 | 1.28–2.86 s | 1.24–2.74 s | 1.24–2.74 s | 1.22–2.74 s |
| L3 | 2.99–5.74 s | 2.98–5.54 s | 2.98–5.54 s | 2.98–5.54 s |

词命中率 16/16，词级时间戳全程单调递增，末词 5.54 s < 音频 6.30 s（尾部静音 0.56 s）。

### 中文测试建议

- **中文 LRC 直读 + `--split-words` 已实战验证**（《达拉崩吧》流行曲：100 行 / 647 词；同秒多行的"时间重叠"警告属良性，不算失败）；
- **中文纯文本对齐路径（`--audio` + `--text`，走 Demucs + faster-whisper）尚无实测样例**——首次使用建议先取小样验证：

1. 找一段**中文人声清唱或有伴奏的歌**（30–60 s 即可），准备好逐行歌词文本；
2. `& $py scripts/audio/align-lyrics.py --audio demo.mp3 --text lyrics-zh.txt --language zh --out lyrics.zh.json`；
3. 看控制台命中率（低于 70% 说明歌词与音频不匹配或行序错），再看校验图里时间条是否压在人声波形上；
4. 关注中文的两个典型偏差：① 长音拖腔时词尾偏早；② 快速咬字时相邻字被合并。若偏差超过 300 ms，建议改请用户提供 LRC。

---

## 6. 相关文件

- 上游音乐分析：`scripts/audio/analyze-music.py`（`audio-analysis.json`，本工具不依赖它）
- 下游裁切：`scripts/audio/cut-to-length.py`（按拍点网格裁切 BGM 与歌词）
