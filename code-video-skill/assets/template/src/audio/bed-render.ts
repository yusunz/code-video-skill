/**
 * 音床的**合成层**：把 `bed-plan.ts` 排好的事件表在离线 AudioContext 里落成样本。
 *
 * 两条纪律：
 * 1. 全部用振荡器与合成器（MembraneSynth / Synth / Oscillator / MetalSynth），
 *    **不用噪声源**：噪声缓冲每次生成都不一样（音效库里的 impact 实测两次生成有 56%
 *    的样本不同、最大 -16dB），而全振荡器配方重跑只差 ±1 LSB（-90dBFS 量级）。
 *    落点音因此没有复用音效库里的 impact（那条带 NoiseSynth 碎裂声），改用全振荡器版本。
 *
 *    注意：±1 LSB 仍不是逐字节一致 —— Web Audio 的浮点求和顺序每次渲染略有不同，
 *    与视频端"帧级一致、文件字节会漂移"是同一性质。资产一律以落盘那一份为准。
 * 2. 采样级收尾（精确长度 / 淡入淡出）与归一化在这里做，事件表本身只描述"什么时候响"。
 */
import * as Tone from "tone";
import type { BedEvent, BedPlan } from "./bed-plan";
import { SFX_DEFINITIONS } from "./sfx-definitions";

/** 指数斜坡不允许从 0 起，统一用一个极小的非零值。 */
const SILENCE = 0.0008;

const findDefinition = (name: string) => {
  const found = SFX_DEFINITIONS.find((item) => item.name === name);
  if (!found) throw new Error(`音效定义缺失：${name}`);
  return found;
};

/** 节奏层 · 底鼓：MembraneSynth 的低频冲击，落在强拍上。 */
const scheduleKicks = (
  plan: BedPlan,
  destination: Tone.ToneAudioNode,
): void => {
  if (plan.kicks.length === 0) return;

  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.028,
    octaves: 4,
    oscillator: { type: "sine" },
    envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.36 },
  });
  kick.connect(destination);

  for (const event of plan.kicks) {
    kick.triggerAttackRelease("C1", 0.3, event.at, event.gain);
  }
};

/** 节奏层 · 滴答：极短的三角波，当拍点指针用。 */
const scheduleTicks = (
  plan: BedPlan,
  destination: Tone.ToneAudioNode,
): void => {
  if (plan.ticks.length === 0) return;

  const tick = new Tone.Synth({
    oscillator: { type: "triangle" },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.025 },
  });
  tick.volume.value = -2;
  tick.connect(destination);

  for (const event of plan.ticks) {
    tick.triggerAttackRelease("A5", 0.04, event.at, event.gain);
  }
};

/** 氛围层 · 持续垫音：三个失谐振荡器 + 缓慢低通扫频 + 分段增益包络。 */
const schedulePad = (plan: BedPlan, destination: Tone.ToneAudioNode): void => {
  const bus = new Tone.Gain(0);
  bus.connect(destination);

  const filter = new Tone.Filter({ type: "lowpass", frequency: 620, Q: 0.9 });
  filter.connect(bus);

  // A2 / E3 / A3：空五度堆叠，不指定大小调，留给画面去定情绪
  const voices = [
    { frequency: 110, type: "sine", detune: -7, gain: 0.6 },
    { frequency: 164.81, type: "triangle", detune: 6, gain: 0.32 },
    { frequency: 220, type: "sine", detune: -11, gain: 0.26 },
  ] as const;

  for (const voice of voices) {
    const oscillator = new Tone.Oscillator({
      frequency: voice.frequency,
      type: voice.type,
      detune: voice.detune,
    });
    const gain = new Tone.Gain(voice.gain);
    oscillator.connect(gain);
    gain.connect(filter);
    oscillator.start(0);
    oscillator.stop(plan.pad.sustainedUntil + 0.05);
  }

  const end = Math.max(plan.pad.sustainedUntil, 0.1);
  filter.frequency.setValueAtTime(520, 0);
  filter.frequency.linearRampToValueAtTime(1500, end * 0.45);
  filter.frequency.linearRampToValueAtTime(680, end);

  // 增益包络：10fps 采样点直接铺成 setValueAtTime，包络形状由编排层决定
  for (const point of plan.pad.envelope) {
    bus.gain.setValueAtTime(Math.max(SILENCE, point.gain), point.at);
  }
  const last = plan.pad.envelope[plan.pad.envelope.length - 1];
  bus.gain.setValueAtTime(Math.max(SILENCE, last?.gain ?? SILENCE), end);
  bus.gain.linearRampToValueAtTime(0, end + 0.05);
};

