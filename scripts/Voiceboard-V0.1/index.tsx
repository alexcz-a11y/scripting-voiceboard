import {
  Button,
  HStack,
  Navigation,
  NavigationStack,
  Script,
  ScrollView,
  SecureField,
  Spacer,
  Text,
  useEffect,
  useState,
  VStack,
} from "scripting"

import {
  buildRecordingPath,
  clearAction,
  clearActiveTree,
  clearError,
  clearErrorKind,
  clearFinalText,
  clearLog,
  clearOpenAIKey,
  clearPolishMs,
  clearRawText,
  clearScribeKey,
  clearSessionEndedAt,
  clearSessionStartedAt,
  clearSttMs,
  ensureRecordingsDir,
  formatLog,
  readAction,
  readError,
  readErrorKind,
  readFilePath,
  readFinalText,
  readHeartbeat,
  readLog,
  readOpenAIKey,
  readPolishMs,
  readRawText,
  readScribeKey,
  readSessionEndedAt,
  readSessionStartedAt,
  readSttMs,
  readState,
  VBErrorKind,
  vblog,
  vblogErr,
  writeError,
  writeErrorKind,
  writeFilePath,
  writeFinalText,
  writeHeartbeat,
  writeOpenAIKey,
  writePolishMs,
  writeRawText,
  writeScribeKey,
  writeSessionEndedAt,
  writeSessionStartedAt,
  writeSttMs,
  writeState,
} from "./shared"

function log(...args: unknown[]): void {
  vblog("index", ...args)
}
function logErr(...args: unknown[]): void {
  vblogErr("index", ...args)
}

let recorder: AudioRecorder | null = null
let lastRecorderError: string | null = null
let workerCancelled = false
let sessionActive = false

async function configureAudioSession(): Promise<void> {
  log("setCategory(playAndRecord, [defaultToSpeaker])")
  await SharedAudioSession.setCategory("playAndRecord", ["defaultToSpeaker"])
  log("setMode(default)")
  await SharedAudioSession.setMode("default")
  log("setActive(true)")
  await SharedAudioSession.setActive(true)
  const cat = await SharedAudioSession.category
  const optsNow = await SharedAudioSession.categoryOptions
  const mode = await SharedAudioSession.mode
  log("session now:", JSON.stringify({ cat, opts: optsNow, mode }))
}

async function startRecorder(): Promise<boolean> {
  const dir = await ensureRecordingsDir()
  const exists = await FileManager.exists(dir)
  log("recordings dir:", dir, "exists=", exists)
  const path = await buildRecordingPath()
  log("session recording path:", path)
  try {
    await SharedAudioSession.setActive(true)
    log("setActive(true) re-confirmed")
  } catch (e) {
    logErr("re-setActive:", String(e))
  }
  let r: AudioRecorder
  try {
    r = await AudioRecorder.create(path, {
      format: "MPEG4AAC",
      sampleRate: 44100,
      numberOfChannels: 1,
      encoderAudioQuality: AVAudioQuality.high,
    })
    log("AudioRecorder.create OK")
  } catch (e) {
    const msg = `AudioRecorder.create threw: ${String(e)}`
    logErr(msg)
    writeError(msg)
    writeErrorKind("record")
    return false
  }
  lastRecorderError = null
  r.onError = (msg: string) => {
    lastRecorderError = msg
    logErr("recorder.onError:", msg)
    writeError(`recorder.onError: ${msg}`)
    writeErrorKind("record")
  }
  r.onFinish = (success: boolean) => {
    log("recorder.onFinish success=", success)
  }
  const ok = r.record()
  log("recorder.record() =>", ok, "isRecording=", r.isRecording)
  if (!ok) {
    await new Promise<void>((res) => setTimeout(() => res(), 300))
    const msg =
      lastRecorderError !== null
        ? `record() false · onError=${lastRecorderError}`
        : "record() false · no onError fired"
    logErr(msg)
    writeError(msg)
    writeErrorKind("record")
    try {
      r.dispose()
    } catch {}
    return false
  }
  recorder = r
  writeFilePath(path)
  writeSessionStartedAt(Date.now())
  clearSessionEndedAt()
  return true
}

