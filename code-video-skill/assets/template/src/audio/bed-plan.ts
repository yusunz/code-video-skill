/**
 * 无音频兜底 BGM 的**编排层**。
 *
 * 输入"目标时长 + 拍点网格 + 强度"，输出一张纯数据的事件表：
 *   · 节奏层：底鼓落强拍（downbeats）、滴答落拍点、强度高时补反拍；
 *   · 氛围层：持续垫音 + 一条 10fps 的增益包络（有能量数据时跟随能量起伏）；
 *   · 点缀：riser 在段落切换前抬起、impact 正好压在切换点、收尾音贴齐拍点。
 *
 * 这里不碰 Tone、不碰 Web Audio —— 编排规则可以单独阅读、单独核对；
 * 合成实现见 `bed-render.ts`，命令行入口见 `scripts/generate-bed.mjs`。
 */

/** 没有拍点数据时的默认 BPM。 */
export const DEFAULT_BPM = 120;
/** 没有显式给段落切换点时的默认间隔（秒）。 */
export const DEFAULT_TRANSITION_EVERY_SECONDS = 10;
/** 收尾音时长：与 `sfx-definitions.ts` 里的 outro 一致，编排时用它给垫音让位。 */
export const OUTRO_DURATION_IN_SECONDS = 1.6;
/** 垫音包络的采样率：包络只描述"呼吸"，10fps 足够，也让自动化事件保持轻量。 */
const PAD_ENVELOPE_FPS = 10;
/** 采样级淡入淡出：足够压掉边界爆音，又短到听不出"渐入"。 */
const FADE_IN_SECONDS = 0.25;
const FADE_OUT_SECONDS = 0.4;

export type BedGrid = {
  /** 固定 BPM：`beats` 为空时用它现推拍点网格 */
  readonly bpm: number;
  readonly beats: readonly number[];
  /** 强拍（4/4 的第 1 拍）；为空时按"每 4 拍一个"推导 */
  readonly downbeats: readonly number[];
  /** 能量包络（0..1），索引 i 对应 t = i / levelsFps；没有就传空数组 */
  readonly levels: readonly number[];
  readonly levelsFps: number;
};

export type BedSpec = {
  readonly durationInSeconds: number;
  /** 0..1：越大越密越响（底鼓密度、滴答密度、点缀响度） */
  readonly intensity: number;
  /** 段落切换点（秒）；留空则按 `transitionEverySeconds` 自动铺 */
  readonly transitions: readonly number[];
  readonly transitionEverySeconds: number;
  readonly grid: BedGrid;
};

export type BedEvent = {
  readonly at: number;
  readonly gain: number;
};

export type BedRiser = {
  readonly at: number;
  readonly lengthSeconds: number;
  readonly gain: number;
};

export type BedPoint = {
  readonly at: number;
  readonly gain: number;
};

