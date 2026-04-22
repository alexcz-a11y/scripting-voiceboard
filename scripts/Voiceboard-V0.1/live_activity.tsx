// Stage 4.5b — 生产版 Live Activity 注册。
// Stage 6b v4.2 — 灵动岛 UI（二次真机反馈后修正）：
//   · Compact: 仅 leading（删 trailing 图标，让 camera pill 物理占位）
//   · Expanded: 3 region 顺延 Apple HIG
//       Leading  (pill 左侧 + 下方 L 形): VOICEBOARD + 大图标(56pt) 竖排
//       Center   : 空占位（v4.1 放 Center 会挤占 Leading 视觉位置）
//       Trailing (pill 右侧 + 下方 wrap): 主文案 headline + caption
//                 使用 Spacer 把内容推到 region 底部 → 视觉上呈现在
//                 "pill 下方的中央偏右"（Trailing region wrap 下来的位置）
//                 alignment="trailing" + offset 微调让用户拖到满意位置
//       Bottom   : 不用
//   · Voiceboard Ink 品牌色板 · DynamicShapeStyle 自动 light/dark
//   · 视觉参数全部走 readTune(key, def)
//
// 演化记录：
//   v4   尝试 Leading/Trailing 两张圆角半透卡 → 真机卡片背景不渲染
//   v4.1 主文案放 Center region → 居中会挤占 Leading 图标视觉位置
//   v4.2 主文案放 Trailing region + Spacer 顶部 + 下 alignment=trailing
//        → pill 右侧 wrap 到下方右半，不干扰 Leading
//
// 参考: developer.apple.com/documentation/WidgetKit/DynamicIslandExpandedRegion
// 设计板: /tmp/voiceboard-design/dynamic-island.html
//
// 架构约束（reference/llms-full.md:4647）:
//   注册必须在独立文件 `live_activity.tsx`。不能塞进 index.tsx。
//
// LockScreenContent 留给 Step 3 处理，本阶段保持原状。

import {
  HStack,
  Image,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIBuilder,
  LiveActivityUIExpandedCenter,
  LiveActivityUIExpandedLeading,
  LiveActivityUIExpandedTrailing,
  Spacer,
  Text,
  VStack,
} from "scripting"
import { readTune, readTuneBool } from "./shared"

// --------------------------------------------------------------------------
// ContentState
// --------------------------------------------------------------------------

export type VBActivityStatus =
  | "warm"
  | "armed"
  | "transcribing"
  | "polishing"
  | "error"

export type VBActivityState = {
  status: VBActivityStatus
  remainingSec?: number
  elapsedSec?: number
  errorLabel?: string
}

// --------------------------------------------------------------------------
// Stage 6b — Voiceboard Ink 品牌色板（dynamic light/dark）
// --------------------------------------------------------------------------
// 与 keyboard.tsx 完全一致。iOS 自动按设备外观切换 light/dark hex。

const C_PRIMARY = { light: "#4F6BE8", dark: "#7C93FF" } as const
const C_URGENT  = { light: "#FF4B55", dark: "#FF6B72" } as const
const C_PROCESS = { light: "#F59E0B", dark: "#FBBF24" } as const
const C_SUCCESS = { light: "#10B981", dark: "#34D399" } as const
const C_ERROR   = { light: "#DC2626", dark: "#F87171" } as const

function statusBrandColor(
  status: VBActivityStatus
): { light: string; dark: string } {
  switch (status) {
    case "warm":          return C_PRIMARY
    case "armed":         return C_URGENT
    case "transcribing":
    case "polishing":     return C_PROCESS
    case "error":         return C_ERROR
  }
}

// KeywordsColor fallback —— LockScreenContent 仍用，Step 3 重写时升级。
function statusColor(
  status: VBActivityStatus
): "systemBlue" | "systemRed" | "systemOrange" | "systemYellow" {
  switch (status) {
    case "warm":          return "systemBlue"
    case "armed":         return "systemRed"
    case "transcribing":
    case "polishing":     return "systemOrange"
    case "error":         return "systemYellow"
  }
}

// --------------------------------------------------------------------------
// 时间格式化 + 文案
// --------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function fmtMMSS(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${pad2(m)}:${pad2(s % 60)}`
}

function fmtElapsed(sec: number): string {
  return `${Math.max(0, sec).toFixed(1)}s`
}

// LockScreen + 旧版 statusText（保留给 LockScreenContent 用）
function statusText(state: VBActivityState): string {
  switch (state.status) {
    case "warm":          return `保持中 · 剩余 ${fmtMMSS(state.remainingSec ?? 0)}`
    case "armed":         return `录音中 · ${fmtElapsed(state.elapsedSec ?? 0)}`
    case "transcribing":  return "转录中…"
    case "polishing":     return "润色中…"
    case "error":         return `错误 · ${state.errorLabel ?? "未知"}`
  }
}

