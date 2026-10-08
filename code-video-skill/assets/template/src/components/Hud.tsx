import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { SHOW_DEBUG_HUD } from "../config";
import { COLORS, FONT_MONO, FONT_UI, rgba } from "../theme";

type HudProps = {
  /** HUD 顶栏文字：通常传成片标题（`config.ts` 的 `VIDEO_TITLE`） */
  readonly header: string;
  /** 段落序号，例如 "01" */
  readonly index: string;
  readonly title: string;
  readonly tech: string;
  readonly accent: string;
  /** 该段落在成片中的起始帧，用来显示全局帧号与总进度 */
  readonly globalStartFrame: number;
  readonly globalTotalFrames: number;
};

/**
 * Remotion 自己的 DOM 图层：标题 +（可选）调试层 + 进度条。
 *
 * 调试层（帧号 / 分镜卡）由 config.ts 的 SHOW_DEBUG_HUD 控制，仅用于抽帧自检定位；
 * 交付成片保持关闭——帧号、秒数、分镜信息不进入成品（见 SKILL 硬约束"成片清洁"）。
 */
export const Hud: React.FC<HudProps> = ({
  header,
  index,
  title,
  tech,
  accent,
  globalStartFrame,
  globalTotalFrames,
}) => {
  const frame = useCurrentFrame();
  const globalFrame = globalStartFrame + frame;

  const enter = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  const progress = globalFrame / (globalTotalFrames - 1);

  return (
    <AbsoluteFill
      style={{
        padding: 64,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        fontFamily: FONT_UI,
        color: COLORS.hudText,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          opacity: enter,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 24,
            letterSpacing: 6,
            color: COLORS.hudText,
          }}
        >
          {header}
        </div>
        {SHOW_DEBUG_HUD ? (
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 26,
              fontVariantNumeric: "tabular-nums",
              color: COLORS.hudDim,
            }}
          >
            {`FRAME ${String(globalFrame).padStart(3, "0")} / ${globalTotalFrames}`}
          </div>
        ) : null}
      </div>

      <div
        style={{
          opacity: enter,
          translate: interpolate(frame, [0, 20], ["0px 26px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        {SHOW_DEBUG_HUD ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 22,
              padding: "20px 30px",
              borderRadius: 16,
              border: `1px solid ${rgba(accent, 0.35)}`,
              backgroundColor: "rgba(5, 8, 16, 0.62)",
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 34,
                fontWeight: 600,
                color: accent,
                letterSpacing: 2,
              }}
            >
              {index}
            </div>
            <div
              style={{
                width: 1,
                alignSelf: "stretch",
                backgroundColor: rgba(accent, 0.3),
              }}
            />
            <div>
              <div
                style={{
                  fontSize: 48,
                  fontWeight: 600,
                  lineHeight: 1.12,
                  color: "#eaf1ff",
                }}
              >
                {title}
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 24,
                  letterSpacing: 1,
                  color: COLORS.hudDim,
                }}
              >
                {tech}
              </div>
            </div>
          </div>
        ) : null}

        <div
          style={{
            marginTop: 26,
            height: 6,
            borderRadius: 3,
            backgroundColor: "rgba(24, 34, 54, 0.9)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${progress * 100}%`,
              borderRadius: 3,
              backgroundColor: accent,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
