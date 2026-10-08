import * as Tone from "tone";
import { planBed, type BedGrid } from "./bed-plan";
import {
  finalizeBedSamples,
  peakEventGain,
  renderBed as renderBedBuffer,
} from "./bed-render";
import { SFX_DEFINITIONS } from "./sfx-definitions";
import { encodeWav } from "./wav";

/** 与成片音频一致的采样率，避免后续再重采样。 */
const SAMPLE_RATE = 44100;

export type RenderedSfx = {
  readonly name: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationInSeconds: number;
  readonly bytes: number;
  readonly peakDb: number;
  readonly wavBase64: string;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    for (let index = offset; index < end; index++) {
      binary += String.fromCharCode(bytes[index]);
    }
  }

  return btoa(binary);
};

const toDecibel = (amplitude: number) =>
  amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;

const renderSfx = async (name: string): Promise<RenderedSfx> => {
  const definition = SFX_DEFINITIONS.find((item) => item.name === name);
  if (!definition) {
    throw new Error(`未知音效：${name}`);
  }

  // Tone.Offline：在离线 AudioContext 里跑完合成，返回渲染好的 AudioBuffer。
  const buffer = await Tone.Offline(
    () => {
      definition.build();
    },
    definition.durationInSeconds,
    1,
    SAMPLE_RATE,
  );

  const samples = buffer.getChannelData(0);
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    const magnitude = Math.abs(samples[index]);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }

  const wav = encodeWav([samples], buffer.sampleRate);

  return {
    name: definition.name,
    sampleRate: buffer.sampleRate,
    channels: 1,
    durationInSeconds: buffer.length / buffer.sampleRate,
    bytes: wav.byteLength,
    peakDb: toDecibel(peak),
    wavBase64: bytesToBase64(wav),
  };
};

/** 生成前的能力探测：确认"真 Web Audio"离线渲染在无头环境里可用。 */
const probe = async () => {
  const offlineSupported = typeof OfflineAudioContext !== "undefined";
  const probeContext = offlineSupported
    ? new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE)
    : null;

  return {
    userAgent: navigator.userAgent,
    toneVersion: (Tone as unknown as { version: string }).version,
    offlineSupported,
    offlineSampleRate: probeContext?.sampleRate ?? null,
    standardSampleRate: SAMPLE_RATE,
  };
};

export type SfxListItem = {
  readonly name: string;
  readonly durationInSeconds: number;
  readonly method: string;
};

/** 音床请求：`scripts/generate-bed.mjs` 按命令行参数拼好后传进浏览器。 */
export type BedRequest = {
  readonly durationInSeconds: number;
  /** 0..1 */
  readonly intensity: number;
  /** 段落切换点（秒）；留空则按 `transitionEverySeconds` 自动铺 */
  readonly transitions: readonly number[];
  readonly transitionEverySeconds: number;
  /** 归一化目标峰值（dBFS）：音床默认 -3，给上层的音效留余量 */
  readonly peakDb: number;
  readonly grid: BedGrid;
};

export type RenderedBed = {
  readonly sampleRate: number;
  readonly channels: number;
  readonly samples: number;
  /** 精确时长 = samples / sampleRate */
  readonly durationInSeconds: number;
  readonly bytes: number;
  readonly peakDbBeforeNormalize: number;
  readonly peakDb: number;
  readonly plan: {
    readonly bpm: number;
    readonly beatIntervalSeconds: number;
    readonly intensity: number;
    readonly transitions: readonly number[];
    readonly counts: ReturnType<typeof planBed>["counts"];
    readonly padSustainedUntil: number;
    readonly loudestEventGain: number;
  };
  readonly wavBase64: string;
};

const renderBed = async (request: BedRequest): Promise<RenderedBed> => {
  const plan = planBed({
    durationInSeconds: request.durationInSeconds,
    intensity: request.intensity,
    transitions: request.transitions,
    transitionEverySeconds: request.transitionEverySeconds,
    grid: request.grid,
  });

  const buffer = await renderBedBuffer(plan, SAMPLE_RATE);
  const samples = finalizeBedSamples(buffer.getChannelData(0), {
    sampleRate: SAMPLE_RATE,
    durationInSeconds: plan.durationInSeconds,
    fadeInSeconds: plan.fadeInSeconds,
    fadeOutSeconds: plan.fadeOutSeconds,
  });

  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index]);
    if (magnitude > peak) peak = magnitude;
  }

  const wav = encodeWav([samples], SAMPLE_RATE, { peakDb: request.peakDb });

  return {
    sampleRate: SAMPLE_RATE,
    channels: 1,
    samples: samples.length,
    durationInSeconds: samples.length / SAMPLE_RATE,
    bytes: wav.byteLength,
    peakDbBeforeNormalize: toDecibel(peak),
    peakDb: request.peakDb,
    plan: {
      bpm: plan.bpm,
      beatIntervalSeconds: plan.beatIntervalSeconds,
      intensity: plan.intensity,
      transitions: plan.transitions,
      counts: plan.counts,
      padSustainedUntil: plan.pad.sustainedUntil,
      loudestEventGain: peakEventGain(plan),
    },
    wavBase64: bytesToBase64(wav),
  };
};

declare global {
  interface Window {
    AudioForge: {
      readonly list: () => SfxListItem[];
      readonly render: (name: string) => Promise<RenderedSfx>;
      readonly renderBed: (request: BedRequest) => Promise<RenderedBed>;
      readonly probe: () => Promise<Awaited<ReturnType<typeof probe>>>;
    };
  }
}

window.AudioForge = {
  list: () =>
    SFX_DEFINITIONS.map((item) => ({
      name: item.name,
      durationInSeconds: item.durationInSeconds,
      method: item.method,
    })),
  render: renderSfx,
  renderBed,
  probe,
};
