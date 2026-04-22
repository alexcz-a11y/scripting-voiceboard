import {
  Button,
  HStack,
  Image,
  Picker,
  Script,
  Spacer,
  Text,
  useEffect,
  useObservable,
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
// Stage 7 — fresh-mount 保护窗口（从 mount 起算 5s）。
// 用途 1：poll loop shouldFast 的兜底条件 —— 新 tree 冷启后还没被用户 tap
// 之前, activeTree 还指向旧 tree, 如果此时判 ghost 会降到 5s 慢轮询, 让录音
// 秒数 / warm 倒计时卡住, 用户眼睛看到"死了". 5s 覆盖日志里 tap → 新 tree
// mount → 用户首次 tap 的典型 2.5-4.5s 窗口。
// 用途 2：sync effect 的动画通道 gate —— fresh-mount 期内允许走 setTimeout +
// withAnimation 走 SwiftUI 动画事务, 超期则降级为纯同步 setValue。
const FRESH_MOUNT_MS = 5000
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

  // Stage 7 — per-tree mount timestamp, 给 sync effect + poll loop 做
  // fresh-mount 判定。iOS 冷启 VC 重建时新 tree 的 activeTree 还指向旧 tree
  // (用户还没在新 tree 上 tap), isSelfActive=false; 但这个新 tree 正是用户
  // 即将看到的, 必须让它走动画通道 + 保持快轮询。用 "mount 后 <
  // FRESH_MOUNT_MS (5s)" 作为 fresh 判据, 覆盖 cold-start 2.5-4.5s 窗口 +
  // 用户首次 tap 前的缓冲。
  const [mountedAt] = useState(() => Date.now())

  // Stage 7 — 动画镜像 Observable（cold-start first-mount animation fix）。
  //
  // 为什么要镜像：iOS 冷启销毁 + 重建 UIInputViewController 时，新 React tree
  // 首帧直接读到 state="armed"，mode="recording"，micSym="stop.fill"。SwiftUI
  // 的 contentTransition(symbolEffectReplace) + .animation(_:value:) 只在
  // value 变化时触发，首次渲染没有"旧值"→ 没有 morph → 用户看到"圆形消失 →
  // 停顿 → 方形突然出现"。
  //
  // 修法：镜像 Observable 初始化为 idle 态占位值 → React 首帧绘制 idle UI
  // (mic.fill 圆麦, 不动画, 符合 SwiftUI 语义) → useEffect 首次执行时
  // withAnimation 把 Observable 翻到真实目标态 → SwiftUI 动画事务中
  // contentTransition 触发 mic.fill → stop.fill / circle → circle.fill morph。
  //
  // 为什么 placeholder 选 idle 而非 warm：fresh 打开键盘 (state=idle) 时
  // placeholder=actual → 零 morph (无 warm 态 flicker)；cold-start 重建时
  // idle→recording 的图标对恰好是"用户刚点麦克风图标"的心理预期, 比 warm
  // →recording 更贴合用户心智模型。idle 各字段天然值: mode="idle", state=
  // "idle", hasErr=false, rightText="idle" (见 rightLabelText 兜底)。
  //
  // 必须用 Observable（非 useState）：withAnimation(body) 只接 Observable
  // .setValue 的同步 SwiftUI 写；React useState 是异步调度，会错过 SwiftUI
  // 动画事务。依据：CLAUDE.md `feedback_scripting_subview_hooks_refresh.md`。
  // 原生 pattern 参考：Apple WWDC23 session 10258 + Hacking with Swift
  // "animate-immediately-after-a-view-appears"（onAppear + withAnimation 翻
  // 占位值）。
  const displayMode = useObservable<Mode>("idle")
  const displayHasErr = useObservable<boolean>(false)
  const displayRightText = useObservable<string>("idle")
  const displayState = useObservable<VBState>("idle")

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
  //   - fresh-mount <5s AND session running — cold-start 新 tree 还没被 tap
  //     成 active 前的保护窗 (Stage 7 thermal fix; 原"state !== idle"全量
  //     兜底让 20+ ghost 也跟着快轮询 → 发烫 + 动画不稳)
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
      // Stage 7 thermal fix —— 缩小 fast-poll 的触发条件, 让真正的 ghost tree
      // 即使在 active session 期间也保持慢轮询, 降低桥接调用密度。
      //
      // 历史: Stage 4.5b 为了 warm 倒计时每秒跳一次而加的 `stateNow !== "idle"`
      // 兜底条件, 让所有 ghost tree 在 active session 全程 400ms 快轮询。单棵
      // tree 时代价可忽略; 但 iOS 不销毁旧 React tree, 多次 session + 锁屏后
      // ghost 累积到 15-20 棵, 全部一起 400ms 快轮询 + Stage 7 sync effect 每
      // tick 跨桥接 5 次 → ~250 Hz 桥接 → 手机发烫 + active tree 动画不稳。
      //
      // 修法: 把 "stateNow !== idle" 兜底, 收敛到 "fresh-mount 且 state 非
      // idle" 。fresh-mount (<5s) 覆盖 cold-start 新 tree 还未被用户 tap 的
      // 窗口 (日志里 tap → 新 tree mount 典型 2.5-4.5s, 用户首次停录 tap 再
      // 加 1-5s), 保证新 tree 该快的时候快; 超过 5s 仍没被 tap 成 active 的
      // tree 视为真 ghost, 慢轮询。后续 user tap 可通过 wakeRef.wake() 立刻
      // 升频, 不会卡。
      //
      // 常见场景验证:
      //  - 首次冷启新 tree: isFreshMount=true, 快轮询, 动画+倒计时流畅
      //  - warm 复用 tap: tap 时 writeActiveTree → activeTree===TREE_ID 分支
      //    命中, 快轮询
      //  - 老 ghost: isFreshMount=false + activeTree !== TREE_ID, 慢轮询
      //  - clearActiveTree 后 (index 启动 / reset): activeTree===null 分支命中
      //    所有 tree 快轮询, 与原 "first-session compat" 等价
      const isFreshMount = Date.now() - mountedAt < FRESH_MOUNT_MS
      const shouldFast =
        activeTree === null ||
        activeTree === TREE_ID ||
        (isFreshMount && stateNow !== "idle")
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

  // Stage 6a — 派生渲染态。Stage 7 起 UI 文案/色/图标从 display Observable
  // (dAccent / dTagText / dMicSym / dMicText) 派生; 这里只保留 sync effect
  // 需要的 source-of-truth 派生值 (hasErr / rightText) 做依赖比对。
  const hasErr = err !== null
  const recordingElapsedSec =
    sessionStartedAt !== null ? (now - sessionStartedAt) / 1000 : 0
  const rightText = rightLabelText(
    mode,
    state,
    warmRemainingSec,
    recordingElapsedSec,
    hasErr,
    errKind
  )
  const errShort =
    hasErr && err !== null
      ? err.length > 28
        ? err.slice(0, 28) + "…"
        : err
      : null

  // Stage 7 cold-start animation fix —— new tree 首帧绘出 idle 占位态后,
  // useEffect 首 tick 里 withAnimation 把 4 个 display Observable 翻到真实
  // 目标态, 强制 SwiftUI 进入动画事务 → contentTransition(symbolEffectReplace)
  // / numericText 正常 morph。
  //
  // 常态 (warm 同 tree re-render) 也走这条路径: Observable 值 != 派生值 →
  // withAnimation setValue → 动画触发。与 JSX 里 animation={{value}} 叠加
  // (双保险)。
  //
  // 依赖 Array 包含 mode/hasErr/rightText/state —— 任一变都触发 effect。
  // rightText 每 400ms tick 因 recordingElapsedSec/warmRemainingSec 变化
  // 而更新 → 数字位持续 numericText morph。
  //
  // setValue 后 bump tick 一次, 触发 React 立即 re-render → JSX 重读 obs
  // .value 把新 string 灌进 animation={{value}} → SwiftUI 立刻感知 value
  // 变化并执行 contentTransition(不用等下一轮 400ms poll)。
  //
  // Race-condition fix #1 (2026-04-22 两次冷启一好一坏)—— setTimeout(0)
  // 推迟到下一 macrotask, 让 Render 1 在独立 runloop tick 里 commit, 给
  // SwiftUI 建立 baseline value, Render 2 才作为真正 value 变化触发
  // contentTransition。没这层 defer 时 Scripting 桥接偶尔把两次 commit
  // 合并 → SwiftUI 错失 baseline → 首次 mount morph 失败。
  //
  // Race-condition fix #2 (2026-04-22 第二轮 4 次测试, 前 2 好, 锁屏 30s 回
  // 来 3&4 连坏)—— L3-aware ghost tree gating。iOS 不销毁旧 React tree,多
  // 次 session + 锁屏累积到 20+ ghost。state 变化时所有 tree 的 sync effect
  // 同时触发 → 20+ 并发 setTimeout + withAnimation + Observable.setValue×4
  // → SwiftUI 桥接/CPU 争用 → active tree 的 Render 1→2 commit 窗口被压缩
  // 到 SwiftUI 区分不出 → 回退到"无 baseline"分支, morph 失败。修法:
  // ghost tree (非 self-active 且 mount 超过 FRESH_MOUNT_MS) 只做同步 setValue
  // 保持状态一致, **完全跳过** setTimeout + withAnimation 通道, 留给 active
  // 或 fresh-mount tree 单独占用 SwiftUI 动画桥接。fresh-mount 5s 窗口是冷启
  // VC 重建 + 用户首次 tap 的典型时间界 (详见 FRESH_MOUNT_MS 定义处注释)。
  useEffect(() => {
    const activeTree = readActiveTree()
    const isSelfActive = activeTree === null || activeTree === TREE_ID
    const isFreshMount = Date.now() - mountedAt < FRESH_MOUNT_MS
    if (!isSelfActive && !isFreshMount) {
      // Ghost tree —— 同步写入 Observable (保持状态一致) 但不走 SwiftUI
      // 动画通道, 避免与 active tree 争用 SwiftUI 桥接。
      if (displayMode.value !== mode) displayMode.setValue(mode)
      if (displayHasErr.value !== hasErr) displayHasErr.setValue(hasErr)
      if (displayRightText.value !== rightText)
        displayRightText.setValue(rightText)
      if (displayState.value !== state) displayState.setValue(state)
      return
    }
    // Active 或 fresh-mount tree —— 走完整动画通道。
    const handle = setTimeout(() => {
      let changed = false
      withAnimation(Animation.default(), () => {
        if (displayMode.value !== mode) {
          displayMode.setValue(mode)
          changed = true
        }
        if (displayHasErr.value !== hasErr) {
          displayHasErr.setValue(hasErr)
          changed = true
        }
        if (displayRightText.value !== rightText) {
          displayRightText.setValue(rightText)
          changed = true
        }
        if (displayState.value !== state) {
          displayState.setValue(state)
          changed = true
        }
      })
      if (changed) setTick((v) => v + 1)
    }, 0)
    return () => clearTimeout(handle)
  }, [mode, hasErr, rightText, state])

  // Stage 7 — 动画相关渲染值全从 display Observable 派生, 与 JSX animation
  // 事务对齐; 非动画相关 (errShort 文本) 仍直接用 err 字段。
  const dMode = displayMode.value
  const dHasErr = displayHasErr.value
  const dState = displayState.value
  const dRightText = displayRightText.value
  const dAccent = accentFor(dMode, dHasErr)
  const dTagText = statusTagText(dMode, dHasErr)
  const dMicSym = micSymbolFor(dMode, dState, dHasErr)
  const dMicText = micCapsuleLabel(dMode, dState, dHasErr)

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
                  dHasErr
                    ? "exclamationmark.triangle.fill"
                    : dMode === "warm"
                      ? "waveform.badge.mic"
                      : dMode === "recording"
                        ? "circle.fill"
                        : dMode === "processing"
                          ? "arrow.triangle.2.circlepath"
                          : dMode === "done"
                            ? "checkmark.circle.fill"
                            : "circle"
                }
                font={tune.tagIconSize}
                foregroundStyle={dAccent}
                contentTransition="symbolEffectReplace"
                symbolEffect={
                  dMode === "processing"
                    ? { effect: "rotate", value: dState }
                    : undefined
                }
                animation={{
                  animation: Animation.default(),
                  value: `${dMode}:${dHasErr ? 1 : 0}`,
                }}
              />
              <Text
                font={tune.tagTextSize}
                fontWeight="semibold"
                foregroundStyle={dAccent}
              >
                {dTagText}
              </Text>
            </HStack>
            {errShort !== null ? (
              <Text font={tune.tagSubTextSize} foregroundStyle={dAccent}>
                {errShort}
              </Text>
            ) : null}
          </VStack>

          <Spacer />

          <Text
            font={tune.monoTextSize}
            foregroundStyle={dHasErr ? dAccent : "secondaryLabel"}
            monospacedDigit
            offset={{ x: tune.monoOffsetX, y: tune.monoOffsetY }}
            contentTransition="numericText"
            animation={{
              animation: Animation.default(),
              value: dRightText,
            }}
          >
            {dRightText}
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
            glass: UIGlass.regular().tint(dAccent.light).interactive(true),
            shape: "capsule",
          }}
        >
          <HStack
            spacing={tune.micIconTextGap}
            padding={{ horizontal: tune.micPadH }}
          >
            <Image
              systemName={dMicSym}
              font={tune.micIconSize}
              foregroundStyle="white"
              contentTransition="symbolEffectReplace"
              symbolEffect={
                dMode === "processing"
                  ? { effect: "rotate", value: dState }
                  : undefined
              }
              animation={{
                animation: Animation.default(),
                value: `${dMode}:${dHasErr ? 1 : 0}`,
              }}
            />
            <Text
              font={tune.micTextSize}
              fontWeight="semibold"
              foregroundStyle="white"
            >
              {dMicText}
            </Text>
            {dMode === "processing" ? (
              <Image
                systemName="ellipsis"
                font={tune.micTextSize}
                foregroundStyle="white"
                symbolEffect={{
                  effect: "variableColorCumulative",
                  value: tick,
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