async function startSession(): Promise<void> {
  if (sessionActive) {
    log("startSession: already active")
    return
  }
  try {
    await configureAudioSession()
    log("BackgroundKeeper.keepAlive()")
    const kept = await BackgroundKeeper.keepAlive()
    log("BackgroundKeeper.keepAlive =>", kept)
    const ok = await startRecorder()
    if (!ok) {
      logErr("startSession: recorder failed to start; aborting")
      try {
        await BackgroundKeeper.stopKeepAlive()
      } catch {}
      try {
        await SharedAudioSession.setActive(false)
      } catch {}
      return
    }
    clearAction()
    // 归零 activeTree：新 session 起手，让所有键盘树从 activeTree=null
    // 分支起步（fast poll），等用户下次 tap 再写入新的 TREE_ID。避免
    // 上一轮残留的 TREE_ID 让新可见树被错误地判成 ghost 而进 slow poll。
    clearActiveTree()
    clearError()
    clearErrorKind()
    clearRawText()
    clearFinalText()
    clearSttMs()
    clearPolishMs()
    sessionActive = true
    workerCancelled = false
    writeState("armed")
    scheduleWorker()
    log("session armed · recorder running")
  } catch (e) {
    logErr("startSession failed:", String(e))
    writeError(`startSession: ${String(e)}`)
    writeErrorKind("setup")
    sessionActive = false
  }
}

async function teardownAudioSession(): Promise<void> {
  try {
    await BackgroundKeeper.stopKeepAlive()
    log("stopKeepAlive OK")
  } catch (e) {
    logErr("stopKeepAlive:", String(e))
  }
  try {
    await SharedAudioSession.setActive(false)
    log("setActive(false) OK")
  } catch (e) {
    logErr("setActive(false):", String(e))
  }
  sessionActive = false
  workerCancelled = true
}

// Unified error finalizer. Every failure path in stopAndTranscribe funnels
// through this so we can't accidentally (a) leave the audio session hot,
// (b) forget to flip state → done and keep the keyboard hanging in
// processing forever, or (c) drop the errorKind the keyboard needs for
// the right `[录音|转录|润色失败: …]` prefix.
//
// Safe to call exactly once per session. Does NOT clear rawText — if STT
// succeeded but polish failed, rawText stays in storage so the keyboard can
// fall back to inserting the unpolished transcript instead of an error
// placeholder (user preference: "even raw text beats an error").
async function abort(kind: VBErrorKind, reason: string): Promise<void> {
  logErr(`abort · kind=${kind} · reason=${reason}`)
  writeError(reason)
  writeErrorKind(kind)
  writeState("done")
  await teardownAudioSession()
}

const POLISH_INSTRUCTIONS = `你是一个语音输入润色助手。把用户口述的中文文本整理成自然流畅的书面或口语表达：
- 修正口误、错别字、识别错误。
- 加合适的标点。
- 保留用户原意，不要扩写、不要总结、不要回答问题、不要加任何解释。
- 直接输出润色后的文本，不要前缀，不要引号。`

// Defensive parser: Responses API has a few possible shapes depending on
// model + tool usage. Try the documented `output_text` shortcut first, then
// walk the structured `output[]` tree, then bail with a useful error.
function extractResponsesText(json: unknown): string {
  const j = json as {
    output_text?: string
    output?: Array<{
      type?: string
      text?: string
      content?: Array<{ type?: string; text?: string }>
    }>
  }
  if (typeof j.output_text === "string" && j.output_text.length > 0) {
    return j.output_text
  }
  if (Array.isArray(j.output)) {
    const parts: string[] = []
    for (const item of j.output) {
      if (typeof item.text === "string" && item.text.length > 0) {
        parts.push(item.text)
        continue
      }
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text === "string" && c.text.length > 0) {
            parts.push(c.text)
          }
        }
      }
    }
    if (parts.length > 0) return parts.join("")
  }
  throw new Error(
    `cannot extract text from response: ${JSON.stringify(json).slice(0, 300)}`
  )
}