// SF Symbol name for main icon
function statusSymbol(status: VBActivityStatus): string {
  switch (status) {
    case "warm":          return "waveform.badge.mic"
    case "armed":         return "mic.fill"
    case "transcribing":
    case "polishing":     return "arrow.triangle.2.circlepath"
    case "error":         return "exclamationmark.triangle.fill"
  }
}

// v4: Trailing 卡片内 headline 文字（仅状态名，不带前缀/后缀）
function trailingHeadline(state: VBActivityState): string {
  switch (state.status) {
    case "warm":          return "保持中"
    case "armed":         return "录音中"
    case "transcribing":  return "转录中…"
    case "polishing":     return "润色中…"
    case "error":         return state.errorLabel ?? "出错"
  }
}

// v4: Trailing 卡片内 caption 文字（mono 数字 / 模型名 / 重试提示）
function trailingCaption(state: VBActivityState): string {
  switch (state.status) {
    case "warm":          return `剩余 ${fmtMMSS(state.remainingSec ?? 0)}`
    case "armed":         return `已录 ${fmtElapsed(state.elapsedSec ?? 0)}`
    case "transcribing":  return "Scribe v2 · ElevenLabs"
    case "polishing":     return "gpt-5.4-mini · OpenAI"
    case "error":         return "打开主 app 重试"
  }
}

// --------------------------------------------------------------------------
// Stage 6b v4.2 — DI 视觉 tune 读取
// --------------------------------------------------------------------------
// builder 每次 iOS update 时重新调用（dts:7823），const tune = readDiTune()
// 每次重读 Storage → 调参面板 ≤1s（受 LA 1000ms 节流）生效。
//
// v4.2 变更（vs v4.1）：
//   · 主文案 tune 键名改回 `et.*`（因为实际渲染在 Trailing region 而非 Center）
//   · 新增 et.offsetX / et.offsetY（文案位置微调）
//   · 新增 et.spacerMinHeight（Trailing region 内顶部 Spacer 最小高度，
//     控制文案被推到 pill 下方的距离）

function readDiTune() {
  return {
    // ----- Compact Leading -----
    clIconSize:     readTune("di.cl.iconSize",   14),
    clTextSize:     readTune("di.cl.textSize",   12),
    clInnerGap:     readTune("di.cl.innerGap",    4),
    clPadH:         readTune("di.cl.padH",        6),
    clPadV:         readTune("di.cl.padV",        2),
    // ----- Minimal -----
    minIconSize:    readTune("di.min.iconSize",  16),
    // ----- Expanded Leading (pill 左侧 + 下方): VOICEBOARD + 大图标 -----
    // v4.3 真机锁定: el.offsetX=17 (整体往右 17pt，让 Leading 视觉重心在 pill 左下对齐)
    elIconSize:     readTune("di.el.iconSize",   56),
    elBrandIconGap: readTune("di.el.brandIconGap",4),
    elOffsetX:      readTune("di.el.offsetX",    17),  // 正值往右 / 负值往左
    elOffsetY:      readTune("di.el.offsetY",     0),  // 正值往下 / 负值往上
    // ----- Expanded Trailing (pill 右侧 + 下方 wrap): 主文案 headline + caption -----
    // v4.3 真机锁定: 文字字号 19/13 · offsetX=-154 把文案从 pill 右列拖回左对齐 Leading 后一列
    etHeadlineSize: readTune("di.et.headlineSize",19),
    etCaptionSize:  readTune("di.et.captionSize",13),
    etRowSpacing:   readTune("di.et.rowSpacing",  3),
    etOffsetX:      readTune("di.et.offsetX",  -154),  // 正值往右 / 负值往左
    etOffsetY:      readTune("di.et.offsetY",    -2),  // 正值往下 / 负值往上
    // ----- Voiceboard 品牌字（Leading 顶部） -----
    brandTextSize:  readTune("di.brand.textSize",11),
  }
}

function readDiTuneBool() {
  return {
    // 显示 Leading 顶部 "VOICEBOARD" 品牌字
    brandVisible:  readTuneBool("di.brand.visible", true),
  }
}

// --------------------------------------------------------------------------
// Sub-views
// --------------------------------------------------------------------------

// 锁屏 + 非 DI 设备的 banner —— Step 2 原样保留，Step 3 处理。
function LockScreenContent(state: VBActivityState) {
  const color = statusColor(state.status)
  return (
    <HStack padding={14} spacing={12}>
      <Image systemName={statusSymbol(state.status)} foregroundStyle={color} />
      <VStack alignment="leading" spacing={2}>
        <Text font="headline">{statusText(state)}</Text>
        <Text font="caption" foregroundStyle="secondaryLabel">
          Voiceboard · 语音输入
        </Text>
      </VStack>
      <Spacer />
    </HStack>
  )
}