/** 点缀 · riser：锯齿波上行 + 带通扫频，抬到切换点上。 */
const scheduleRisers = (
  plan: BedPlan,
  destination: Tone.ToneAudioNode,
): void => {
  for (const riser of plan.risers) {
    const oscillator = new Tone.Oscillator({ frequency: 92, type: "sawtooth" });
    const filter = new Tone.Filter({
      type: "bandpass",
      frequency: 260,
      Q: 1.3,
    });
    const gain = new Tone.Gain(SILENCE);

    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(destination);

    const endsAt = riser.at + riser.lengthSeconds;
    oscillator.frequency.setValueAtTime(92, riser.at);
    oscillator.frequency.exponentialRampToValueAtTime(430, endsAt);
    filter.frequency.setValueAtTime(260, riser.at);
    filter.frequency.exponentialRampToValueAtTime(6500, endsAt);
    gain.gain.setValueAtTime(SILENCE, riser.at);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(SILENCE, riser.gain),
      endsAt - riser.lengthSeconds * 0.08,
    );
    gain.gain.exponentialRampToValueAtTime(SILENCE, endsAt);

    oscillator.start(riser.at);
    oscillator.stop(endsAt + 0.02);
  }
};

/**
 * 点缀 · 落点音：低频下潜 + 金属瞬态 + 延迟尾音。
 * 与音效库里的 impact 同源，但去掉 NoiseSynth 的碎裂声以保证可复现。
 */
const scheduleImpacts = (
  plan: BedPlan,
  destination: Tone.ToneAudioNode,
): void => {
  for (const event of plan.impacts) {
    const bus = new Tone.Gain(event.gain);
    bus.connect(destination);

    const tail = new Tone.FeedbackDelay({
      delayTime: 0.12,
      feedback: 0.32,
      wet: 1,
    });
    const tailFilter = new Tone.Filter({
      type: "lowpass",
      frequency: 3000,
      Q: 0.7,
    });
    const tailGain = new Tone.Gain(0.3);
    tail.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(bus);

    const sub = new Tone.MembraneSynth({
      pitchDecay: 0.045,
      octaves: 5,
      oscillator: { type: "sine" },
      envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.5 },
    });
    sub.volume.value = -6;
    sub.connect(bus);
    sub.triggerAttackRelease("C1", 0.42, event.at);

    const metal = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.36, sustain: 0, release: 0.3 },
      harmonicity: 4.6,
      modulationIndex: 18,
      resonance: 3600,
      octaves: 1.2,
    });
    metal.volume.value = -18;
    metal.connect(tail);
    metal.triggerAttackRelease("C3", 0.3, event.at);
  }
};

/** 收尾音：直接复用音效库的 outro 配方，挂到音床总线上。 */
const scheduleOutro = (
  plan: BedPlan,
  destination: Tone.ToneAudioNode,
): void => {
  if (!plan.outro) return;

  const bus = new Tone.Gain(plan.outro.gain);
  bus.connect(destination);
  findDefinition("outro").build(plan.outro.at, bus);
};

/** 在离线上下文里把整张音床渲染成 AudioBuffer（长度按 Tone.Offline 的时长）。 */
export function renderBed(
  plan: BedPlan,
  sampleRate: number,
): Promise<Tone.ToneAudioBuffer> {
  return Tone.Offline(
    () => {
      const master = new Tone.Limiter(-1).toDestination();
      scheduleKicks(plan, master);
      scheduleTicks(plan, master);
      schedulePad(plan, master);
      scheduleRisers(plan, master);
      scheduleImpacts(plan, master);
      scheduleOutro(plan, master);
    },
    plan.durationInSeconds,
    1,
    sampleRate,
  );
}

/**
 * 采样级收尾：把渲染结果整理成"恰好 N 个样本"并做边界淡入淡出。
 * 时长精确到样本（`samples / sampleRate`），首尾各淡一段，杜绝硬切爆音。
 */
export function finalizeBedSamples(
  samples: Float32Array,
  options: {
    readonly sampleRate: number;
    readonly durationInSeconds: number;
    readonly fadeInSeconds: number;
    readonly fadeOutSeconds: number;
  },
): Float32Array {
  const target = Math.round(options.durationInSeconds * options.sampleRate);
  const output = new Float32Array(target);
  output.set(samples.subarray(0, Math.min(target, samples.length)));

  const fadeIn = Math.min(
    Math.round(options.fadeInSeconds * options.sampleRate),
    target,
  );
  for (let index = 0; index < fadeIn; index += 1) {
    output[index] *= index / fadeIn;
  }

  const fadeOut = Math.min(
    Math.round(options.fadeOutSeconds * options.sampleRate),
    target,
  );
  for (let index = 0; index < fadeOut; index += 1) {
    output[target - 1 - index] *= index / fadeOut;
  }

  return output;
}

/** 事件表里最响的一次增益：写进报告，方便对照"编排意图 vs 实测峰值"。 */
export const peakEventGain = (plan: BedPlan): number =>
  Math.max(
    0,
    ...plan.kicks.map((event: BedEvent) => event.gain),
    ...plan.ticks.map((event: BedEvent) => event.gain),
    ...plan.impacts.map((event: BedEvent) => event.gain),
    plan.outro?.gain ?? 0,
  );
