# 能力地图：画风 → 技术选型（参考）

选型参考，不是规定。同一画风可以用不同手段实现，判据是"最省事 + 逐帧可复现"。
具体 API 与写法一律读官方 remotion-* skills（先 `remotion-best-practices` 路由器），
本文件只给路由与边界。

## 1 选型速查

| 画风 / 目标 | 首选手段 | 该读的领域知识 | 备注 |
|---|---|---|---|
| 2D 动效、排版、数据可视化 | Remotion（DOM / SVG / Canvas） | `remotion-markup` | 文字排版最省事；数据图可用 d3（自行加依赖）算路径，再交给 SVG 绘制 |
| 手绘、插画、生成艺术、程序化纹理 | p5.js 2.x（2D canvas）+ rough.js | `remotion-markup`（时序部分）+ 本 skill 集成坑 | instance mode + `noLoop()` + 固定种子；不要开 WEBGL |
| 3D 场景、科幻、HUD、粒子、抽象 | three.js（经 `@remotion/three` 的 `<ThreeCanvas>`） | `remotion-markup`（3D 一节） | 禁用 `useFrame()`；位移 / 旋转由帧号推导 |
| 字幕、卡拉 OK、逐字高亮 | Remotion DOM + Caption 模型 | `remotion-captions` | 我们的 `lyrics.json` 兼容 Caption 结构并扩展到词级 |
| 音乐可视化（波形 / 脉冲 / 频谱感） | Remotion DOM / SVG / Canvas，读 `levels` / `beats` | `remotion-markup`（audio、audio-visualization） | 不在渲染期做音频分析：数据离线算好写进 JSON |
| 地图 / 地理动画 | 见对应 remotion maps 技能 | `remotion-maps` | 需要地图服务凭据时先问用户 |
| 转场、运动模糊、光效 | 内置或自写组件 | `remotion-markup`（transitions、motion-blur、effects、light-leaks） | 不要自己造已有的轮子 |

## 2 组合与图层

同一帧可以叠加多层，**DOM 顺序即 z 序**（自下而上）：

```text
底层   <ThreeBackdropScene />    WebGL 背景
中层   <P5OverlayScene />       透明 2D canvas（p5 前景）
上层   <Hud />                  Remotion DOM（标题 / 字幕 / 数据）
```

模板的 `assets/template/src/segments.tsx` 就是这种装配方式，可直接照搬结构。

## 3 决策提示

- 要精确文字排版、响应式布局、复杂 DOM 结构 → Remotion。
- 要逐像素笔触、程序化纹理、手绘质感、粒子噪声 → p5。
- 要真透视相机、光照、材质 → three。
- 纯 2D 用 three 会平白增加相机 / 光照 / 坐标系的调试面；纯排版用 p5 会失去文本度量能力。
- 3D 一律走 three；p5 只开 2D canvas。

## 4 明确不做

- 写实素材混合：不把 imagegen 图像、AI 视频素材嵌进画面，链路保持单一代码渲染管线。
- 不引入视频生成模型。
- 不在本 skill 里重写 Remotion API 教程——环境缺 remotion skills 时提示安装，不凭记忆硬写。

## 5 依赖提示

模板已锁版本的依赖：remotion 4.0.532（含 `@remotion/cli` / `@remotion/three` / `@remotion/media`）、
three 0.186.1、p5 2.3.4、roughjs 4.6.6、tone 15.1.22——精确清单见 `assets/template/package.json`。
选型超出这些依赖时（例如 d3），在用户项目里按精确版本追加并更新 lockfile，不要手改 `node_modules/`。
