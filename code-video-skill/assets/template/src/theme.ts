/** 三个段落共用的视觉基调，避免各场景各写一套色值。 */
export const COLORS = {
  /** 最深的底色，也是段落切换时的过渡底色 */
  ink: "#070b14",
  /** p5 手绘段的纸面底色 */
  paper: "#0d1524",
  /** 蓝图网格线 */
  grid: "#1b2c47",
  /** 手绘线条的墨色（偏暖的纸白） */
  chalk: "#e8e3d3",
  /** 主强调色：冷青 */
  cyan: "#7fd4ff",
  /** 次强调色：暖琥珀 */
  amber: "#ffb347",
  /** HUD 文字 */
  hudText: "#a9bcdd",
  hudDim: "#6f83a8",
} as const;

export const FONT_MONO = 'Consolas, "Cascadia Mono", "Courier New", monospace';
export const FONT_UI =
  '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, Arial, sans-serif';

/**
 * `#rrggbb` + 透明度 → `rgba(...)`。
 * p5 的 color 解析对 8 位十六进制的支持不牢靠，统一走这里最稳。
 */
export const rgba = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