async function polishWithOpenAI(
  rawText: string,
  key: string
): Promise<string> {
  log("openai POST · raw len=", rawText.length)
  const t0 = Date.now()
  // Responses API 的 input 接受 plain string（隐式 user role），是最简形式。
  // reasoning.effort 在测试期保持 "none" 关掉思考，加快响应、节省 token。
  // 文档支持的 effort 值：none | minimal | low | medium | high | xhigh
  // 仅对 gpt-5 / o 系列 reasoning 模型生效。
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      input: rawText,
      instructions: POLISH_INSTRUCTIONS,
      reasoning: { effort: "none" },
      max_output_tokens: 1024,
    }),
  })
  const elapsedMs = Date.now() - t0
  log("openai response", res.status, `${elapsedMs}ms`)
  if (!res.ok) {
    const errBody = await res.text().catch(() => "<no body>")
    throw new Error(
      `openai ${res.status}: ${errBody.slice(0, 200)}`
    )
  }
  const json = await res.json()
  // 第一次接入务必打全响应（Responses API 的 output[] 嵌套结构变种较多）
  log("openai raw json:", JSON.stringify(json).slice(0, 800))
  const text = extractResponsesText(json)
  log("openai polished len=", text.length, "preview=", text.slice(0, 60))
  writePolishMs(elapsedMs)
  return text
}

async function transcribeWithScribe(
  filePath: string,
  key: string
): Promise<string> {
  log("scribe POST · file=", filePath)
  const data = Data.fromFile(filePath)
  if (data === null) throw new Error("Data.fromFile returned null")
  const form = new FormData()
  form.append("file", data, "audio/mp4", "rec.m4a")
  form.append("model_id", "scribe_v2")
  form.append("language_code", "zho")
  form.append("tag_audio_events", "false")
  const t0 = Date.now()
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  })
  const elapsedMs = Date.now() - t0
  log("scribe response", res.status, `${elapsedMs}ms`)
  if (!res.ok) {
    const errBody = await res.text().catch(() => "<no body>")
    throw new Error(
      `scribe ${res.status}: ${errBody.slice(0, 200)}`
    )
  }
  const json = (await res.json()) as { text?: string }
  const text = String(json?.text ?? "")
  log("scribe text len=", text.length, "preview=", text.slice(0, 60))
  if (text.length === 0) throw new Error("scribe returned empty text")
  writeSttMs(elapsedMs)
  return text
}

async function stopAndTranscribe(): Promise<void> {
  log("---- stopAndTranscribe ----")
  // 1. stop recorder synchronously; do NOT tear down audio session yet —
  //    we want the fetch below to keep running even after Scripting goes
  //    to background once the user switches back to the host app.
  const path = readFilePath()
  if (recorder !== null) {
    try {
      recorder.stop()
      log("recorder.stop OK")
    } catch (e) {
      logErr("recorder.stop:", String(e))
    }
    try {
      recorder.dispose()
    } catch (e) {
      logErr("recorder.dispose:", String(e))
    }
    recorder = null
  }
  writeSessionEndedAt(Date.now())

  // 2. enter STT phase
  writeState("transcribing")
  log("state=transcribing")

  if (path === null) {
    await abort("setup", "录音文件路径丢失")
    return
  }
  const key = readScribeKey()
  if (key === null || key.length === 0) {
    await abort("setup", "缺少 ElevenLabs key")
    return
  }

  let rawText: string
  try {
    rawText = await transcribeWithScribe(path, key)
    writeRawText(rawText)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    logErr("transcribe failed:", msg)
    await abort("stt", msg)
    return
  }

  // 3. polish phase (optional — skipped if no OpenAI key)
  const openaiKey = readOpenAIKey()
  if (openaiKey === null || openaiKey.length === 0) {
    log("no OpenAI key · skipping polish · state=done with rawText")
    writeState("done")
    await teardownAudioSession()
    return
  }
  writeState("polishing")
  log("state=polishing")
  try {
    const polished = await polishWithOpenAI(rawText, openaiKey)
    writeFinalText(polished)
    writeState("done")
    log("polish ok · state=done · keyboard will consume finalText")
    await teardownAudioSession()
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    logErr("polish failed:", msg)
    // rawText 留在 storage — 键盘优先级是 finalText > rawText > errorPlaceholder，
    // 所以润色失败时用户仍然会看到未润色的原文插入，而不是错误占位。
    await abort("polish", msg)
  }
}

