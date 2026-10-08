import * as Tone from "tone";

/**
 * 音效即代码：每个音效都是一段 Tone.js 合成描述，离线渲染成 WAV 之后才进入成片。
 *
 * 约定：
 * - 所有节点都在 `Tone.Offline()` 的离线上下文里创建、触发、结束；
 * - 一律用显式的 setValueAtTime / ramp 描述包络，不用 LFO 或自动化依赖真实时间；
 * - `build()` 必须是纯函数式的"排布"，跑第二遍必须得到同样的样本。
 * - `build(at, destination)`：`at` 是该音效在时间轴上的绝对起点，`destination` 是总
 *   输出节点。离线渲染单个资产时两者都用默认值（0 / 离线目的地）；音床编排
 *   （`bed-render.ts`）传各自落点与音床总线，同一条配方两处复用。
 */
export type SfxDefinition = {
  readonly name: string;
  readonly durationInSeconds: number;
  /** 写进报告的合成方式说明 */
  readonly method: string;
  readonly build: (at?: number, destination?: Tone.ToneAudioNode) => void;
};

/** 总输出：默认为当前上下文的 destination（离线渲染时就是离线目的地）。 */
const outputOf = (destination?: Tone.ToneAudioNode) =>
  destination ?? Tone.getDestination();

/** 极小的非零起点：指数斜坡不允许从 0 开始。 */
const SILENCE = 0.0008;

/**
 * whoosh：粉噪声 → 带通扫频（300Hz → 5.6kHz → 700Hz），叠加一层棕噪声低频体感。
 * 包络在 0.4s 附近成形、实测峰值约 0.45s；时间轴提前量以 config.ts 的
 * WHOOSH_LEAD_IN_SECONDS（0.45）为准，让峰值压在段落切换帧上。
 */
const buildWhoosh = (at = 0, destination?: Tone.ToneAudioNode): void => {
  const master = new Tone.Gain(0.9);
  master.connect(outputOf(destination));

  const air = new Tone.Noise("pink").start(at);
  const airFilter = new Tone.Filter({
    type: "bandpass",
    frequency: 300,
    Q: 1.1,
  });
  const airGain = new Tone.Gain(SILENCE);
  air.connect(airFilter);
  airFilter.connect(airGain);
  airGain.connect(master);

  airFilter.frequency.setValueAtTime(300, at);
  airFilter.frequency.exponentialRampToValueAtTime(5600, at + 0.4);
  airFilter.frequency.exponentialRampToValueAtTime(700, at + 0.88);
  airGain.gain.setValueAtTime(SILENCE, at);
  airGain.gain.exponentialRampToValueAtTime(1, at + 0.4);
  airGain.gain.exponentialRampToValueAtTime(SILENCE, at + 0.88);

  const body = new Tone.Noise("brown").start(at);
  const bodyFilter = new Tone.Filter({
    type: "lowpass",
    frequency: 320,
    Q: 0.7,
  });
  const bodyGain = new Tone.Gain(SILENCE);
  body.connect(bodyFilter);
  bodyFilter.connect(bodyGain);
  bodyGain.connect(master);

  bodyFilter.frequency.setValueAtTime(180, at);
  bodyFilter.frequency.exponentialRampToValueAtTime(520, at + 0.4);
  bodyFilter.frequency.exponentialRampToValueAtTime(160, at + 0.88);
  bodyGain.gain.setValueAtTime(SILENCE, at);
  bodyGain.gain.exponentialRampToValueAtTime(0.55, at + 0.36);
  bodyGain.gain.exponentialRampToValueAtTime(SILENCE, at + 0.88);

  air.stop(at + 0.9);
  body.stop(at + 0.9);
};

/**
 * impact：MembraneSynth 低频冲击 + MetalSynth 金属瞬态 + NoiseSynth 高频碎裂。
 * 金属与碎裂经一条低频延音（延迟反馈）铺开尾巴，避免落点太干。
 */