// DI 收缩态左侧：warm 显示 mm:ss，armed 显示 N.Ns，其余单图标。
function CompactLeading(state: VBActivityState) {
  const tune = readDiTune()
  const color = statusBrandColor(state.status)
  if (state.status === "warm" || state.status === "armed") {
    const rightText =
      state.status === "warm"
        ? fmtMMSS(state.remainingSec ?? 0)
        : fmtElapsed(state.elapsedSec ?? 0)
    return (
      <HStack
        spacing={tune.clInnerGap}
        padding={{ horizontal: tune.clPadH, vertical: tune.clPadV }}
      >
        <Image
          systemName={statusSymbol(state.status)}
          foregroundStyle={color}
          font={tune.clIconSize}
        />
        <Text font={tune.clTextSize} foregroundStyle={color} monospacedDigit>
          {rightText}
        </Text>
      </HStack>
    )
  }
  return (
    <Image
      systemName={statusSymbol(state.status)}
      foregroundStyle={color}
      font={tune.clIconSize}
      padding={{ horizontal: tune.clPadH, vertical: tune.clPadV }}
    />
  )
}

// v4: DI 收缩态右侧 —— 不放内容，让 camera pill 物理占位。
// （iOS 要求 compactTrailing 必须有 element，给空 Text 占位。）
function CompactTrailing(_state: VBActivityState) {
  return <Text>{""}</Text>
}

// DI 最小化（多 LA 合并时）：单图标。
function Minimal(state: VBActivityState) {
  const tune = readDiTune()
  return (
    <Image
      systemName={statusSymbol(state.status)}
      foregroundStyle={statusBrandColor(state.status)}
      font={tune.minIconSize}
    />
  )
}

// v4.2: DI 展开态左侧（pill 左侧 + 下方）—— VOICEBOARD 品牌字 + 大图标 竖排。
// 无卡片背景（真机不渲染，回到 SwiftUI 默认布局）。
// offset 让用户微调整体位置。
function ExpandedLeading(state: VBActivityState) {
  const tune = readDiTune()
  const bools = readDiTuneBool()
  const color = statusBrandColor(state.status)
  return (
    <VStack
      alignment="center"
      spacing={tune.elBrandIconGap}
      offset={{ x: tune.elOffsetX, y: tune.elOffsetY }}
    >
      {bools.brandVisible ? (
        <Text
          font={tune.brandTextSize}
          foregroundStyle="secondaryLabel"
          bold
        >
          VOICEBOARD
        </Text>
      ) : (
        <Text>{""}</Text>
      )}
      <Image
        systemName={statusSymbol(state.status)}
        foregroundStyle={color}
        font={tune.elIconSize}
      />
    </VStack>
  )
}

// v4.2: DI 展开态右侧（pill 右侧 + 下方 wrap）—— 主文案 headline + caption。
//
// 布局策略：
//   VStack alignment="leading"   ← 两行首字左侧垂直对齐
//     ├ Spacer          (把内容推到 region 底部，避开 pill 高度)
//     ├ Text headline   (主状态文字, 状态色 bold)
//     └ Text caption    (mono 时码/模型/重试提示, secondaryLabel)
//   offset={{ x: etOffsetX, y: etOffsetY }}  (用户微调左右/上下)
//
// 效果: 文案显示在 pill 右侧 wrap 下来的区域（视觉上在"下方中心偏右"），
// 两行文字的**首字左边垂直对齐**（而非右对齐），不与 Leading 的
// VOICEBOARD + 图标视觉重叠。
function ExpandedTrailing(state: VBActivityState) {
  const tune = readDiTune()
  const color = statusBrandColor(state.status)
  return (
    <VStack
      alignment="leading"
      spacing={tune.etRowSpacing}
      offset={{ x: tune.etOffsetX, y: tune.etOffsetY }}
    >
      <Spacer />
      <Text font={tune.etHeadlineSize} foregroundStyle={color} bold>
        {trailingHeadline(state)}
      </Text>
      <Text
        font={tune.etCaptionSize}
        foregroundStyle="secondaryLabel"
        monospacedDigit
      >
        {trailingCaption(state)}
      </Text>
    </VStack>
  )
}

// v4.2: DI 展开态中部 —— 空占位。主文案移到 Trailing region。
// （v4.1 尝试放 Center 会让文案与 Leading 图标水平位置冲突，故移除。）
function ExpandedCenter(_state: VBActivityState) {
  return <Text>{""}</Text>
}

// --------------------------------------------------------------------------
// Builder 注册
// --------------------------------------------------------------------------

const builder: LiveActivityUIBuilder<VBActivityState> = (state) => {
  return (
    <LiveActivityUI
      content={<LockScreenContent {...state} />}
      compactLeading={<CompactLeading {...state} />}
      compactTrailing={<CompactTrailing {...state} />}
      minimal={<Minimal {...state} />}
    >
      <LiveActivityUIExpandedLeading>
        <ExpandedLeading {...state} />
      </LiveActivityUIExpandedLeading>
      <LiveActivityUIExpandedTrailing>
        <ExpandedTrailing {...state} />
      </LiveActivityUIExpandedTrailing>
      <LiveActivityUIExpandedCenter>
        <ExpandedCenter {...state} />
      </LiveActivityUIExpandedCenter>
    </LiveActivityUI>
  )
}

export const VoiceboardWarmActivity = LiveActivity.register(
  "VoiceboardWarm",
  builder
)
