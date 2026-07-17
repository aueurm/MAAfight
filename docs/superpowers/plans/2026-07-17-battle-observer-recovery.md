# 过程观察器结算校验与暂停恢复 Implementation Plan

**Goal:** 不让战斗画面误报结算；暂停时自动恢复并继续观察真实结果。

**Architecture:** 在现有 `screenObserver.ts` 添加两个固定 ROI 判断：结果标题和暂停标题。结算调用点统一要求“标题 + 星标”；`observeMaaBattle` 命中暂停后复用现有 MaaCore 点击截图通道，立即复查一次。

## 1. 回归测试

**Files:** `__tests__/ScreenObserver.test.ts`

1. 为合成 BGR 增加结果标题和暂停标题填充辅助函数。
2. 断言只有星标而没有结果标题的帧不被视为结算。
3. 让过程观察序列依次返回暂停帧、播放后的普通帧、真实结果帧，断言点击播放并最终返回 `settled`。
4. 让播放后的立即截图仍为暂停，断言返回 `paused` 且保留两帧。

Run: `npm test -- --runInBand __tests__/ScreenObserver.test.ts`

## 2. 最小实现

**Files:** `src/runner/screenObserver.ts`

1. 添加已校准的结果标题与暂停标题 ROI；导出其判断函数供测试使用。
2. 让 `observeMaaScreen` 和 `observeMaaBattle` 都只接受“已识别星标且命中结果标题”的结算。
3. 扩展过程观察公开状态为 `paused`；保存暂停帧后点击一次播放并立即复查。复查仍暂停即结束，恢复则继续常规采样。
4. 不新增依赖、配置项或 CLI 参数。

Run: `npm run build:node`

Run: `npm test`

## 3. 演习验证

1. 使用现有 11-20 候选重新启动演习并运行 `run observe-battle`。
2. 检查清单：战斗帧不得提前写 `settled`；若暂停，必须出现恢复警告和恢复后的帧；最终结果以结算页为准。
3. 依据真实结算和末段帧，再决定是否调整候选生成器。
