import {
  Button,
  HStack,
  Image,
  Picker,
  Script,
  Spacer,
  Text,
  useEffect,
  useState,
  VStack,
  ZStack,
} from "scripting"

import {
  clearError,
  clearErrorKind,
  clearFilePath,
  clearFinalText,
  clearRawText,
  clearSessionEndedAt,
  clearSessionStartedAt,
  InputMode,
  readActiveTree,
  readError,
  readErrorKind,
  readFilePath,
  readFinalText,
  readHeartbeat,
  readInputMode,
  readRawText,
  readSessionEndedAt,
  readSessionStartedAt,
  readState,
  readTune,
  readTuneBool,
  readWarmUntil,
  VBErrorKind,
  VBState,
  vblog,
  vblogErr,
  writeAction,
  writeActiveTree,
  writeInputMode,
} from "./shared"

function log(...args: unknown[]): void {
  vblog("kbd", ...args)
}
function logErr(...args: unknown[]): void {
  vblogErr("kbd", ...args)
}

const POLL_MS = 400
const SLOW_POLL_MS = 5000 // ghost 树降频到 5s/次，省 CPU/重渲染开销
const COLD_START_WAIT_MS = 3000
const DEBUG = true

// Module-level identity for THIS JS evaluation of keyboard.tsx. Used by L2
// (active-tree filter) so ghost trees from hot-reload / iOS view reuse
// cannot win the done-consume race. Stable for the lifetime of this React
// tree; a re-evaluation of keyboard.tsx (new ghost) gets a different id.
const TREE_ID = `t${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 6)}`

// Stage 4.5b — mode `"warm"` 独立一档：不折进 idle，因为两者用户心智完全不同：
//   idle → 点 mic 会冷启动 Scripting（完整 URL scheme 流程）
//   warm → 点 mic 会复用已激活的保持态，走 run （onResume）而非 run_single
// 键盘 UI 也会给两种态不同的 mic 文案（"🎙 开始" vs "🎙 录音"）和状态栏
// （idle 提示"未就绪"，warm 显示"保持中 剩余 MM:SS"）。
type Mode = "idle" | "warm" | "recording" | "processing" | "done" | "other"

function classify(state: VBState): Mode {
  if (state === "idle") return "idle"
  if (state === "warm") return "warm"
  if (state === "done") return "done"
  if (state === "armed") return "recording"
  if (state === "transcribing" || state === "polishing") return "processing"
  return "other"
}

// Stage 6a — Voiceboard Ink 品牌色（dynamic light/dark）。
//
// 用 DynamicShapeStyle 形式 `{ light, dark }`（dts:1488），iOS 自动按设备外观
// 切换。值是 hex 字符串，Color = ColorStringHex | RGBA | KeywordsColor (dts:1039)。
//
// 规约：accent 色用于按钮主色 / pill / status tag；fg2 用于 secondary 文字。
const C_PRIMARY = { light: "#4F6BE8", dark: "#7C93FF" } as const  // warm 蓝
const C_URGENT  = { light: "#FF4B55", dark: "#FF6B72" } as const  // armed 红
const C_PROCESS = { light: "#F59E0B", dark: "#FBBF24" } as const  // transcribing/polishing 橘
const C_SUCCESS = { light: "#10B981", dark: "#34D399" } as const  // done 绿
const C_ERROR   = { light: "#DC2626", dark: "#F87171" } as const  // 错误红
const C_NEUTRAL = { light: "#6B7280", dark: "#A1A1AA" } as const  // idle / 默认灰

// 给定 mode + 是否有错误，返回该 state 的主调色板 token。错误优先级最高。
function accentFor(mode: Mode, hasErr: boolean): { light: string; dark: string } {
  if (hasErr) return C_ERROR
  switch (mode) {
    case "warm":      return C_PRIMARY
    case "recording": return C_URGENT
    case "processing": return C_PROCESS
    case "done":      return C_SUCCESS
    default:          return C_NEUTRAL
  }
}

// 主胶囊麦克风按钮在每个 state 显示的 SF Symbol。
function micSymbolFor(mode: Mode, state: VBState, hasErr: boolean): string {
  if (hasErr) return "exclamationmark.triangle.fill"
  switch (mode) {
    case "warm":
    case "idle":      return "mic.fill"
    case "recording": return "stop.fill"
    case "processing": return "arrow.triangle.2.circlepath"
    case "done":      return "checkmark"
    default:          return "mic.fill"
  }
}

