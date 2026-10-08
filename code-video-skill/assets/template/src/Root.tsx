import { Composition } from "remotion";
import {
  SEGMENT_P5_DURATION_IN_FRAMES,
  SEGMENT_THREE_DURATION_IN_FRAMES,
  TOTAL_DURATION_IN_FRAMES,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from "./config";
import { Main } from "./Main";
import { P5Segment, ThreeSegment } from "./segments";

const sharedProps = {
  fps: VIDEO_FPS,
  width: VIDEO_WIDTH,
  height: VIDEO_HEIGHT,
} as const;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Main"
        component={Main}
        durationInFrames={TOTAL_DURATION_IN_FRAMES}
        {...sharedProps}
      />
      {/* 下面两个是单段落 composition：用于逐段抽帧自检，不进成片 */}
      <Composition
        id="SegP5"
        component={P5Segment}
        durationInFrames={SEGMENT_P5_DURATION_IN_FRAMES}
        {...sharedProps}
      />
      <Composition
        id="SegThree"
        component={ThreeSegment}
        durationInFrames={SEGMENT_THREE_DURATION_IN_FRAMES}
        {...sharedProps}
      />
    </>
  );
};
