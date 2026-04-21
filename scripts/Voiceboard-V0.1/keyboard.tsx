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
  clearSessionEndedAt,
  clearSessionStartedAt,
  readError,
  readFilePath,
  readHeartbeat,
  readSessionEndedAt,
  readSessionStartedAt,
  readState,
  VBState,
  vblog,
  vblogErr,
  writeAction,
  writeState,
} from "./shared"

function log(...args: unknown[]): void {
  vblog("kbd", ...args)
}
function logErr(...args: unknown[]): void {
  vblogErr("kbd", ...args)
}

const POLL_MS = 400
const COLD_START_WAIT_MS = 3000
const DEBUG = true

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

  useEffect(() => {
    log("mount · attached=", isKeyboardAttachedToInput())
    let cancelled = false
    const refresh = () => {
      if (cancelled) return
      setTick((v) => v + 1)
      setTimeout(refresh, POLL_MS)
    }
    refresh()
    return () => {
      cancelled = true
    }
  }, [])

  const state: VBState = readState()
  const sessionStartedAt = readSessionStartedAt()
  const sessionEndedAt = readSessionEndedAt()
  const filePath = readFilePath()
  const err = readError()
  const heartbeat = readHeartbeat()
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
  useEffect(() => {
    if (mode !== "done") return
    const attached = isKeyboardAttachedToInput()
    if (!attached) {
      log("done seen but keyboard not attached to input; skipping consume")
      return
    }
    if (filePath === null || sessionStartedAt === null) {
      log("done but data incomplete", { filePath, sessionStartedAt })
      return
    }
    const dur =
      sessionEndedAt !== null
        ? ((sessionEndedAt - sessionStartedAt) / 1000).toFixed(1)
        : "?"
    const payload = `[录音 ${dur}s · ${filePath}]`
    log("done · attached · insertText payload=", payload)
    CustomKeyboard.playInputClick()
    try {
      CustomKeyboard.insertText(payload)
      log("insertText OK")
    } catch (e) {
      logErr("insertText threw:", String(e))
    }
    clearFilePath()
    clearSessionStartedAt()
    clearSessionEndedAt()
    writeState("idle")
    log("state=idle · session fully consumed")
  }, [mode, filePath, sessionStartedAt, sessionEndedAt])

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
      isKeyboardAttachedToInput()
    )
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

async function main() {
  await Promise.all([CustomKeyboard.requestHeight(260)])
  CustomKeyboard.present(<VoiceboardKeyboard />)
}

if (Script.env === "keyboard") {
  main()
} else {
  Script.exit()
}
