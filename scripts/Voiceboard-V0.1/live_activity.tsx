// Stage 4.5a demo — 最小 Live Activity 注册。
//
// 功能面：只做"状态 + 剩余秒数"的单行展示，锁屏 / 灵动岛 / minimal
// 各给一套最朴素的渲染。目的是先验证 LiveActivity API 能跑通 + iOS 真的把
// Scripting 当作"有长任务"来对待。美化留到 4.5c / Stage 6。
//
// 架构面：此文件必须独立存在（`reference/llms-full.md:4647`：注册必须
// 放在单独的文件里），然后从 index.tsx 里 `import { VoiceboardWarmActivity }`
// 调用 `VoiceboardWarmActivity()` 拿到 instance，再 `.start()/.update()/.end()`。

import {
  HStack,
  Image,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIBuilder,
  LiveActivityUIExpandedCenter,
  Spacer,
  Text,
  VStack,
} from "scripting"

// 4.5a demo 阶段用最朴素的 ContentState：status 字符串 + 剩余秒数 + 可选
// 标签（实验 id "A1"/"A2"…）。4.5b 升级生产版本时会扩成带 armed/elapsed
// 等分支的 discriminated union；保持这个 shape 向前兼容即可。
export type VBActivityState = {
  status: string
  remainingSec: number
  label?: string
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function fmtMMSS(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${pad2(m)}:${pad2(s % 60)}`
}

function ContentView(state: VBActivityState) {
  return (
    <HStack padding={12} spacing={10}>
      <Image
        systemName="waveform.circle.fill"
        foregroundStyle="systemBlue"
      />
      <VStack alignment="leading" spacing={2}>
        <Text font="headline">Voiceboard · {state.status}</Text>
        <Text font="caption" foregroundStyle="secondaryLabel">
          {state.label !== undefined && state.label.length > 0
            ? `${state.label} · `
            : ""}
          剩余 {fmtMMSS(state.remainingSec)}
        </Text>
      </VStack>
      <Spacer />
    </HStack>
  )
}

const builder: LiveActivityUIBuilder<VBActivityState> = (state) => {
  return (
    <LiveActivityUI
      content={<ContentView {...state} />}
      compactLeading={
        <HStack spacing={4}>
          <Image systemName="waveform" foregroundStyle="systemBlue" />
          <Text>{fmtMMSS(state.remainingSec)}</Text>
        </HStack>
      }
      compactTrailing={
        <Image systemName="mic.fill" foregroundStyle="systemRed" />
      }
      minimal={<Image systemName="waveform" foregroundStyle="systemBlue" />}
    >
      <LiveActivityUIExpandedCenter>
        <ContentView {...state} />
      </LiveActivityUIExpandedCenter>
    </LiveActivityUI>
  )
}

// `LiveActivity.register` 返回一个工厂函数；每次调用才真正拿到 instance。
// 推荐 index.tsx 里用模块级 `let currentActivity: LiveActivity<...> | null = null`
// 存当前实例，避免 start/update 跨到不同 instance。
export const VoiceboardWarmActivity = LiveActivity.register(
  "VoiceboardWarm",
  builder
)
