/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setRspack(true);
/*
 * 固定 WebGL 后端为 swangle（ANGLE 的软件光栅化实现）：
 * 实测同一段帧序列用默认 GPU 后端渲染两次，会有 1 LSB 级别的像素差异
 * （PNG PSNR ≈ 102dB，肉眼不可见但破坏字节级复现）；换成 swangle 后
 * 两次渲染逐帧字节一致，且画质与 GPU 后端差异仅相当于重采样噪声（PSNR ≈ 55dB）。
 * 注意：swangle 保证的是"帧"级一致；MP4 文件本身仍会因编码器线程调度产生字节漂移，
 * 复现验收请看帧序列（still SHA256 / framemd5），不要比 MP4 文件哈希。
 * 对照实验与量化结论见 README「踩坑与结论」一节。
 */
Config.setChromiumOpenGlRenderer("swangle");
// WebGL 画面使用 PNG 中间帧：JPEG 中间帧会产出全范围色彩（yuvj420p），
// 且在深色渐变上容易出现色带；PNG 中间帧对应标准的 limited-range yuv420p。
Config.setVideoImageFormat("png");
Config.setColorSpace("bt709");
Config.setCodec("h264");
Config.setOverwriteOutput(true);