const buildImpact = (at = 0, destination?: Tone.ToneAudioNode): void => {
  const limiter = new Tone.Limiter(-1);
  limiter.connect(outputOf(destination));

  const tail = new Tone.FeedbackDelay({
    delayTime: 0.11,
    feedback: 0.34,
    wet: 1,
  });
  const tailFilter = new Tone.Filter({
    type: "lowpass",
    frequency: 3200,
    Q: 0.7,
  });
  const tailGain = new Tone.Gain(0.34);
  tail.connect(tailFilter);
  tailFilter.connect(tailGain);
  tailGain.connect(limiter);

  const sub = new Tone.MembraneSynth({
    pitchDecay: 0.045,
    octaves: 5,
    oscillator: { type: "sine" },
    envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.5 },
  });
  sub.volume.value = -4;
  sub.connect(limiter);
  sub.triggerAttackRelease("C1", 0.42, at);

  const metal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.36, sustain: 0, release: 0.3 },
    harmonicity: 4.6,
    modulationIndex: 18,
    resonance: 3600,
    octaves: 1.2,
  });
  metal.volume.value = -16;
  metal.connect(tail);
  metal.triggerAttackRelease("C3", 0.3, at);

  const crack = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.13, sustain: 0, release: 0.06 },
  });
  const crackFilter = new Tone.Filter({
    type: "highpass",
    frequency: 1900,
  });
  crack.volume.value = -8;
  crack.connect(crackFilter);
  crackFilter.connect(tail);
  crack.triggerAttackRelease(0.1, at);
};

/**
 * outro：PolySynth 正弦钟声琶音 + 低音铺底，末尾自然收干。
 * 时长 1.6s，正好铺满 8.4s → 10.0s 的收尾。
 */
const buildOutro = (at = 0, destination?: Tone.ToneAudioNode): void => {
  const limiter = new Tone.Limiter(-1);
  limiter.connect(outputOf(destination));

  const echo = new Tone.FeedbackDelay({
    delayTime: 0.19,
    feedback: 0.36,
    wet: 0.34,
  });
  echo.connect(limiter);

  const bell = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.006, decay: 1.1, sustain: 0.02, release: 1.1 },
  });
  bell.volume.value = -13;
  bell.connect(echo);

  const notes: [string, number, number][] = [
    ["C5", 0.05, 0.55],
    ["E5", 0.18, 0.5],
    ["G5", 0.31, 0.45],
    ["B5", 0.46, 0.4],
    ["D6", 0.64, 0.32],
  ];
  notes.forEach(([note, time, velocity]) => {
    bell.triggerAttackRelease(note, 0.85, at + time, velocity);
  });

  const drone = new Tone.Oscillator({ frequency: 65.41, type: "sine" });
  const droneGain = new Tone.Gain(SILENCE);
  drone.connect(droneGain);
  droneGain.connect(limiter);
  drone.start(at);
  droneGain.gain.setValueAtTime(SILENCE, at);
  droneGain.gain.exponentialRampToValueAtTime(0.22, at + 0.25);
  droneGain.gain.exponentialRampToValueAtTime(SILENCE, at + 1.5);
  drone.stop(at + 1.6);
};

export const SFX_DEFINITIONS: readonly SfxDefinition[] = [
  {
    name: "whoosh",
    durationInSeconds: 0.9,
    method: "NoiseSynth/Noise + BiquadFilter 带通扫频 + 指数包络",
    build: buildWhoosh,
  },
  {
    name: "impact",
    durationInSeconds: 1.1,
    method:
      "MembraneSynth 低频冲击 + MetalSynth 金属瞬态 + NoiseSynth 碎裂 + FeedbackDelay 尾音",
    build: buildImpact,
  },
  {
    name: "outro",
    durationInSeconds: 1.6,
    method: "PolySynth(Synth) 正弦琶音 + Oscillator 低音铺底 + FeedbackDelay",
    build: buildOutro,
  },
];