// 主胶囊麦克风按钮文案。
function micCapsuleLabel(mode: Mode, state: VBState, hasErr: boolean): string {
  if (hasErr) return "出错 · 清除"
  switch (mode) {
    case "idle":      return "开始录音"
    case "warm":      return "开始录音"
    case "recording": return "结束录音"
    case "processing": return state === "transcribing" ? "转录中" : "润色中"
    case "done":      return "已插入"
    default:          return "开始录音"
  }
}

// 顶部左侧 status tag 的短文案（带前缀符号）。
function statusTagText(mode: Mode, hasErr: boolean): string {
  if (hasErr) return "错误"
  switch (mode) {
    case "warm":      return "保持中"
    case "recording": return "录音中"
    case "processing": return "处理中"
    case "done":      return "已完成"
    case "idle":      return "未就绪"
    default:          return "—"
  }
}

// 顶部右侧的 mono 副信息（mm:ss / 3.4s / Scribe v2 / etc）。
function rightLabelText(
  mode: Mode,
  state: VBState,
  warmRemainingSec: number,
  recordingElapsedSec: number,
  hasErr: boolean,
  errKind: VBErrorKind | null
): string {
  if (hasErr) return errKind ?? "?"
  switch (mode) {
    case "warm":      return fmtMMSS(warmRemainingSec)
    case "recording": return `${recordingElapsedSec.toFixed(1)}s`
    case "processing": return state === "transcribing" ? "Scribe v2" : "gpt-5.4-mini"
    case "done":      return "已插入"
    case "idle":      return "idle"
    default:          return state
  }
}