async function resetToIdle(): Promise<void> {
  log("resetToIdle")
  if (recorder !== null) {
    try {
      recorder.stop()
    } catch {}
    try {
      recorder.dispose()
    } catch {}
    recorder = null
  }
  try {
    await BackgroundKeeper.stopKeepAlive()
  } catch {}
  try {
    await SharedAudioSession.setActive(false)
  } catch {}
  sessionActive = false
  workerCancelled = true
  clearAction()
  // 关键：清空 activeTree。否则上一轮的 TREE_ID 残留在 storage 里，
  // 下一次进宿主 app 后新可见的键盘树读到非空 activeTree 且不等于自己，
  // 会被 L3 判成 ghost 进入 slow 5s poll，UI 更新滞后，用户感知为
  // "键盘卡住、点停止无反应"（但 mic 其实还在录）。
  clearActiveTree()
  clearSessionStartedAt()
  clearSessionEndedAt()
  clearRawText()
  clearFinalText()
  clearErrorKind()
  clearSttMs()
  clearPolishMs()
  writeState("idle")
}

function scheduleWorker(): void {
  if (workerCancelled) return
  workerTick().finally(() => {
    if (workerCancelled) return
    setTimeout(scheduleWorker, 400)
  })
}

async function workerTick(): Promise<void> {
  writeHeartbeat()
  const action = readAction()
  if (!action) return
  const state = readState()
  log("worker tick · action=", action, "state=", state)

  if (action === "stop") {
    clearAction()
    if (state !== "armed") {
      log("stop ignored · state not armed")
      return
    }
    await stopAndTranscribe()
    return
  }

  log("unknown action, clearing")
  clearAction()
}

async function foregroundTestRecord(): Promise<void> {
  log("---- foregroundTestRecord START ----")
  if (sessionActive) {
    log("already active, aborting test")
    return
  }
  await startSession()
  if (!sessionActive) {
    log("foreground test: startSession failed")
    return
  }
  log("recording for 2s in foreground…")
  await new Promise<void>((res) => setTimeout(() => res(), 2000))
  await stopAndTranscribe()
  log("---- foregroundTestRecord END · state=done ----")
}

