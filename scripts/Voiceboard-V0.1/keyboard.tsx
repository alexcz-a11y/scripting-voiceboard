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
  clearFilePath,
  clearFinalText,
  clearRawText,
  clearSessionEndedAt,
  clearSessionStartedAt,
  readActiveTree,
  readError,
  readFilePath,
  readFinalText,
  readHeartbeat,
  readRawText,
  readSessionEndedAt,
  readSessionStartedAt,
  readState,
  VBState,
  vblog,
  vblogErr,
  writeAction,
  writeActiveTree,
  writeState,
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

type Mode = "idle" | "recording" | "processing" | "done" | "other"

function classify(state: VBState): Mode {
  if (state === "idle") return "idle"
  if (state === "done") return "done"
  if (state === "armed") return "recording"
  if (state === "transcribing" || state === "polishing") return "processing"
  return "other"
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
  const heartbeat = readHeartbeat()
  const rawText = readRawText()
  const finalText = readFinalText()
  const now = Date.now()

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
      payload = err.startsWith("polish:")
        ? `[润色失败: ${err}]`
        : `[转录失败: ${err}]`
      payloadKind = "errorPlaceholder"
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
    // 注：err 不在这里清，留在主 app 错误区供用户查看；下次 startSession 会清
    writeState("idle")
    log("state=idle · session fully consumed")
  }, [
    mode,
    filePath,
    sessionStartedAt,
    sessionEndedAt,
    rawText,
    finalText,
    err,
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