function fmtMMSS(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${pad(m)}:${pad(s % 60)}`
}

function isKeyboardAttachedToInput(): boolean {
  try {
    const before = CustomKeyboard.textBeforeCursor
    const after = CustomKeyboard.textAfterCursor
    return before !== null || after !== null
  } catch (e) {
    logErr("isKeyboardAttachedToInput threw:", String(e))
    return false
  }
}

function VoiceboardKeyboard() {
  const [tick, setTick] = useState(0)
  const [coldStartAt, setColdStartAt] = useState<number | null>(null)
  const [openURLResult, setOpenURLResult] = useState<string | null>(null)
  const [prevMode, setPrevMode] = useState<Mode | null>(null)
  // Stage 6a — 顶部「口述 / 自动 / 翻译」3 段切换 pill 当前值。
  // 用原生 Picker + pickerStyle="segmented", iOS 26 自带 Liquid Glass 滑动
  // 动画由 SwiftUI 系统内部处理, React useState 即可, 不需要 Observable +
  // withAnimation 自拼 matchedGeometry.
  const [inputMode, setInputMode] = useState<InputMode>("auto")
  // wakeRef holds a per-instance reference to the "wake from slow poll"
  // function. onMicTap mutates wakeRef.wake to invoke it after writing the
  // new activeTree id, so a ghost-mode tree that the user just tapped
  // immediately switches to fast polling instead of waiting 5s.
  const [wakeRef] = useState<{ wake: () => void }>(() => ({ wake: () => {} }))

  // 启动时一次性从 Storage 读 inputMode（处理从 idle 冷启 / 主 app 改过的情况）
  useEffect(() => {
    setInputMode(readInputMode())
  }, [])

  // L3 (Stage 3.5, v2): self-suspending poll loop.
  //
  // First L3 attempt used `state==="idle" && !isKeyboardAttachedToInput()` as
  // the ghost detector. It silently failed on device because ghost trees
  // keep returning attached=true (their cached textBeforeCursor / proxy
  // doesn't go null when iOS recreates the VC). Switching to the L2 signal:
  // the only tree the user ever taps is the visible one, so its TREE_ID is
  // the only one ever written into vb:activeTree. Any tree whose own TREE_ID
  // doesn't match the storage value is reliably a ghost.
  //
  // Fast mode (POLL_MS=400ms) when ANY of:
  //   - this tree is the user-active one (activeTree===TREE_ID)
  //   - nobody has tapped yet (activeTree===null) — first-session compat
  //   - a session is running (state !== "idle") — defensive
  // Otherwise slow mode (SLOW_POLL_MS=5000ms), 12.5× cheaper.
  //
  // Wakeup paths back to fast:
  //   - onMicTap → writeActiveTree(TREE_ID) → wakeRef.wake() → instant
  //   - textDidChange / selectionDidChange listener fires → instant
  //   - next slow poll re-evaluates → ≤5s self-recovery
  useEffect(() => {
    log(
      "mount · attached=",
      isKeyboardAttachedToInput(),
      "treeId=",
      TREE_ID
    )
    let cancelled = false
    let pollHandle: ReturnType<typeof setTimeout> | null = null
    let inSlowMode = false

    const poll = () => {
      if (cancelled) return
      setTick((v) => v + 1)
      // Stage 6a — 顺带把 inputMode 拉新一次，让"主 app 改了 pill → 键盘
      // 同步"在 400ms (fast) / 5000ms (slow ghost) 内生效。setState 同值
      // 会被 React 自动 bail out，不会无谓重渲染。
      setInputMode(readInputMode())
      const stateNow = readState()
      const activeTree = readActiveTree()
      // Stage 4.5b — warm 窗口内也必须 fast poll，否则用户看到的倒计时
      // 会 5s 跳一次。L3 的 "stateNow !== 'idle'" 分支本身就覆盖了 warm，
      // 这里显式列出以示意图。
      const shouldFast =
        activeTree === null ||
        activeTree === TREE_ID ||
        stateNow !== "idle"
      if (shouldFast && inSlowMode) {
        log(
          "poll resumed: fast (activeTree=",
          activeTree,
          "state=",
          stateNow,
          ")"
        )
        inSlowMode = false
      } else if (!shouldFast && !inSlowMode) {
        log(
          "poll suspended: slow (mine=",
          TREE_ID,
          "active=",
          activeTree,
          ")"
        )
        inSlowMode = true
      }
      pollHandle = setTimeout(poll, shouldFast ? POLL_MS : SLOW_POLL_MS)
    }

    const wake = () => {
      if (cancelled || !inSlowMode) return
      if (pollHandle !== null) {
        clearTimeout(pollHandle)
        pollHandle = null
      }
      log("poll wakeup")
      inSlowMode = false
      poll()
    }
    wakeRef.wake = wake

    CustomKeyboard.addListener("textDidChange", wake)
    CustomKeyboard.addListener("selectionDidChange", wake)

    poll()

    return () => {
      cancelled = true
      if (pollHandle !== null) clearTimeout(pollHandle)
      CustomKeyboard.removeListener("textDidChange", wake)
      CustomKeyboard.removeListener("selectionDidChange", wake)
    }
  }, [])

  const state: VBState = readState()
  const sessionStartedAt = readSessionStartedAt()
  const sessionEndedAt = readSessionEndedAt()
  const filePath = readFilePath()
  const err = readError()
  const errKind = readErrorKind()
  const rawText = readRawText()
  const finalText = readFinalText()
  // Stage 4.5b — warm 剩余秒数（给 statusLine 显示）。warmUntil 过期也当
  // 非 warm 处理（cold path 会兜底）。
  const warmUntil = readWarmUntil()
  const now = Date.now()
  const warmRemainingSec =
    warmUntil !== null ? Math.max(0, Math.floor((warmUntil - now) / 1000)) : 0

  const mode = classify(state)

  useEffect(() => {
    if (prevMode !== mode) {
      log("mode change", prevMode, "->", mode, "· state=", state)
      setPrevMode(mode)
    }
  }, [mode])

  // Consume state=done and insertText — only if this keyboard instance is
  // actually attached to a text input. Ghost instances (backgrounded or in
  // an app with no focused text field) would otherwise race and swallow the
  // done state silently.
  //
  // Payload priority:
  //   1. finalText (OpenAI 润色) → 直接插入
  //   2. rawText (Scribe 输出，润色失败/未配置时的 fallback) → 直接插入
  //   3. err 但无文本 → `[转录失败: <msg>]` 或 `[润色失败: <msg>]`
  //   4. 兜底 → `[录音 X.Xs · <m4a path>]`（v1 占位，调试用）
  //
  // 注意 err+rawText 同时存在的情况：润色失败但 STT 成功，应该插入 rawText
  // （未润色的原文也好过让用户看到错误占位）。所以 err 单独占用 payload 的
  // 优先级低于 rawText。
  useEffect(() => {
    if (mode !== "done") return
    // L2: only the tree the user actually tapped consumes done. Ghost trees
    // (from hot-reload or iOS view-controller reuse) have a different TREE_ID
    // and never made it into vb:activeTree, so they bail here. If activeTree
    // is null (first session ever, no tap recorded), fall through to the
    // attach check — backward compatible with existing tests.
    const activeTree = readActiveTree()
    if (activeTree !== null && activeTree !== TREE_ID) {
      log(
        "done · not active tree (mine=",
        TREE_ID,
        "active=",
        activeTree,
        "); skipping consume"
      )
      return
    }
    const attached = isKeyboardAttachedToInput()
    if (!attached) {
      log("done seen but keyboard not attached to input; skipping consume")
      return
    }
    let payload: string | null = null
    let payloadKind = ""
    if (finalText !== null && finalText.length > 0) {
      payload = finalText
      payloadKind = "finalText"
    } else if (rawText !== null && rawText.length > 0) {
      payload = rawText
      payloadKind = "rawText"
    } else if (err !== null && err.length > 0) {
      // errKind (Stage 4+) 决定占位符前缀；旧会话没写 kind 时 fallback 到
      // "转录失败"（最常见的失败路径）。
      const labelByKind: Record<VBErrorKind, string> = {
        setup: "准备失败",
        record: "录音失败",
        stt: "转录失败",
        polish: "润色失败",
      }
      const label = errKind !== null ? labelByKind[errKind] : "转录失败"
      payload = `[${label}: ${err}]`
      payloadKind = `errorPlaceholder(${errKind ?? "?"})`
    } else if (filePath !== null && sessionStartedAt !== null) {
      const dur =
        sessionEndedAt !== null
          ? ((sessionEndedAt - sessionStartedAt) / 1000).toFixed(1)
          : "?"
      payload = `[录音 ${dur}s · ${filePath}]`
      payloadKind = "v1Placeholder"
    }
    if (payload === null) {
      log("done but no payload available; skipping", {
        filePath,
        sessionStartedAt,
        rawText,
        finalText,
        err,
      })
      return
    }
    log(
      "done · attached · insertText kind=",
      payloadKind,
      "len=",
      payload.length,
      "preview=",
      payload.slice(0, 80)
    )
    CustomKeyboard.playInputClick()
    try {
      CustomKeyboard.insertText(payload)
      log("insertText OK")
    } catch (e) {
      logErr("insertText threw:", String(e))
    }
    clearFinalText()
    clearRawText()
    clearFilePath()
    clearSessionStartedAt()
    clearSessionEndedAt()
    // Stage 5.1 修复：err / errKind 也必须在这里清掉。
    //
    // 老版注释写的是"留着给主 app 错误区查看，下次 startSession 会清" ——
    // 但实测（2026-04-21 真机）暴露两个并发 bug：
    //   a) 这个 effect 的 deps 含 finalText/rawText。上面 clearFinalText()
    //      触发下一轮 render，effect 再次 fire。第一次走 finalText 分支
    //      成功插入，clear 了 finalText/rawText，但 err 还在 storage 里
    //      → 第二次 fire 时 finalText=null / rawText=null / err=stale →
    //      落到 err 分支，把上一轮失败的错误占位再插一次。用户看到正常
    //      文本后立刻又来一条"[转录失败: …]"，极诡异。
    //   b) warm 模式下一次 cycle 失败后，err 永远留在 storage 里，
    //      keyboard 的 statusLine `if (err !== null) return "错误 · ..."`
    //      会持续显示第一次的错误文案，覆盖掉 "保持中 · 剩余 MM:SS"
    //      和 "录音中 X.Xs"，直到用户手动去主 app 清。
    // 既然 err 一旦被键盘渲染成占位符插入就已经"送达"了（等价于 finalText
    // / rawText 的 delivered 语义），就在 consume 成功后一起清。没有用户
    // 能看到但无处插入的遗留 err；handleCycleEnd 的 main-app 错误区显示
    // 在 worker force-advance 路径下仍然保留（见 index.tsx）。
    //
    // Stage 4.5b —— 不再在这里 writeState("idle")！
    // 状态写入单一所有权：warm ↔ idle / warm ↔ armed 的转换由 index 的
    // worker 基于"rawText/finalText 已清空"的信号 + warmUntil 判断。
    // 键盘只负责把文本插到目标输入框，不动 state。
    clearError()
    clearErrorKind()
    log("done consumed · text inserted, cleared · state 留给 index 推进")
  }, [
    mode,
    filePath,
    sessionStartedAt,
    sessionEndedAt,
    rawText,
    finalText,
    err,
    errKind,
  ])

  // Stage 6a — 原 statusLine / micLabel IIFE 在 Stage 6a return 树重写中废弃：
  // 文案改由 statusTagText / rightLabelText / micCapsuleLabel 顶层 helper 拿。
  // coldStartAt state 仍保留（onMicTap 写入），供日后恢复"无法唤起"UX 用。

  const micDisabled = mode === "done" || mode === "processing"

  const onMicTap = async () => {
    const rawState = readState()
    log(
      "onMicTap · mode=",
      mode,
      "rawState=",
      rawState,
      "attached=",
      isKeyboardAttachedToInput(),
      "treeId=",
      TREE_ID
    )
    // L2: claim "active tree" on every user tap. iOS only delivers touch
    // events to the currently visible view, so ghost trees never run this
    // — only THIS tree's TREE_ID lands in vb:activeTree, and only this tree
    // will pass the consume filter when state reaches done.
    writeActiveTree(TREE_ID)
    // L3: if THIS tree was in slow ghost mode (because activeTree pointed
    // elsewhere before this tap), promote to fast immediately so the user
    // sees state transitions without a 5s lag.
    wakeRef.wake()
    CustomKeyboard.playInputClick()

    if (mode === "recording") {
      log("writeAction(stop)")
      writeAction("stop")
      return
    }

    // ------------------------------------------------------------------
    // Stage 4.5b v2 — warm fast-path（选项乙 + 过期回退）
    //
    // warm 态 + heartbeat 新鲜 = index worker 确定在后台转 → 纯 Storage 信号
    // 触发，**不跳转 Scripting**。用户留在当前 app，录音直接开始（和 Typeless
    // 完全一致，无切屏动画）。
    //
    // 4.5b v1 曾经在这里无条件 openURL("scripting://run/...") 触发 onResume
    // 唤醒。真机实测日志（2026-04-21 01:26）证明 worker 在 onResume 触发前
    // 就已经处理了 action —— 说明 worker 本来就在背景跑，openURL 的唯一效果
    // 是把 Scripting 切到前台，用户体验成"每次录音都跳一下"。
    //
    // v2 策略（对应用户要求"跳转应该取决于状态和条件"）：
    //   1. mode=warm + warmUntil 未过期 + heartbeat 新鲜 → 仅 writeAction("arm")
    //      worker 在 ≤400ms 内读取到并 armFromWarm；完全无切屏。
    //   2. mode=warm + warmUntil 未过期 + heartbeat 过期 (>2s) → 说明 worker
    //      真的被挂起了 → 写 action + openURL 唤醒。这种情况在 v2 的"keeper
    //      全程跑"架构下理论上不应该发生，但保留为安全网。
    //   3. mode=warm + warmUntil 过期 → fall through idle 冷启动路径。
    // ------------------------------------------------------------------
    if (mode === "warm") {
      const wu = readWarmUntil()
      if (wu === null || wu <= Date.now()) {
        log("onMicTap · warm but warmUntil expired → cold path")
        // fall through to idle branch below
      } else {
        // 刷新读一次 heartbeat（render 时的闭包可能已经过时几十 ms）
        const hb = readHeartbeat()
        const hbAgeMs = hb !== null ? Date.now() - hb : Infinity
        const workerAlive = hbAgeMs < 2000

        writeAction("arm")

        if (workerAlive) {
          // 主路径：纯 Storage 信号，无切屏。worker 会在 ≤400ms 内处理。
          log(
            "warm fast-path · writeAction(arm) · NO openURL",
            "(worker alive, heartbeat",
            hbAgeMs,
            "ms old)"
          )
          setOpenURLResult(
            `warm action=arm 已写 · heartbeat ${hbAgeMs}ms · 不跳转`
          )
          return
        }

        // 兜底：heartbeat 过期 → worker 可能被 iOS 挂起 → openURL 唤醒
        const url = Script.createRunURLScheme(Script.name, {
          action: "arm",
        })
        logErr(
          "warm fast-path · heartbeat stale (",
          hbAgeMs,
          "ms) · fallback openURL ->",
          url
        )
        try {
          const ok = await Safari.openURL(url)
          log("Safari.openURL(run) fallback returned", ok)
          setOpenURLResult(
            `warm fallback openURL (heartbeat ${hbAgeMs}ms stale) returned ${String(ok)}`
          )
        } catch (e) {
          logErr("Safari.openURL(run) threw:", String(e))
          setOpenURLResult(`warm fallback openURL threw ${String(e)}`)
        }
        return
      }
    }

    if (mode === "idle") {
      const url = Script.createRunSingleURLScheme(Script.name, {
        action: "arm",
      })
      log("cold start · Safari.openURL ->", url)
      setColdStartAt(Date.now())
      try {
        const ok = await Safari.openURL(url)
        log("Safari.openURL returned", ok)
        setOpenURLResult(`openURL returned ${String(ok)}`)
      } catch (e) {
        logErr("Safari.openURL threw:", String(e))
        setOpenURLResult(`openURL threw ${String(e)}`)
      }
    }
  }

  // Stage 6a — 派生渲染态。所有 UI 文案/色/图标都经 helper 函数统一 derive，
  // 便于同步修改 / 避免散落在 JSX 里的条件分支。
  const hasErr = err !== null
  const accent = accentFor(mode, hasErr)
  const recordingElapsedSec =
    sessionStartedAt !== null ? (now - sessionStartedAt) / 1000 : 0
  const tagText = statusTagText(mode, hasErr)
  const rightText = rightLabelText(
    mode,
    state,
    warmRemainingSec,
    recordingElapsedSec,
    hasErr,
    errKind
  )
  const micSym = micSymbolFor(mode, state, hasErr)
  const micText = micCapsuleLabel(mode, state, hasErr)
  const errShort =
    hasErr && err !== null
      ? err.length > 28
        ? err.slice(0, 28) + "…"
        : err
      : null

  // 模式 pill tap handler：UI 即刻反馈 + 持久化写 Storage。同值 noop。
  // 动画由原生 segmented Picker 内部处理, 我们只管状态 + 副作用.
  const onPickMode = (m: InputMode) => {
    if (m === inputMode) return
    log("inputMode pick", m)
    setInputMode(m)
    writeInputMode(m)
  }

  // Stage 6a — 调参面板实时生效的布局参数。每次 render 读一遍 Storage；主 app
  // 调滑杆 → ≤400ms 后键盘同步生效（L3 poll 驱动 re-render）。默认值就是
  // 当前设计锁定的参数，不设 Storage 时与硬编码等价。
  const tune = {
    // — 外层 VStack —
    outerPadH:          readTune("outer.padH",          12),
    outerPadTop:        readTune("outer.padTop",        10),
    outerPadBottom:     readTune("outer.padBottom",     10),
    outerRowSpacing:    readTune("outer.rowSpacing",    10),
    // — 顶行 —
    topRowSpacing:      readTune("top.rowSpacing",       8),
    topTagMainSubGap:   readTune("top.tagMainSubGap",    1),  // 主文字↔副错误码行距（替原 spacing={1} 硬编码）
    // — 状态标签（左上） —
    tagIconSize:        readTune("tag.iconSize",        12),
    tagTextSize:        readTune("tag.textSize",        12),
    tagSubTextSize:     readTune("tag.subTextSize",     11),
    tagInnerSpacing:    readTune("tag.innerSpacing",     4),
    tagOffsetX:         readTune("tag.offsetX",          9),
    tagOffsetY:         readTune("tag.offsetY",          0),
    // — 模式切换 pill —
    // SwiftUI segmented Picker 默认撑满父容器；必须手动 frame.width 收敛，
    // 否则 ZStack 满宽时 pill 会盖住左上 tag 和右上 mono 文字。
    pillWidth:          readTune("pill.width",         178),
    pillContainerPad:   readTune("pill.containerPad",    3),
    pillSegSpacing:     readTune("pill.segSpacing",      2),
    pillSegHPad:        readTune("pill.segHPad",        11),
    pillSegVPad:        readTune("pill.segVPad",         4),
    pillSegTextSize:    readTune("pill.segTextSize",    12),
    pillOffsetX:        readTune("pill.offsetX",         0),  // ZStack 居中后再水平偏移
    pillOffsetY:        readTune("pill.offsetY",         0),
    // — 右上时码 mono label —
    monoTextSize:       readTune("mono.textSize",       14),
    monoOffsetX:        readTune("mono.offsetX",        -9),
    monoOffsetY:        readTune("mono.offsetY",         0),
    // — 主胶囊麦克风 —
    micMinWidth:        readTune("mic.minWidth",       167),
    micHeight:          readTune("mic.height",          59),
    micPadH:            readTune("mic.padH",            26),
    micIconTextGap:     readTune("mic.iconTextGap",     10),
    micIconSize:        readTune("mic.iconSize",        20),
    micTextSize:        readTune("mic.textSize",        17),
    micOffsetX:         readTune("mic.offsetX",          0),
    micOffsetY:         readTune("mic.offsetY",          0),
    // — 键盘容器（系统层 CustomKeyboard.* API 参数）—
    kbdHeight:          readTune("kbd.height",         199),  // requestHeight
  }

  // 布尔型 tune（用 readTuneBool 因为 readTune 只收 number）。
  // 都对应 CustomKeyboard.* 系统 API：
  //   kbdHasDictation  → setHasDictationKey(value)  iOS 系统麦克风键显隐
  //   kbdToolbarVisible → setToolbarVisible(value)  Scripting 调试工具栏显隐
  const kbdHasDictation = readTuneBool("kbd.hasDictation", true)
  const kbdToolbarVisible = readTuneBool("kbd.toolbarVisible", false)

  // 应用 3 个系统键盘参数。useEffect deps 走值比较（Object.is），
  // 同值再 render 不触发副作用 → 不会每 400ms 轮询一次就 call 一次 iOS API。
  useEffect(() => {
    try {
      CustomKeyboard.setHasDictationKey(kbdHasDictation)
    } catch (e) {
      logErr("setHasDictationKey failed:", String(e))
    }
  }, [kbdHasDictation])

  useEffect(() => {
    try {
      CustomKeyboard.setToolbarVisible(kbdToolbarVisible)
    } catch (e) {
      logErr("setToolbarVisible failed:", String(e))
    }
  }, [kbdToolbarVisible])

  useEffect(() => {
    try {
      CustomKeyboard.requestHeight(tune.kbdHeight)
    } catch (e) {
      logErr("requestHeight failed:", String(e))
    }
  }, [tune.kbdHeight])

  return (
    <VStack
      spacing={tune.outerRowSpacing}
      padding={{
        horizontal: tune.outerPadH,
        top: tune.outerPadTop,
        bottom: tune.outerPadBottom,
      }}
    >
      {/* ---- 顶行：ZStack 精确居中模式 pill，不受左右 tag/mono 宽度变化影响 ----
           ZStack 默认 alignment=center，两层均水平居中于键盘宽度：
             - 底层 HStack [tag | Spacer | mono]：Spacer 撑满使 tag 靠左、mono 靠右
             - 顶层 Pill：天然居中于 ZStack，可用 offset.x 微调（tune.pillOffsetX）
           过去用单层 HStack [tag, Spacer, pill, Spacer, mono] 时 pill 位置会
           随 tag / mono 宽度变化漂移——state 切换时肉眼可见抖动。ZStack 根治。 */}
      <ZStack>
        <HStack spacing={tune.topRowSpacing}>
          <VStack
            alignment="leading"
            spacing={tune.topTagMainSubGap}
            offset={{ x: tune.tagOffsetX, y: tune.tagOffsetY }}
          >
            <HStack spacing={tune.tagInnerSpacing}>
              <Image
                systemName={
                  hasErr
                    ? "exclamationmark.triangle.fill"
                    : mode === "warm"
                      ? "waveform.badge.mic"
                      : mode === "recording"
                        ? "circle.fill"
                        : mode === "processing"
                          ? "arrow.triangle.2.circlepath"
                          : mode === "done"
                            ? "checkmark.circle.fill"
                            : "circle"
                }
                font={tune.tagIconSize}
                foregroundStyle={accent}
                contentTransition="symbolEffectReplace"
                symbolEffect={
                  mode === "processing"
                    ? { effect: "rotate", value: state }
                    : undefined
                }
              />
              <Text
                font={tune.tagTextSize}
                fontWeight="semibold"
                foregroundStyle={accent}
              >
                {tagText}
              </Text>
            </HStack>
            {errShort !== null ? (
              <Text font={tune.tagSubTextSize} foregroundStyle={accent}>
                {errShort}
              </Text>
            ) : null}
          </VStack>

          <Spacer />

          <Text
            font={tune.monoTextSize}
            foregroundStyle={hasErr ? accent : "secondaryLabel"}
            monospacedDigit
            offset={{ x: tune.monoOffsetX, y: tune.monoOffsetY }}
            contentTransition="numericText"
          >
            {rightText}
          </Text>
        </HStack>

        {/* 模式切换 pill — SwiftUI 原生 Picker + segmented style:
             iOS 26 自带 Liquid Glass 流动效果 (动画由系统内部处理, 不需要
             自拼 matchedGeometry / withAnimation / Observable). Tag 直接用
             InputMode 字面量, 与 Storage 序列化保持一致.
             offset={{x, y}} 走 CommonViewProps (dts:4008), 让用户在 tweak
             面板上下左右微调 pill 相对 ZStack 中心的位置. */}
        <Picker
          title="输入模式"
          pickerStyle="segmented"
          value={inputMode}
          onChanged={(v) => onPickMode(v as InputMode)}
          frame={{ width: tune.pillWidth }}
          offset={{ x: tune.pillOffsetX, y: tune.pillOffsetY }}
        >
          <Text tag="dictation">口述</Text>
          <Text tag="auto">自动</Text>
          <Text tag="translation">翻译</Text>
        </Picker>
      </ZStack>

      <Spacer />

      {/* ---- 主胶囊麦克风按钮 — 精确宽/高于 Button 自身，Liquid Glass 以此渲染胶囊形状
             注意：frame.width 是精确宽度（非 minWidth），slider 拖多少 = pt 多少；
             若设置过窄（< 160pt 左右）可能让"结束录音"4 字被截断。 */}
      <HStack>
        <Spacer />
        <Button
          action={onMicTap}
          disabled={micDisabled}
          buttonStyle="plain"
          frame={{ width: tune.micMinWidth, height: tune.micHeight }}
          offset={{ x: tune.micOffsetX, y: tune.micOffsetY }}
          glassEffect={{
            glass: UIGlass.regular().tint(accent.light).interactive(true),
            shape: "capsule",
          }}
        >
          <HStack
            spacing={tune.micIconTextGap}
            padding={{ horizontal: tune.micPadH }}
          >
            <Image
              systemName={micSym}
              font={tune.micIconSize}
              foregroundStyle="white"
              contentTransition="symbolEffectReplace"
              symbolEffect={
                mode === "processing"
                  ? { effect: "rotate", value: state }
                  : undefined
              }
            />
            <Text
              font={tune.micTextSize}
              fontWeight="semibold"
              foregroundStyle="white"
            >
              {micText}
            </Text>
            {mode === "processing" ? (
              <Image
                systemName="ellipsis"
                font={tune.micTextSize}
                foregroundStyle="white"
                symbolEffect={{
                  effect: "variableColorCumulative",
                  value: state,
                }}
              />
            ) : null}
          </HStack>
        </Button>
        <Spacer />
      </HStack>

      <Spacer />
      {/* 底部工具栏删除：iOS 自带 🌐 切换键盘 + 🎤 关键盘/Siri，我们重复一份浪费空间 */}
    </VStack>
  )
}

// 注：原计划在这里加 "present() 幂等护栏" (L1)，靠 module-level + globalThis
// flag 阻止重复 mount。真机测试发现两个问题：
//   1. Scripting 运行时在 keyboard.tsx 重新求值时不保留 globalThis，flag 失
//      效，多 mount 仍发生 — L1 没拦住任何东西。
//   2. dts 注释 "can only be called once during the keyboard's lifecycle"
//      实际是 per `UIInputViewController` 实例，不是 per JS context。每次
//      iOS 重建 VC（切宿主 app 回来即触发）都需要新的 present() 来挂载新
//      VC 的视图；如果 L1 凑巧拦住了，新 VC 没视图，就出现"键盘卡住"现象
//      （上一帧冻在那里，按钮无响应）。
// 结论：放弃 L1 方向，由 Stage 3.5 用 L3 (轮询自挂起) 解决 ghost tree 的
// 资源占用问题，不再触碰 present() 调用次数。
async function main() {
  // 初始 requestHeight 在 present() 之前打，让首帧直接是目标高度，避免
  // 系统默认 → 我们 useEffect 改写之间的高度跳动。从 Storage 读 tune，
  // 首次运行用 260 默认；组件内 useEffect 再按最新 storage 值持续同步。
  try {
    CustomKeyboard.requestHeight(readTune("kbd.height", 199))
  } catch {}
  try {
    CustomKeyboard.setHasDictationKey(readTuneBool("kbd.hasDictation", true))
  } catch {}
  try {
    CustomKeyboard.setToolbarVisible(readTuneBool("kbd.toolbarVisible", false))
  } catch {}
  CustomKeyboard.present(<VoiceboardKeyboard />)
}

if (Script.env === "keyboard") {
  main()
} else {
  Script.exit()
}
