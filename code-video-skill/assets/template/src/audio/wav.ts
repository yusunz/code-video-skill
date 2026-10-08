/**
 * 极简 WAV 编码器（16bit PCM）。
 *
 * 之所以自己写而不是引依赖：Tone.js 的离线结果就是 Float32 样本，
 * 这里只是把样本落成文件，逻辑足够小、可读、可测；同时顺手做一次峰值归一化，
 * 让三个音效的响度口径一致，也不需要渲染期再做二次处理。
 */
export type WavEncodeOptions = {
  /** 归一化目标峰值（dBFS）。默认 -1.5dB，留出余量避免解码后削波。 */
  readonly peakDb?: number;
};

const writeAscii = (view: DataView, offset: number, text: string) => {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
};

export const encodeWav = (
  channels: readonly Float32Array[],
  sampleRate: number,
  options: WavEncodeOptions = {},
): Uint8Array => {
  if (channels.length === 0) {
    throw new Error("encodeWav 至少需要一条声道");
  }

  const peakDb = options.peakDb ?? -1.5;
  const channelCount = channels.length;
  const frameCount = channels[0].length;

  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) {
      const magnitude = Math.abs(channel[index]);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
  }

  const scale = peak > 0 ? 10 ** (peakDb / 20) / peak : 1;
  const bytesPerSample = 2;
  const dataBytes = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const scaled = channels[channel][frame] * scale;
      const clamped = Math.max(-1, Math.min(1, scaled));
      view.setInt16(
        offset,
        clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
        true,
      );
      offset += bytesPerSample;
    }
  }

  return new Uint8Array(buffer);
};
