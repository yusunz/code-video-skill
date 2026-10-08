import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile, useVideoConfig } from "remotion";
import {
  SEGMENT_P5_DURATION_IN_FRAMES,
  SEGMENT_P5_START_FRAME,
  SEGMENT_THREE_DURATION_IN_FRAMES,
  SEGMENT_THREE_START_FRAME,
  SFX_MASTER_VOLUME,
  SFX_TIMELINE,
} from "./config";
import { P5Segment, ThreeSegment } from "./segments";
import { COLORS } from "./theme";

/**
 * 音效轨。
 *
 * Tone.js 只在制作阶段（`npm run sfx`）离线渲染出 WAV 资产，渲染期这里
 * 只负责"按时挂载"，不涉及任何实时音频生成。
 */
const SfxTrack: React.FC = () => {
  const { fps } = useVideoConfig();
  const volume = (clipVolume: number) => clipVolume * SFX_MASTER_VOLUME;

  return (
    <>
      <Audio
        src={staticFile("audio/sfx/whoosh.wav")}
        from={SFX_TIMELINE.whooshToThree.from}
        volume={volume(SFX_TIMELINE.whooshToThree.volume)}
        premountFor={fps}
      />
      <Audio
        src={staticFile("audio/sfx/impact.wav")}
        from={SFX_TIMELINE.impactAtThree.from}
        volume={volume(SFX_TIMELINE.impactAtThree.volume)}
        premountFor={fps}
      />
      <Audio
        src={staticFile("audio/sfx/outro.wav")}
        from={SFX_TIMELINE.outro.from}
        volume={volume(SFX_TIMELINE.outro.volume)}
        premountFor={fps}
      />
    </>
  );
};

/**
 * 成片：10.0 秒 / 300 帧 / 30fps / 1920×1080。
 *
 * 两个段落首尾相接且不留空隙：
 *   0–5s   p5.js 手绘
 *   5–10s  three.js 3D
 *
 * 加段落就在 config.ts 里补时长与起始帧，然后在这里补一个 <Sequence>。
 */
export const Main: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink }}>
      <Sequence
        from={SEGMENT_P5_START_FRAME}
        durationInFrames={SEGMENT_P5_DURATION_IN_FRAMES}
      >
        <P5Segment />
      </Sequence>
      <Sequence
        from={SEGMENT_THREE_START_FRAME}
        durationInFrames={SEGMENT_THREE_DURATION_IN_FRAMES}
      >
        <ThreeSegment />
      </Sequence>
      <SfxTrack />
    </AbsoluteFill>
  );
};
