import { AbsoluteFill } from "remotion";
import { Hud } from "./components/Hud";
import {
  SEGMENT_P5_START_FRAME,
  SEGMENT_THREE_START_FRAME,
  TOTAL_DURATION_IN_FRAMES,
  VIDEO_TITLE,
} from "./config";
import { ExampleP5Scene } from "./scenes/ExampleP5Scene";
import { ExampleThreeScene } from "./scenes/ExampleThreeScene";
import { COLORS } from "./theme";

const hudBase = {
  header: VIDEO_TITLE,
  globalTotalFrames: TOTAL_DURATION_IN_FRAMES,
} as const;

/**
 * 段落 1：p5.js 手绘。
 * 每个段落都是"场景层 + HUD 层"的两层结构，HUD 同时是抽帧自检的定位凭证。
 */
export const P5Segment: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.paper }}>
      <ExampleP5Scene />
      <Hud
        {...hudBase}
        index="01"
        title="p5.js 手绘"
        tech="instance mode · noLoop · 固定随机种子 · rough.js 手绘线条"
        accent={COLORS.cyan}
        globalStartFrame={SEGMENT_P5_START_FRAME}
      />
    </AbsoluteFill>
  );
};

/** 段落 2：three.js 3D。 */
export const ThreeSegment: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink }}>
      <ExampleThreeScene />
      <Hud
        {...hudBase}
        index="02"
        title="three.js 3D"
        tech="@remotion/three ThreeCanvas · 帧号驱动的相机与自转"
        accent="#a78bfa"
        globalStartFrame={SEGMENT_THREE_START_FRAME}
      />
    </AbsoluteFill>
  );
};