function MainView() {
  const dismiss = Navigation.useDismiss()
  const [tick, setTick] = useState(0)
  const [bgActive, setBgActive] = useState<boolean | null>(null)
  const [scribeKeyDraft, setScribeKeyDraft] = useState<string>(
    readScribeKey() ?? ""
  )
  const [openAIKeyDraft, setOpenAIKeyDraft] = useState<string>(
    readOpenAIKey() ?? ""
  )

  useEffect(() => {
    const q = Script.queryParameters ?? {}
    log("mount · queryParameters=", JSON.stringify(q))
    if (q.action === "arm") {
      log("auto-arm from URL scheme")
      startSession()
    }
    let cancelled = false
    const refresh = () => {
      if (cancelled) return
      setTick((v) => v + 1)
      BackgroundKeeper.isActive.then(setBgActive).catch(() => {})
      setTimeout(refresh, 400)
    }
    refresh()
    return () => {
      cancelled = true
    }
  }, [])

  const state = readState()
  const sessionStartedAt = readSessionStartedAt()
  const sessionEndedAt = readSessionEndedAt()
  const filePath = readFilePath()
  const err = readError()
  const errKind = readErrorKind()
  const heartbeat = readHeartbeat()
  const rawText = readRawText()
  const finalText = readFinalText()
  const sttMs = readSttMs()
  const polishMs = readPolishMs()
  const q = Script.queryParameters ?? {}
  const qpStr = JSON.stringify(q)
  const logEntries = readLog()
  const recentLog = logEntries.slice(-200)
  const recentLogText = formatLog(recentLog)

  const now = Date.now()
  const recordingSec =
    state === "armed" && sessionStartedAt !== null
      ? ((now - sessionStartedAt) / 1000).toFixed(1)
      : null
  const finalDurSec =
    state === "done" &&
    sessionStartedAt !== null &&
    sessionEndedAt !== null
      ? ((sessionEndedAt - sessionStartedAt) / 1000).toFixed(1)
      : null
  const heartbeatAgo =
    heartbeat !== null ? ((now - heartbeat) / 1000).toFixed(1) : "—"

  const onEnd = async () => {
    await resetToIdle()
    dismiss()
    Script.exit()
  }

  const statusLabel =
    state === "armed" && recordingSec !== null
      ? `armed · 录音中 ${recordingSec}s`
      : state === "transcribing"
      ? "transcribing · 转录中…"
      : state === "polishing"
      ? "polishing · 润色中…"
      : state === "done" && finalDurSec !== null
      ? `done · 时长 ${finalDurSec}s（等待键盘插入）`
      : state

  const statusColor:
    | "orange"
    | "systemGreen"
    | "systemRed"
    | "systemBlue"
    | "label" =
    err !== null
      ? "systemRed"
      : state === "armed"
      ? "orange"
      : state === "transcribing" || state === "polishing"
      ? "systemBlue"
      : state === "done"
      ? "systemGreen"
      : "label"

  const scribeKeySet = (readScribeKey() ?? "").length > 0
  const openAIKeySet = (readOpenAIKey() ?? "").length > 0

  const fmtSec = (ms: number): string => (ms / 1000).toFixed(2) + "s"
  const latencyLine = (() => {
    if (sttMs === null && polishMs === null) return null
    const parts: string[] = []
    if (sttMs !== null) parts.push(`STT ${fmtSec(sttMs)}`)
    if (polishMs !== null) parts.push(`polish ${fmtSec(polishMs)}`)
    if (sttMs !== null && polishMs !== null) {
      parts.push(`合计 ${fmtSec(sttMs + polishMs)}`)
    }
    return parts.join(" · ")
  })()

  return (
    <NavigationStack>
      <ScrollView
        navigationTitle="Voiceboard"
        navigationBarTitleDisplayMode="inline"
      >
        <VStack spacing={16} padding={20} alignment="leading">
          {q.action === "arm" && state !== "idle" ? (
            <Text font="footnote" foregroundStyle="orange">
              已从键盘唤起 · 请切回刚才输入文字的 App 继续录音
            </Text>
          ) : null}

          <VStack spacing={6} alignment="leading">
            <Text font="caption" foregroundStyle="secondaryLabel">
              ⚙ Keys
            </Text>
            <SecureField
              title="ElevenLabs Scribe Key"
              prompt="xi-api-key"
              value={scribeKeyDraft}
              onChanged={(v) => {
                setScribeKeyDraft(v)
                if (v.length > 0) writeScribeKey(v)
                else clearScribeKey()
                setTick((t) => t + 1)
              }}
            />
            <SecureField
              title="OpenAI Key"
              prompt="sk-..."
              value={openAIKeyDraft}
              onChanged={(v) => {
                setOpenAIKeyDraft(v)
                if (v.length > 0) writeOpenAIKey(v)
                else clearOpenAIKey()
                setTick((t) => t + 1)
              }}
            />
            <Text font="footnote" foregroundStyle="secondaryLabel">
              scribe {scribeKeySet ? "✓" : "✗"} · openai{" "}
              {openAIKeySet ? "✓" : "✗"}
            </Text>
          </VStack>

          <VStack spacing={4} alignment="leading">
            <Text font="caption" foregroundStyle="secondaryLabel">
              状态
            </Text>
            <Text font="title" foregroundStyle={statusColor}>
              {statusLabel}
            </Text>
          </VStack>

          <VStack spacing={8} alignment="leading">
            <Text font="caption" foregroundStyle="secondaryLabel">
              操作
            </Text>
            {state === "idle" ? (
              <Button title="开启录音会话（前台）" action={startSession} />
            ) : (
              <Button title="强制终止会话" action={onEnd} />
            )}
            <Button
              title="🔬 前台测试录音 2 秒"
              action={foregroundTestRecord}
            />
            <Button
              title="清除状态（重置到 idle）"
              action={async () => {
                await resetToIdle()
                clearError()
                setTick((v) => v + 1)
              }}
            />
          </VStack>

          {state === "armed" ? (
            <Text foregroundStyle="secondaryLabel">
              切到任意 App，唤出 Scripting 键盘，点麦克风即停止并插入
            </Text>
          ) : null}

          {filePath !== null ? (
            <VStack spacing={4} alignment="leading">
              <Text font="caption" foregroundStyle="secondaryLabel">
                录音文件
              </Text>
              <Text font="footnote">{filePath}</Text>
              {sessionStartedAt !== null ? (
                <Text font="footnote" foregroundStyle="secondaryLabel">
                  started at {sessionStartedAt}
                </Text>
              ) : null}
              {sessionEndedAt !== null ? (
                <Text font="footnote" foregroundStyle="secondaryLabel">
                  ended at {sessionEndedAt}
                </Text>
              ) : null}
            </VStack>
          ) : null}

          {rawText !== null ? (
            <VStack spacing={4} alignment="leading">
              <Text font="caption" foregroundStyle="secondaryLabel">
                Scribe 转录（rawText）
              </Text>
              <Text font="footnote">{rawText}</Text>
            </VStack>
          ) : null}

          {finalText !== null ? (
            <VStack spacing={4} alignment="leading">
              <Text font="caption" foregroundStyle="secondaryLabel">
                OpenAI 润色（finalText）
              </Text>
              <Text font="footnote">{finalText}</Text>
            </VStack>
          ) : null}

          {err !== null ? (
            <VStack spacing={4} alignment="leading">
              <Text font="caption" foregroundStyle="red">
                错误{errKind !== null ? ` · ${errKind}` : ""}
              </Text>
              <Text font="footnote" foregroundStyle="red">
                {err}
              </Text>
              <Button
                title="清除错误"
                action={() => {
                  clearError()
                  clearErrorKind()
                  setTick((v) => v + 1)
                }}
              />
            </VStack>
          ) : null}

          <VStack spacing={4} alignment="leading">
            <Text font="caption" foregroundStyle="secondaryLabel">
              调试
            </Text>
            {latencyLine !== null ? (
              <Text font="footnote" foregroundStyle="systemBlue">
                上次链路耗时 · {latencyLine}
              </Text>
            ) : null}
            <Text font="footnote">
              BackgroundKeeper.isActive ={" "}
              {bgActive === null ? "…" : String(bgActive)}
            </Text>
            <Text font="footnote">sessionActive = {String(sessionActive)}</Text>
            <Text font="footnote">
              recorder != null = {String(recorder !== null)}
            </Text>
            <Text font="footnote">heartbeat {heartbeatAgo}s ago</Text>
            <Text font="footnote">queryParameters = {qpStr}</Text>
            <Text font="footnote">
              Script.name = {Script.name} · tick={tick}
            </Text>
            <Text font="footnote">
              lastRecorderError = {lastRecorderError ?? "—"}
            </Text>
          </VStack>

          <VStack spacing={6} alignment="leading">
            <HStack spacing={8}>
              <Text font="caption" foregroundStyle="secondaryLabel">
                日志 ({logEntries.length})
              </Text>
              <Spacer />
              <Button
                title="📋 复制"
                action={async () => {
                  const all = formatLog(readLog())
                  await Pasteboard.setString(all)
                  log("log copied to pasteboard ·", all.length, "chars")
                  setTick((v) => v + 1)
                }}
              />
              <Button
                title="🗑 清空"
                action={() => {
                  clearLog()
                  setTick((v) => v + 1)
                }}
              />
            </HStack>
            <Text font="footnote">
              {recentLogText.length > 0 ? recentLogText : "(空)"}
            </Text>
          </VStack>
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}

async function run() {
  log("script run · env=", Script.env)
  if (Script.env !== "index") {
    Script.exit()
    return
  }
  await Navigation.present({ element: <MainView /> })
  log("script exit")
  Script.exit()
}

run()
