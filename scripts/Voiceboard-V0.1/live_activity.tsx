// Stage 4.5b — 生产版 Live Activity 注册。
// Stage 6b v4 — 灵动岛 UI 打磨：
//   · Compact: 仅 leading（删 trailing 图标，让 camera pill 物理占位）
//   · Expanded: 不对称布局 围绕 TrueDepth pill
//       Leading region:
//         顶部 brand label "VOICEBOARD"（pill 左侧空间）
//         下方 Leading 圆角卡片 · 同心 cornerRadius 32 · 大图标(56pt) 居中
//       Trailing region:
//         整个 Trailing 是一张大横卡 · 同心 cornerRadius 32
//         内含 VStack(headline + caption) 居中
//       Center region: 不用，返回空 Text
//       Bottom region: 不加
//   · Voiceboard Ink 品牌色板 · DynamicShapeStyle 自动 light/dark
//   · 视觉参数全部走 readTune(key, def)，主 app 调参面板热调
//
// 参考: Apple HIG concentric corners (内卡片 r = 外壳 r − padding = 44 − 12 = 32)
// 设计板: /tmp/voiceboard-design/dynamic-island.html (v4 锁定)
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
// Stage 6b v4 — DI 视觉 tune 读取
// --------------------------------------------------------------------------
// builder 是 iOS 每次 activity.update 时重新调用的函数（dts:7823），
// 所以 const tune = readDiTune() 每次都拿最新 Storage 值。
// 调参面板写 Storage → ≤1s 生效（受 LA 1000ms 节流）。

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
    // ----- Expanded Leading 卡 -----
    elLeftPad:      readTune("di.el.leftPad",    12),
    elWidth:        readTune("di.el.width",     121),
    elIconSize:     readTune("di.el.iconSize",   56),
    // ----- Expanded Trailing 卡 -----
    etRightPad:     readTune("di.et.rightPad",   12),
    etHeadlineSize: readTune("di.et.headlineSize",17),
    etCaptionSize:  readTune("di.et.captionSize",12),
    etRowSpacing:   readTune("di.et.rowSpacing",  3),
    // ----- 通用（两卡共享） -----
    exCardGap:      readTune("di.ex.cardGap",     8),
    exTopPad:       readTune("di.ex.topPad",     55),
    exBottomPad:    readTune("di.ex.bottomPad",  12),
    exCardRadius:   readTune("di.ex.cardRadius", 32),
    exCardPad:      readTune("di.ex.cardPad",    12),
    // ----- Voiceboard 品牌字（Leading 上方 pill 左侧空间） -----
    brandTextSize:  readTune("di.brand.textSize",11),
  }
}

function readDiTuneBool() {
  return {
    // 显示 Leading 上方 "VOICEBOARD" 品牌字
    brandVisible:  readTuneBool("di.brand.visible",  true),
    // Leading/Trailing 卡片背景显示（关掉就是无背景透明卡）
    cardsVisible:  readTuneBool("di.cards.visible",  true),
  }
}

// 半透白色卡片背景 hex (RRGGBBAA): 0x14 ≈ 8% alpha
const CARD_BG = "#FFFFFF14"

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

// v4: DI 展开态左侧 —— VOICEBOARD 品牌字 + Leading 圆角卡 + 大图标。
//
// 布局策略（SwiftUI region 内）：
//   VStack(spacing=4)
//     ├ Text "VOICEBOARD"  (顶部, 在 pill 左侧空间内自然落位)
//     └ VStack 卡片         (Leading 卡片本体, 大图标居中)
//         · background = CARD_BG (半透白)
//         · cornerRadius = 32 (concentric)
//         · frame width = elWidth (121pt)
//         · padding 内 → 大图标居中
//
// brandVisible / cardsVisible 控制开关。
function ExpandedLeading(state: VBActivityState) {
  const tune = readDiTune()
  const bools = readDiTuneBool()
  const color = statusBrandColor(state.status)

  const icon = (
    <Image
      systemName={statusSymbol(state.status)}
      foregroundStyle={color}
      font={tune.elIconSize}
    />
  )

  // 卡片包装：cardsVisible=true 时套圆角背景，否则裸图标
  const card = bools.cardsVisible ? (
    <VStack
      alignment="center"
      padding={tune.exCardPad}
      background={CARD_BG}
      cornerRadius={tune.exCardRadius}
      frame={{ width: tune.elWidth }}
    >
      {icon}
    </VStack>
  ) : (
    <VStack
      alignment="center"
      padding={tune.exCardPad}
      frame={{ width: tune.elWidth }}
    >
      {icon}
    </VStack>
  )

  return (
    <VStack alignment="center" spacing={4}>
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
      {card}
    </VStack>
  )
}

// v4: DI 展开态右侧 —— 整张大横卡承载主文案。
//
//   VStack 卡片
//     · background = CARD_BG · cornerRadius = 32
//     · padding 12
//     · 内 VStack(spacing=3) headline + caption 居中
function ExpandedTrailing(state: VBActivityState) {
  const tune = readDiTune()
  const bools = readDiTuneBool()
  const color = statusBrandColor(state.status)

  const inner = (
    <VStack alignment="center" spacing={tune.etRowSpacing}>
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

  if (bools.cardsVisible) {
    return (
      <VStack
        alignment="center"
        padding={tune.exCardPad}
        background={CARD_BG}
        cornerRadius={tune.exCardRadius}
      >
        {inner}
      </VStack>
    )
  }
  return (
    <VStack alignment="center" padding={tune.exCardPad}>
      {inner}
    </VStack>
  )
}

// v4: DI 展开态中部 —— 不用 Center region，Trailing 卡承载所有主文案。
// API 要求 LiveActivityUIExpandedCenter 必须有 element，给空 Text 占位。
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
