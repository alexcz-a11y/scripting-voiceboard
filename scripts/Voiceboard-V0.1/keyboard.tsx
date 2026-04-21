import {
  Button,
  HStack,
  Script,
  Spacer,
  Text,
  useEffect,
  useState,
  VStack,
} from "scripting"

import {
  clearError,
  clearErrorKind,
  clearFilePath,
  clearFinalText,
  clearRawText,
  clearSessionEndedAt,
  clearSessionStartedAt,
  readActiveTree,
  readError,
  readErrorKind,
  readFilePath,
  readFinalText,
  readHeartbeat,
  readRawText,
  readSessionEndedAt,
  readSessionStartedAt,
  readState,
  readWarmUntil,
  VBErrorKind,
  VBState,
  vblog,
  vblogErr,
  writeAction,
  writeActiveTree,
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
  // wakeRef holds a per-instance reference to the "wake from slow poll"
  // function. onMicTap mutates wakeRef.wake to invoke it after writing the
  // new activeTree id, so a ghost-mode tree that the user just tapped
  // immediately switches to fast polling instead of waiting 5s.
  const [wakeRef] = useState<{ wake: () => void }>(() => ({ wake: () => {} }))

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
  const heartbeat = readHeartbeat()
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

  const coldStartTimedOut =
    coldStartAt !== null &&
    now - coldStartAt > COLD_START_WAIT_MS &&
    mode === "idle"

  const statusLine = (() => {
    if (err !== null) return `错误 · ${err}`
    if (coldStartTimedOut) {
      return "无法从键盘唤起 · 请手动打开 Scripting → Voiceboard → 开启会话"
    }
    if (coldStartAt !== null && mode === "idle") return "正在唤起 Voiceboard…"
    switch (mode) {
      case "idle":
        return "未就绪 · 点麦克风开始录音"
      case "warm":
        return `保持中 · 剩余 ${fmtMMSS(warmRemainingSec)} · 点麦克风直接录音`
      case "recording": {
        const sec =
          sessionStartedAt !== null
            ? ((now - sessionStartedAt) / 1000).toFixed(1)
            : "?"
        return `录音中 · ${sec}s · 点击停止并插入`
      }
      case "processing":
        return state === "transcribing" ? "转录中…" : "润色中…"
      case "done":
        return "等待插入…"
      default:
        return state
    }
  })()

  const micLabel = (() => {
    switch (mode) {
      case "idle":
        return "🎙 开始"
      case "warm":
        // 区别于 idle 的"开始"：warm 下键盘是"热启动"，文案给用户"马上录"
        // 的心智，和 Typeless 对齐。
        return "🎙 录音"
      case "recording":
        return "■ 停止"
      case "processing":
        return state === "transcribing" ? "… 转录中" : "… 润色中"
      case "done":
        return "… 插入中"
      default:
        return "?"
    }
  })()

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

  const heartbeatFresh =
    heartbeat !== null && now - heartbeat < 2000 ? "✓" : "✗"

  return (
    <VStack spacing={10} padding={12}>
      <Text font="footnote" foregroundStyle="secondaryLabel">
        {statusLine}
      </Text>

      <HStack spacing={12}>
        <Button
          title="切系统键盘"
          action={() => CustomKeyboard.nextKeyboard()}
        />
        <Spacer />
        <Text font="caption" foregroundStyle="secondaryLabel">
          index {heartbeatFresh}
        </Text>
        <Button title="首页" action={() => CustomKeyboard.dismissToHome()} />
      </HStack>

      <HStack>
        <Spacer />
        <Button
          title={micLabel}
          action={onMicTap}
          disabled={micDisabled}
        />
        <Spacer />
      </HStack>

      {DEBUG && openURLResult !== null ? (
        <Text font="caption" foregroundStyle="secondaryLabel">
          {openURLResult}
        </Text>
      ) : null}

      {DEBUG ? (
        <Text font="caption" foregroundStyle="secondaryLabel">
          mode={mode} · state={state} · tick={tick}
        </Text>
      ) : null}
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
  await Promise.all([CustomKeyboard.requestHeight(260)])
  CustomKeyboard.present(<VoiceboardKeyboard />)
}

if (Script.env === "keyboard") {
  main()
} else {
  Script.exit()
}
