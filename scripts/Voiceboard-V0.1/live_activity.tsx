// Stage 4.5b — 生产版 Live Activity 注册。
//
// 设计目标：
//   1. 保活角色：根据 Scripting 官方文档（reference/llms-full.md:57 + 148），
//      后台持续录音要求 Live Activity 全程 active。所以 LA 不是 UI polish，
//      它是机制的组成部分，4.5b 必须集成。
//   2. 功能性 UI：显示当前 warm/armed/transcribing/polishing/error 状态 +
//      剩余秒数（warm）或录音时长（armed）。不追求美观，留到 4.5c/6 迭代。
//   3. 单 activity 实例：index.tsx 的 startWarmSession 创建一个实例存在
//      模块级变量里，update/end 都走这个实例；不用 Scripting 的静态
//      LiveActivity.from() 查询（不跨 session 共享）。
//
// 架构约束（reference/llms-full.md:4647）：
//   注册必须在独立文件 `live_activity.tsx`。不能塞进 index.tsx。

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

// ContentState discriminated by `status`。optional 字段只在某些 status 下
// 才有意义（warm 用 remainingSec，armed 用 elapsedSec），但 union 里全
// 都 optional 比较好写，消费侧自己按 status 看哪个字段。
export type VBActivityStatus =
  | "warm"
  | "armed"
  | "transcribing"
  | "polishing"
  | "error"

export type VBActivityState = {
  status: VBActivityStatus
  // warm 态：剩余保持时间（秒）。armed/processing/error 下忽略。
  remainingSec?: number
  // armed 态：当次录音已录秒数。warm/processing/error 下忽略。
  elapsedSec?: number
  // error 态：错误信息的简短标签（"录音失败"/"转录失败"...）。其他态忽略。
  errorLabel?: string
}

// --------------------------------------------------------------------------
// 小工具：时间格式化 + 状态文案 / 配色
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
  // armed 下希望看到小数点，给用户"正在计时"的感觉
  return `${Math.max(0, sec).toFixed(1)}s`
}

function statusText(state: VBActivityState): string {
  switch (state.status) {
    case "warm":
      return `保持中 · 剩余 ${fmtMMSS(state.remainingSec ?? 0)}`
    case "armed":
      return `录音中 · ${fmtElapsed(state.elapsedSec ?? 0)}`
    case "transcribing":
      return "转录中…"
    case "polishing":
      return "润色中…"
    case "error":
      return `错误 · ${state.errorLabel ?? "未知"}`
  }
}

// SF Symbol name for main icon (compactLeading + minimal + lock screen).
function statusSymbol(status: VBActivityStatus): string {
  switch (status) {
    case "warm":
      return "waveform.badge.mic"
    case "armed":
      return "mic.fill"
    case "transcribing":
    case "polishing":
      return "arrow.triangle.2.circlepath"
    case "error":
      return "exclamationmark.triangle.fill"
  }
}

// Keyword color for the main icon / accent.
function statusColor(status: VBActivityStatus):
  | "systemBlue"
  | "systemRed"
  | "systemOrange"
  | "systemYellow" {
  switch (status) {
    case "warm":
      return "systemBlue"
    case "armed":
      return "systemRed"
    case "transcribing":
    case "polishing":
      return "systemOrange"
    case "error":
      return "systemYellow"
  }
}

// --------------------------------------------------------------------------
// Sub-views
// --------------------------------------------------------------------------

// 锁屏 + 非 DI 设备的 banner 展示。两行：主状态 + 辅助信息。
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

// DI 收缩态左侧：图标 + 主指标（warm: mm:ss；armed: 小数秒；processing: 旋转；error: !）。
// 这一侧实际上 iOS 只给很窄一列，保持极简。
function CompactLeading(state: VBActivityState) {
  const color = statusColor(state.status)
  if (state.status === "warm") {
    return (
      <HStack spacing={3}>
        <Image systemName="waveform" foregroundStyle={color} />
        <Text font="caption">{fmtMMSS(state.remainingSec ?? 0)}</Text>
      </HStack>
    )
  }
  if (state.status === "armed") {
    return (
      <HStack spacing={3}>
        <Image systemName="mic.fill" foregroundStyle="systemRed" />
        <Text font="caption">{fmtElapsed(state.elapsedSec ?? 0)}</Text>
      </HStack>
    )
  }
  if (state.status === "transcribing" || state.status === "polishing") {
    return (
      <Image
        systemName="arrow.triangle.2.circlepath"
        foregroundStyle={color}
      />
    )
  }
  // error
  return (
    <Image systemName="exclamationmark.triangle.fill" foregroundStyle={color} />
  )
}

// DI 收缩态右侧：仅一个辅助图标，按状态变色。
function CompactTrailing(state: VBActivityState) {
  return (
    <Image
      systemName="waveform.circle.fill"
      foregroundStyle={statusColor(state.status)}
    />
  )
}

// DI 最小化（DI 合并到别的 activity 时）：单图标兜底。
function Minimal(state: VBActivityState) {
  return (
    <Image
      systemName={statusSymbol(state.status)}
      foregroundStyle={statusColor(state.status)}
    />
  )
}

// DI 展开态（用户长按灵动岛后展开）：更详细的信息。
function ExpandedCenter(state: VBActivityState) {
  return (
    <VStack alignment="leading" padding={10} spacing={4}>
      <HStack spacing={6}>
        <Image
          systemName={statusSymbol(state.status)}
          foregroundStyle={statusColor(state.status)}
        />
        <Text font="headline">{statusText(state)}</Text>
      </HStack>
      <Text font="caption" foregroundStyle="secondaryLabel">
        Voiceboard
      </Text>
    </VStack>
  )
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
        <Image
          systemName={statusSymbol(state.status)}
          foregroundStyle={statusColor(state.status)}
          padding={8}
        />
      </LiveActivityUIExpandedLeading>
      <LiveActivityUIExpandedTrailing>
        <Text font="caption" padding={8}>
          Voiceboard
        </Text>
      </LiveActivityUIExpandedTrailing>
      <LiveActivityUIExpandedCenter>
        <ExpandedCenter {...state} />
      </LiveActivityUIExpandedCenter>
    </LiveActivityUI>
  )
}

// `LiveActivity.register` 返回一个工厂函数；每次调用才真正拿到 instance。
// index.tsx 的 startWarmSession 里 `VoiceboardWarmActivity()` 拿到 instance
// 存在模块级 `warmActivity` 变量里，update/end 都走这一个 instance。
export const VoiceboardWarmActivity = LiveActivity.register(
  "VoiceboardWarm",
  builder
)