export type BedPlan = {
  readonly durationInSeconds: number;
  readonly bpm: number;
  readonly intensity: number;
  readonly beatIntervalSeconds: number;
  readonly transitions: readonly number[];
  readonly kicks: readonly BedEvent[];
  readonly ticks: readonly BedEvent[];
  readonly risers: readonly BedRiser[];
  readonly impacts: readonly BedEvent[];
  readonly outro: BedEvent | null;
  readonly pad: {
    readonly baseGain: number;
    /** 垫音增益包络（10fps） */
    readonly envelope: readonly BedPoint[];
    /** 垫音持续到哪一刻（之后交给收尾音） */
    readonly sustainedUntil: number;
  };
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
  readonly counts: {
    readonly beats: number;
    readonly downbeats: number;
    readonly kicks: number;
    readonly ticks: number;
    readonly risers: number;
    readonly impacts: number;
    readonly transitions: number;
    readonly hasOutro: boolean;
  };
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** 事件离首尾太近会被采样级淡入淡出吃掉，直接不排。 */
const KEEP_AWAY_FROM_EDGE_SECONDS = 0.05;
/**
 * 显式切换点的吸附容差。
 * 切换点是视频的剪辑点，impact 必须压在那一帧上——所以只在"请求的时刻本来就
 * 贴着拍点"时做毫秒级微调，绝不为了对齐把落点挪走（自动铺的才吸到强拍）。
 */
const EXPLICIT_TRANSITION_SNAP_TOLERANCE_SECONDS = 0.06;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** 网格归一化：没有 beats 就用 BPM 现推；没有 downbeats 就每 4 拍取一个。 */
function normalizeGrid(grid: BedGrid, durationInSeconds: number) {
  const bpm = grid.bpm > 0 ? grid.bpm : DEFAULT_BPM;
  const beats = (
    grid.beats.length > 0
      ? [...grid.beats]
      : buildBeatGrid(bpm, durationInSeconds)
  )
    .filter(
      (beat) => Number.isFinite(beat) && beat >= 0 && beat < durationInSeconds,
    )
    .sort((a, b) => a - b);

  const downbeats = (
    grid.downbeats.length > 0
      ? [...grid.downbeats]
      : beats.filter((_, index) => index % 4 === 0)
  )
    .filter(
      (beat) => Number.isFinite(beat) && beat >= 0 && beat < durationInSeconds,
    )
    .sort((a, b) => a - b);

  const intervals: number[] = [];
  for (let index = 1; index < beats.length; index += 1) {
    intervals.push(beats[index] - beats[index - 1]);
  }

  return {
    bpm,
    beats,
    downbeats,
    beatIntervalSeconds: intervals.length > 0 ? median(intervals) : 60 / bpm,
  };
}

/** 固定 BPM 网格：t = 0, 1 拍, 2 拍 …（不含末尾）。 */
export function buildBeatGrid(
  bpm: number,
  durationInSeconds: number,
): number[] {
  const interval = 60 / (bpm > 0 ? bpm : DEFAULT_BPM);
  const beats: number[] = [];
  for (let index = 0; index * interval < durationInSeconds; index += 1) {
    beats.push(index * interval);
  }
  return beats;
}

/** 吸附到最近的网格点（优先强拍）；没有网格就原样返回。 */
function snapToGrid(
  at: number,
  primary: readonly number[],
  fallback: readonly number[],
): number {
  const grid = primary.length > 0 ? primary : fallback;
  if (grid.length === 0) return at;

  let best = grid[0];
  for (const point of grid) {
    if (Math.abs(point - at) < Math.abs(best - at)) best = point;
  }
  return best;
}

/** 只在容差内吸附：超出容差就保留请求的原时刻。 */
function snapWithinTolerance(
  at: number,
  grid: readonly number[],
  toleranceSeconds: number,
): number {
  if (grid.length === 0) return at;
  let best = grid[0];
  for (const point of grid) {
    if (Math.abs(point - at) < Math.abs(best - at)) best = point;
  }
  return Math.abs(best - at) <= toleranceSeconds ? best : at;
}

/**
 * 段落切换点：
 * - 显式给的：只在"本来就贴着拍点"时微调（切换点是视频剪辑点，impact 必须压在那一帧）；
 * - 没给的：按固定间隔自动铺，吸附到最近的强拍。
 */
function resolveTransitions(
  spec: BedSpec,
  downbeats: readonly number[],
  beats: readonly number[],
  durationInSeconds: number,
): number[] {
  const inRange = (value: number) =>
    Number.isFinite(value) &&
    value > KEEP_AWAY_FROM_EDGE_SECONDS &&
    value < durationInSeconds - KEEP_AWAY_FROM_EDGE_SECONDS;

  const explicit = [...new Set(spec.transitions)]
    .filter(inRange)
    .sort((a, b) => a - b);
  if (explicit.length > 0) {
    return explicit.map((at) =>
      snapWithinTolerance(
        at,
        beats,
        EXPLICIT_TRANSITION_SNAP_TOLERANCE_SECONDS,
      ),
    );
  }

  const every =
    spec.transitionEverySeconds > 0
      ? spec.transitionEverySeconds
      : DEFAULT_TRANSITION_EVERY_SECONDS;
  const generated: number[] = [];
  for (
    let at = every;
    at < durationInSeconds - KEEP_AWAY_FROM_EDGE_SECONDS;
    at += every
  ) {
    generated.push(snapToGrid(at, downbeats, beats));
  }
  return [...new Set(generated)].sort((a, b) => a - b);
}

/**
 * 垫音包络。
 * - 起手 1.2s 的 swell，避免"一上来就是满音量"；
 * - 有能量数据就跟随（重映射到 0.6~1.0，垫音不会消失）；
 * - 收尾音进来之前让位，避免两层层叠互相糊住。
 */
function buildPadEnvelope(options: {
  durationInSeconds: number;
  intensity: number;
  levels: readonly number[];
  levelsFps: number;
  sustainedUntil: number;
}) {
  const { durationInSeconds, intensity, levels, levelsFps, sustainedUntil } =
    options;
  const baseGain = 0.22 + 0.1 * intensity;
  const swellSeconds = Math.min(1.2, sustainedUntil * 0.3);
  /** 收尾前的释放：垫音不能"咔"一下断掉，要让给收尾音。 */
  const releaseSeconds = Math.min(0.25, sustainedUntil * 0.1);
  const step = 1 / PAD_ENVELOPE_FPS;
  const envelope: BedPoint[] = [];

  const levelAt = (at: number) => {
    if (levels.length > 0 && levelsFps > 0) {
      const index = clamp(Math.round(at * levelsFps), 0, levels.length - 1);
      return clamp(levels[index], 0, 1);
    }
    // 没有能量数据：用一条缓慢的呼吸曲线（周期取片长的 1/3，限制在 6~16s）
    const period = clamp(durationInSeconds / 3, 6, 16);
    return 0.5 + 0.5 * Math.sin((2 * Math.PI * at) / period);
  };

  for (let at = 0; at < sustainedUntil; at += step) {
    const swell = swellSeconds > 0 ? clamp(at / swellSeconds, 0, 1) : 1;
    const release =
      releaseSeconds > 0
        ? clamp((sustainedUntil - at) / releaseSeconds, 0, 1)
        : 1;
    envelope.push({
      at: Number(at.toFixed(4)),
      gain: Number(
        (baseGain * swell * release * (0.6 + 0.4 * levelAt(at))).toFixed(5),
      ),
    });
  }

  return { baseGain, envelope, sustainedUntil };
}

/**
 * 编排一张音床。
 * 事件表里所有时间都是"秒"，绝对时间轴；采样级收尾（精确长度 / 淡入淡出 / 归一化）
 * 由 `bed-render.ts` 负责。
 */
export function planBed(spec: BedSpec): BedPlan {
  const durationInSeconds = Math.max(1, spec.durationInSeconds);
  const intensity = clamp(spec.intensity, 0, 1);
  const grid = normalizeGrid(spec.grid, durationInSeconds);
  const { beats, downbeats, beatIntervalSeconds, bpm } = grid;

  const kicks: BedEvent[] = [];
  const kickGain = 0.72 + 0.28 * intensity;
  // 强度低时底鼓减半（每两小节一次），避免稀疏内容里律动过密
  const kickStride = intensity < 0.35 ? 2 : 1;
  downbeats.forEach((at, index) => {
    if (index % kickStride !== 0) return;
    if (at < KEEP_AWAY_FROM_EDGE_SECONDS || at > durationInSeconds - 0.1)
      return;
    kicks.push({ at, gain: kickGain });
  });

  // 滴答要在垫音之上听得见，又不能在底鼓面前抢戏：0.5 强度下约比底鼓低 5dB
  const tickGain = 0.42 + 0.32 * intensity;
  const ticks: BedEvent[] = [];
  for (const at of beats) {
    if (
      at < KEEP_AWAY_FROM_EDGE_SECONDS ||
      at > durationInSeconds - KEEP_AWAY_FROM_EDGE_SECONDS
    ) {
      continue;
    }
    ticks.push({ at, gain: tickGain });
    // 强度高时补反拍（8 分音符的另一半）
    if (intensity >= 0.65) {
      const offbeat = at + beatIntervalSeconds / 2;
      if (offbeat < durationInSeconds - KEEP_AWAY_FROM_EDGE_SECONDS) {
        ticks.push({ at: offbeat, gain: tickGain * 0.7 });
      }
    }
  }

  const transitions = resolveTransitions(
    spec,
    downbeats,
    beats,
    durationInSeconds,
  );
  const riserLength = Math.min(
    beatIntervalSeconds * 2,
    Math.max(0.4, beatIntervalSeconds),
  );
  const risers: BedRiser[] = [];
  const impacts: BedEvent[] = [];
  for (const at of transitions) {
    impacts.push({ at, gain: 0.7 + 0.3 * intensity });
    if (at - riserLength > 0) {
      risers.push({
        at: at - riserLength,
        lengthSeconds: riserLength,
        gain: 0.3 + 0.36 * intensity,
      });
    }
  }

  // 收尾音贴着片尾（它的尾巴正好落在最后一帧上）；拍点近在容差内时才微调
  const outroTarget = durationInSeconds - OUTRO_DURATION_IN_SECONDS;
  const outroAt =
    outroTarget > 0.5
      ? snapWithinTolerance(
          outroTarget,
          beats,
          EXPLICIT_TRANSITION_SNAP_TOLERANCE_SECONDS,
        )
      : Number.NaN;
  const outro = Number.isFinite(outroAt) ? { at: outroAt, gain: 0.85 } : null;

  const pad = buildPadEnvelope({
    durationInSeconds,
    intensity,
    levels: spec.grid.levels,
    levelsFps: spec.grid.levelsFps,
    sustainedUntil: outro ? outro.at : durationInSeconds,
  });

  return {
    durationInSeconds,
    bpm,
    intensity,
    beatIntervalSeconds,
    transitions,
    kicks,
    ticks,
    risers,
    impacts,
    outro,
    pad,
    fadeInSeconds: Math.min(FADE_IN_SECONDS, durationInSeconds / 4),
    fadeOutSeconds: Math.min(FADE_OUT_SECONDS, durationInSeconds / 4),
    counts: {
      beats: beats.length,
      downbeats: downbeats.length,
      kicks: kicks.length,
      ticks: ticks.length,
      risers: risers.length,
      impacts: impacts.length,
      transitions: transitions.length,
      hasOutro: outro !== null,
    },
  };
}
