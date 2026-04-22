import {
  Button,
  HStack,
  LiveActivity,
  Navigation,
  NavigationStack,
  Path,
  Script,
  ScrollView,
  SecureField,
  Slider,
  Spacer,
  Text,
  Toggle,
  useEffect,
  useState,
  VStack,
} from "scripting"

import {
  VBActivityState,
  VoiceboardWarmActivity,
} from "./live_activity"

import {
  buildRecordingPath,
  buildWarmKeeperPath,
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
  clearWarmDurationMs,
  clearWarmUntil,
  ensureRecordingsDir,
  formatLog,
  readAction,
  readError,
  readErrorKind,
  readFilePath,
  readFinalText,
  readHeartbeat,
  readInputMode,
  readLog,
  readOpenAIKey,
  readPolishMs,
  readPolishTimeoutSec,
  readRawText,
  readScribeKey,
  readSessionEndedAt,
  readSessionStartedAt,
  readSttMs,
  readState,
  readTune,
  readTuneBool,
  readWarmDurationMs,
  readWarmUntil,
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
  writePolishTimeoutSec,
  writeRawText,
  writeScribeKey,
  writeSessionEndedAt,
  writeSessionStartedAt,
  writeSttMs,
  writeState,
  writeTune,
  writeTuneBool,
  writeWarmDurationMs,
  writeWarmUntil,
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

// ---------------------------------------------------------------------------
// Stage 4.5b — warm 保持态模块级状态
//
// 和 4.5a 实验的 `silentKeeper` / `expActivity` 变量区分开：实验变量仅在
// experiment 运行时用，生产 warm 路径用下面这组。两组互斥（experiment 启动
// 前会检查 sessionActive；startWarmSession 会拒绝 expRunning 非空的情况）。
// ---------------------------------------------------------------------------

// warm 窗口内持续录到 warm_keeper.m4a 的静音 recorder。arm 时停掉并 dispose，
// stop/cycle end 后 restart。生命周期严格挂在 warm 状态上。
let warmSilentKeeper: AudioRecorder | null = null

// warm/armed/processing 全程同一个 LiveActivity instance。startWarmSession
// 创建，stopWarmSession end。中间只做 update，不换 instance。
let warmActivity: LiveActivity<VBActivityState> | null = null

// LA update 节流：全局 ≥1s/次。iOS 对 audio 模式 + 高频 LA update 有限流
// （Apple dev forum 明确），超频会被 forbid；worker tick 400ms 自然会超
// 限，必须自己在这里挡。
let lastActivityUpdateAt = 0
const ACTIVITY_UPDATE_MIN_GAP_MS = 1000

// "state=done 之后过了多久" 记账。worker 用它来给 keyboard 一个消费窗口：
// 至少等 1s（让键盘 400ms poll 至少跑 2 轮）+ 最多等 3s（keyboard 消费
// 完会清 rawText/finalText，worker 检测到即调 handleCycleEnd；若 keyboard
// 没消费到，3s 后也强制推进避免卡死）。
let doneStateSetAt = 0

// handleCycleEnd 已经排期了吗？防止 worker tick 重复触发。
let cycleEndInFlight = false

// coldStartArmed 未读到用户偏好时的默认时长。3 min 与主页 duration picker
// 默认档位一致；用户第一次从键盘激活、还没在主 app 配置过时就是这个值。
const DEFAULT_WARM_DURATION_MS = 3 * 60 * 1000

// Stage 5a — 调试回放用的 AVPlayer 单例。MainView "录音文件" section 的
// ▶/⏸ 按钮使用，让用户能听刚录的 m4a，排查"转录不对"到底是录音坏了还是
// STT/polish 理解错。纯调试工具：不接 warm/armed session 的任何生命周期，
// 不 dispose（Scripting 关 script 时会自动回收）。
let debugPlayer: AVPlayer | null = null

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

// Legacy cold-start without warm 保持机制：仅用于 MainView 的"开启录音会话
// （前台）" debug 按钮 + foregroundTestRecord。**用户走键盘 cold-start 的路径
// 应改调 coldStartArmed（经 warm 全套 → armed），不走这条老路。**
async function startSession(): Promise<void> {
  if (sessionActive) {
    log("startSession: already active")
    return
  }
  // 归零 activeTree：新 session 起手，让所有键盘树从 activeTree=null 分支
  // 起步（fast poll）。**必须在 await 前**，否则 iOS 在 configureAudioSession
  // 的 ~300ms 里重建 keyboard VC，新树会读到还没被清掉的上一轮 T_tap.ID
  // → L3 进 slow poll → 用户感觉"卡死"。（Stage 4 hygiene 修复在 v2 cold-start
  // 路径的 recurrence 修复，见 memory/feedback_ghost_keyboard_l1_l2_l3.md）
  clearActiveTree()
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
    clearError()
    clearErrorKind()
    clearRawText()
    clearFinalText()
    clearSttMs()
    clearPolishMs()
    // 旧 warm 实例的 warmUntil 清掉（避免 handleCycleEnd 误判"回 warm"）；
    // **warmDurationMs 不清** —— 那是用户的持久化时长偏好，跨重启保留。
    clearWarmUntil()
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

// ---------------------------------------------------------------------------
// Stage 4.5b — warm 保持态核心
// ---------------------------------------------------------------------------

// LA update 节流门闸。worker tick 调这个就行，不直接用 activity.update。
async function throttledActivityUpdate(
  state: VBActivityState
): Promise<void> {
  if (warmActivity === null) return
  const now = Date.now()
  if (now - lastActivityUpdateAt < ACTIVITY_UPDATE_MIN_GAP_MS) return
  lastActivityUpdateAt = now
  try {
    await warmActivity.update(state)
  } catch (e) {
    logErr("activity.update failed:", String(e))
  }
}

// 启动静音 keeper recorder。warm 窗口内它必须一直活着（audio 背景模式 +
// Live Activity 的官方组合要求有 active audio I/O）。
//
// **v2 架构下只在 `startWarmSession` 里调一次**（整个 warm 窗口唯一一次）。
// handleCycleEnd 和 armFromWarm 不再调这个函数 —— v1 曾经在 handleCycleEnd
// 里"重启 keeper"，实测 100% 失败（详见 memory/feedback_keyboard_warm_trigger_option_a.md
// 的"v1 架构错误教训"）。v2 承认"stop 过的 recording 上下文无法重建"，
// 改成 keeper 全程不停 + real recorder 与之并行。
//
// 下面的 setActive re-confirm + 文件清理 + 200ms retry 是从 v1 继承的防御措施；
// 在 v2 的单次调用场景里 retry 基本不会触发，但保留无害。
async function startWarmSilentKeeper(): Promise<boolean> {
  if (warmSilentKeeper !== null) {
    log("startWarmSilentKeeper: already running, skipping")
    return true
  }
  const path = await buildWarmKeeperPath()
  log("warmSilentKeeper path=", path)

  // 清掉上一轮的文件，避免 AudioRecorder 初始化时碰到残留 header。
  // iOS 的 AVAudioRecorder 理论上会覆盖，但实测偶发对 overwrite 不友好；
  // 一次 remove 更保险，FileManager.remove 不存在时自己吞异常。
  try {
    await FileManager.remove(path)
    log("warmSilentKeeper: removed stale file")
  } catch {
    // 文件不存在 / 删不掉都当 noop
  }

  // 内部 attempt 函数：setActive(true) + create + record；record() false 返 false。
  const attempt = async (label: string): Promise<boolean> => {
    try {
      await SharedAudioSession.setActive(true)
      log(`warmSilentKeeper[${label}]: setActive(true) re-confirmed`)
    } catch (e) {
      logErr(
        `warmSilentKeeper[${label}]: setActive(true) threw:`,
        String(e)
      )
    }
    let r: AudioRecorder
    try {
      r = await AudioRecorder.create(path, {
        format: "MPEG4AAC",
        sampleRate: 22050,
        numberOfChannels: 1,
        encoderAudioQuality: AVAudioQuality.low,
      })
    } catch (e) {
      logErr(
        `warmSilentKeeper[${label}]: AudioRecorder.create threw:`,
        String(e)
      )
      return false
    }
    r.onError = (m: string) => {
      logErr("warmSilentKeeper.onError:", m)
    }
    r.onFinish = (ok: boolean) => {
      log("warmSilentKeeper.onFinish ok=", ok)
    }
    const ok = r.record()
    log(
      `warmSilentKeeper[${label}].record()=`,
      ok,
      "isRecording=",
      r.isRecording
    )
    if (!ok) {
      try {
        r.dispose()
      } catch {}
      return false
    }
    warmSilentKeeper = r
    return true
  }

  // First try
  if (await attempt("try1")) return true

  // 失败：等一小段让 iOS session 状态稳定，然后重试一次。200ms 是经验值，
  // 对应 AVAudioSession 的内部状态切换时间（实测 iOS 18/17 都够用）。
  logErr("warmSilentKeeper: try1 failed, waiting 200ms then retry")
  await new Promise<void>((res) => setTimeout(res, 200))
  if (await attempt("try2")) return true

  logErr("warmSilentKeeper: try2 also failed, giving up")
  return false
}

async function stopWarmSilentKeeper(): Promise<void> {
  if (warmSilentKeeper === null) return
  try {
    warmSilentKeeper.stop()
    log("warmSilentKeeper.stop OK")
  } catch (e) {
    logErr("warmSilentKeeper.stop:", String(e))
  }
  try {
    warmSilentKeeper.dispose()
  } catch (e) {
    logErr("warmSilentKeeper.dispose:", String(e))
  }
  warmSilentKeeper = null
}

// 启动一个 warm 保持窗口。若 sessionActive 已经 true，只展期（更新
// warmUntil / activity），不重开 session。否则走完整启动链：audio session
// → keepAlive → silent keeper → LA → state=warm → scheduleWorker。
//
// 成功 return true；失败（静音 keeper 起不来等）会回滚并 return false。
async function startWarmSession(durationMs: number): Promise<boolean> {
  const newUntil = Date.now() + durationMs
  log(
    "startWarmSession · durationMs=",
    durationMs,
    "newWarmUntil=",
    newUntil,
    "sessionActive=",
    sessionActive
  )

  // 已有 session：只展期 + update activity + 同步 warmUntil。
  if (sessionActive) {
    writeWarmDurationMs(durationMs)
    writeWarmUntil(newUntil)
    const cur = readState()
    if (cur === "warm") {
      await throttledActivityUpdate({
        status: "warm",
        remainingSec: Math.floor(durationMs / 1000),
      })
    }
    return true
  }

  // Fresh start。
  //
  // **在任何 await 之前先清 activeTree**。理由：走到这里的路径包括"键盘 tap
  // 触发 cold-start"，tap 刚往 Storage 写了 activeTree=T_tap.ID。configureAudioSession
  // 往下 ~300ms 里 iOS 可能重建 keyboard VC，新树读到 T_tap.ID（不是自己）
  // + state 还是 idle → L3 判 slow poll → 用户感到"卡死"。早清 → 窗口归零。
  // MainView useEffect mount 也做了一次，这里是二道保险（belt+suspenders）。
  clearActiveTree()
  try {
    await configureAudioSession()
    await BackgroundKeeper.keepAlive()
    log("startWarmSession: keepAlive OK")

    // LA 必须在 silent keeper 之前拉起（Scripting 官方组合的语义是"有
    // Live Activity 的前提下后台 audio 才能持久"；虽然顺序未必关键，
    // 但按文档示例顺序来最保险）。
    try {
      const instance = VoiceboardWarmActivity()
      const ok = await instance.start({
        status: "warm",
        remainingSec: Math.floor(durationMs / 1000),
      })
      log("warmActivity.start =>", ok)
      warmActivity = instance
      lastActivityUpdateAt = Date.now()
    } catch (e) {
      logErr("startWarmSession: activity.start failed:", String(e))
      await BackgroundKeeper.stopKeepAlive().catch(() => {})
      await SharedAudioSession.setActive(false).catch(() => {})
      writeError(`LA 启动失败: ${String(e)}`)
      writeErrorKind("setup")
      return false
    }

    const keeperOk = await startWarmSilentKeeper()
    if (!keeperOk) {
      logErr("startWarmSession: silent keeper failed")
      // 回滚 LA + audio session
      try {
        await warmActivity.end(
          { status: "error", errorLabel: "启动失败" },
          { dismissTimeInterval: 0 }
        )
      } catch {}
      warmActivity = null
      await BackgroundKeeper.stopKeepAlive().catch(() => {})
      await SharedAudioSession.setActive(false).catch(() => {})
      writeError("静音 keeper 启动失败")
      writeErrorKind("record")
      return false
    }

    // 清 session 脏数据（activeTree 已在函数顶清过，不重复）
    clearAction()
    clearError()
    clearErrorKind()
    clearRawText()
    clearFinalText()
    clearSttMs()
    clearPolishMs()
    clearSessionStartedAt()
    clearSessionEndedAt()
    writeFilePath("") // 置空，后续 arm 时覆盖

    writeWarmDurationMs(durationMs)
    writeWarmUntil(newUntil)

    sessionActive = true
    workerCancelled = false
    doneStateSetAt = 0
    cycleEndInFlight = false
    writeState("warm")

    scheduleWorker()
    log(
      "startWarmSession: OK · state=warm · warmUntil=",
      newUntil
    )
    return true
  } catch (e) {
    logErr("startWarmSession failed:", String(e))
    writeError(`startWarmSession: ${String(e)}`)
    writeErrorKind("setup")
    sessionActive = false
    return false
  }
}

// 结束整个 warm 会话：停 silent keeper、end LA、tear down audio session、
// 清 warm 相关 storage、state=idle。调用场景：warm 到期、用户手动提前结束、
// record 级 hard error。
async function stopWarmSession(reason: string): Promise<void> {
  log("stopWarmSession · reason=", reason)
  await stopWarmSilentKeeper()

  // 真实 recorder 如果还活着也要关（armed 期间被 stopWarmSession 打断的场景）
  if (recorder !== null) {
    try {
      recorder.stop()
    } catch (e) {
      logErr("stopWarmSession: recorder.stop:", String(e))
    }
    try {
      recorder.dispose()
    } catch (e) {
      logErr("stopWarmSession: recorder.dispose:", String(e))
    }
    recorder = null
  }

  if (warmActivity !== null) {
    try {
      const lastErr = readError()
      const finalState: VBActivityState =
        lastErr !== null
          ? { status: "error", errorLabel: readErrorKind() ?? "错误" }
          : { status: "warm", remainingSec: 0 }
      await warmActivity.end(finalState, { dismissTimeInterval: 0 })
      log("warmActivity.end OK (immediate dismiss)")
    } catch (e) {
      logErr("warmActivity.end:", String(e))
    }
    warmActivity = null
  }

  await teardownAudioSession()
  clearWarmUntil()
  // 注意：**不清 warmDurationMs**。持久化的用户偏好，跨 warm 结束要保留，
  // 下次冷启动 / 打开主 app 时 duration picker 才能回填到用户上次选的档位。
  doneStateSetAt = 0
  cycleEndInFlight = false
  writeState("idle")
}

// 一次录音 cycle（armed → transcribing → polishing → done）结束之后的
// 分流：若 warmUntil 还在窗口内 → 回到 warm（restart silent keeper，update
// activity），否则 → stopWarmSession 全量收尾。
//
// 被 workerTick 的 "done 且 keyboard 已消费" 分支调用；保证对每次 done
// 只跑一次（cycleEndInFlight 互斥）。
// v2（keeper 并行不停架构）：一次录音 cycle 结束后的分流。
//
// v1 在这里 restart keeper（失败），v2 完全不碰 keeper —— 整个 warm 窗口
// 里 keeper 只在 startWarmSession 启动一次、stopWarmSession 停止一次。
// 这里只做两件事：
//   a) 软错误（stt/polish）或正常完成 + warm 未过期 → writeState("warm") + LA update
//   b) 硬错误（record/setup）或 warm 已过期 → stopWarmSession 全量收尾
async function handleCycleEnd(): Promise<void> {
  if (cycleEndInFlight) {
    log("handleCycleEnd: already in flight, skipping")
    return
  }
  cycleEndInFlight = true
  try {
    const errKind = readErrorKind()
    const warmUntil = readWarmUntil()
    const now = Date.now()
    const warmActive = warmUntil !== null && warmUntil > now

    // Record / setup 级错误 = 保活机制本身坏了，强制 teardown 而不是继续 warm。
    // STT / polish 级错误是上游服务问题，录音本身 OK，让用户在 warm 里重试。
    const isHardError = errKind === "record" || errKind === "setup"

    log(
      "handleCycleEnd · errKind=",
      errKind,
      "warmActive=",
      warmActive,
      "isHardError=",
      isHardError,
      "keeper.isRecording=",
      warmSilentKeeper?.isRecording ?? "null"
    )

    if (isHardError || !warmActive) {
      await stopWarmSession(
        isHardError ? `hard error (${errKind})` : "warmUntil expired"
      )
      return
    }

    // v2：keeper 从未 stop，直接保持 warm。不碰 warmSilentKeeper。
    // 健全性：如果 keeper 真的意外死了，这就是架构不变式违反，
    // 上层的 workerTick watchdog 会在下一 tick 检测到并 abort。
    // 这里不做恢复尝试 —— 见 memory/feedback_keyboard_warm_trigger_option_a.md。
    clearSessionStartedAt()
    clearSessionEndedAt()
    clearRawText()
    clearFinalText()
    doneStateSetAt = 0
    writeState("warm")

    const remainingSec = Math.max(0, Math.floor((warmUntil - now) / 1000))
    await throttledActivityUpdate({
      status: "warm",
      remainingSec,
    })
    log(
      "handleCycleEnd: back to warm · remainingSec=",
      remainingSec,
      "· keeper unchanged"
    )
  } finally {
    cycleEndInFlight = false
  }
}

// 处理 keyboard 的 "arm" action：warm → armed 的转换。停静音 keeper、
// 起 real recorder、写 state=armed、LA 切 armed。
// v2（keeper 并行不停架构）：处理 keyboard 的 "arm" action，warm → armed 转换。
//
// 关键差异 vs v1：
//   v1 先 stop warmSilentKeeper 再 startRecorder（real）—— 这一步 stop 撕掉
//   iOS AVAudioSession 的 recording 上下文，下一轮 handleCycleEnd 重启 keeper
//   时会失败（详见 memory/feedback_keyboard_warm_trigger_option_a.md "v1 架构
//   错误教训"）。
//   v2 **不动 keeper**，让它继续录 warm_keeper.m4a。直接起 real recorder，
//   两个 recorder 并行录音到各自文件。iOS 录音上下文始终有活的 recorder 撑
//   着 → 永不撕掉 → 后续所有 create + record 都能成功。
//
// 依据：dts/global.d.ts:5005-5017 的 recorderOne/Two.record({atTime}) 官方
// 示例就是两 recorder 并行。
async function armFromWarm(): Promise<void> {
  log("armFromWarm START (v2: parallel keeper)")
  if (!sessionActive) {
    logErr("armFromWarm: sessionActive=false, abort")
    return
  }
  const state = readState()
  if (state !== "warm") {
    log("armFromWarm: state !=", "warm, got", state, "— skip")
    return
  }

  // v2：不 stopWarmSilentKeeper！keeper 继续录，与 real recorder 并行。
  // 这是整个架构的核心不变式（见 memory 教训）。
  if (warmSilentKeeper === null || !warmSilentKeeper.isRecording) {
    // 这本来不该发生（keeper 应全程活着）。但真遇到就 abort warm，
    // 不要在这里尝试 restart（那正是 v1 栽跟头的地方）。
    logErr(
      "armFromWarm: BUG · warmSilentKeeper not alive when arm requested;",
      "keeper=",
      warmSilentKeeper === null ? "null" : "exists",
      "isRecording=",
      warmSilentKeeper?.isRecording
    )
    writeError("keeper 意外停止（iOS 可能回收了输入）")
    writeErrorKind("record")
    await stopWarmSession("armFromWarm keeper invariant violated")
    return
  }

  // 起 real recorder（复用现有 startRecorder）。keeper 同时在录。
  const ok = await startRecorder()
  if (!ok) {
    // real 起不来（mic 被其他 app 抢占？）。keeper 本来就没停，
    // 不需要回滚 —— 直接保持 warm 让用户重试。
    // 注：startRecorder 内部已经 writeError + writeErrorKind("record")
    logErr("armFromWarm: startRecorder failed; staying in warm")
    writeState("warm")
    return
  }

  writeState("armed")
  await throttledActivityUpdate({
    status: "armed",
    elapsedSec: 0,
  })
  log("armFromWarm: OK · state=armed · keeper still running in parallel")
}

// --------------------------------------------------------------------------
// coldStartArmed：从键盘冷启动（或"开启录音会话"按钮的未来升级路径）过来，
// 把 warm 全套 + real recorder 一次性拉齐，state → armed。
//
// v2.4.5 Issue #1 的修复：之前键盘 idle tap → Safari.openURL(run_single,
// action=arm) → MainView useEffect → startSession → 仅 armed（无 warm 保持）。
// 录完一次 cycle 结束就 teardown，用户下一次要再走一遍冷启动。这不符合
// Typeless 的"一次激活保持 N 分钟"心智。
//
// v2.4.5 起：键盘冷启动等价于在主 app 点"激活保持 X min"+ 立刻开始录。
// X 从用户持久化的 warmDurationMs 读，没有就用 DEFAULT_WARM_DURATION_MS（3 min）。
// cycle 结束后 handleCycleEnd 自然回 warm 等下次 tap，跟主 app 激活的体验一致。
// --------------------------------------------------------------------------
async function coldStartArmed(): Promise<void> {
  if (sessionActive) {
    log("coldStartArmed: sessionActive already true, skipping")
    return
  }
  const pref = readWarmDurationMs()
  const dur = pref !== null && pref > 0 ? pref : DEFAULT_WARM_DURATION_MS
  log(
    "coldStartArmed START · durationMs=",
    dur,
    pref === null ? "(default)" : "(user pref)"
  )

  const warmOk = await startWarmSession(dur)
  if (!warmOk) {
    logErr("coldStartArmed: startWarmSession failed, abort")
    return
  }

  // state 现在是 warm，warmActivity + warmSilentKeeper 已经跑着。
  // 直接进入 armed。armFromWarm 内部会检查 state==="warm" + sessionActive。
  await armFromWarm()
  // 到这里，如果 armFromWarm 成功 → state=armed；失败（startRecorder 返回
  // false）→ state 回到 warm（用户可以从主 app 看到"保持中"，下次再点尝试）。
  log("coldStartArmed END · state=", readState())
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

// Stage 6a — 翻译模式 prompt。键盘 pill 选「翻译」时 worker 用这条替换
// POLISH_INSTRUCTIONS。输入: Scribe 转出的中文。输出: 自然英文。
const TRANSLATE_INSTRUCTIONS = `You are a speech translation assistant. The user dictated in Chinese; translate the transcript into natural, conversational English:
- Preserve the speaker's meaning, tone, and register.
- Fix obvious transcription errors silently.
- Output the English translation only — no Chinese, no quotes, no commentary, no prefix.`

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
  key: string,
  instructions: string,
  debugLabel: string
): Promise<string> {
  log("openai POST ·", debugLabel, "· raw len=", rawText.length)
  const t0 = Date.now()
  // Stage 5b — 读用户配置的超时（默认 20s，预设 10/20/30/60，可配 5-120s）。
  // 超时后 fetch Promise reject，调用者（stopAndTranscribe 的 catch）会写
  // error + errorKind="polish"，**不清 rawText**，键盘 done-consume 的
  // finalText > rawText > error 优先级自然降级到未润色原文。
  const timeoutSec = readPolishTimeoutSec()
  log("openai timeout=", timeoutSec, "s")
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
      instructions,
      reasoning: { effort: "none" },
      max_output_tokens: 1024,
    }),
    timeout: timeoutSec,
    debugLabel,
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

// Stage 5a — 调试回放。点 ▶ 从头播放当前 filePath 指向的 m4a。
//
// 设计选择：每次点 ▶ 都调 `stop()` 重置到开头（而非从暂停处继续）。用户
// 心智：▶ = 重新播一遍。这样在 ⏸ 之后再点 ▶ 行为稳定，不会出现"上次播
// 到哪里了"的歧义。如果未来要"从暂停处继续"可以加独立 `▶▶ 继续` 按钮。
//
// Singleton：`debugPlayer` 在模块级 `let`。首次调用时 lazy 创建 + 绑 onError
// / onEnded 两个 log 回调；之后的调用复用同一实例，只换 source。不 dispose。
function debugPlayback(path: string): void {
  if (debugPlayer === null) {
    debugPlayer = new AVPlayer()
    debugPlayer.onError = (m) => logErr("debug player:", m)
    debugPlayer.onEnded = () => log("debug player ended")
  }
  debugPlayer.stop()
  const ok = debugPlayer.setSource(path)
  if (!ok) {
    logErr("debug player setSource failed:", path)
    return
  }
  const played = debugPlayer.play()
  if (!played) logErr("debug player play() returned false")
}

function debugPlaybackPause(): void {
  if (debugPlayer !== null) debugPlayer.pause()
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
  //
  // Stage 4.5b：audio session / BackgroundKeeper / Live Activity 也都留着
  //   ——  所有的 session teardown 决策延后到 handleCycleEnd 里基于 warmUntil
  //   判断。这样 warm 窗口还活着时一次录音完就自然回 warm，不会因为中间
  //   teardown 了 session 而要再冷启动。
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
  await throttledActivityUpdate({ status: "transcribing" })
  log("state=transcribing")

  // ---- 以下各终点都要走同一条尾路：
  //        writeState("done") + doneStateSetAt = now + update activity。
  //      worker tick 会检测到 done（并给 keyboard 消费窗口）后调用
  //      handleCycleEnd，后者决定是回 warm 还是 stopWarmSession。
  //      record / setup 级错误由 handleCycleEnd 自己识别 errKind 做 hard teardown。

  // Setup 级错误：路径丢失 / key 缺失 —— 会话还没真正能进行，都标
  // errorKind="setup"，handleCycleEnd 会走 hard teardown 分支。
  if (path === null) {
    log("stopAndTranscribe: path missing")
    writeError("录音文件路径丢失")
    writeErrorKind("setup")
    writeState("done")
    doneStateSetAt = Date.now()
    await throttledActivityUpdate({
      status: "error",
      errorLabel: "准备失败",
    })
    return
  }
  const key = readScribeKey()
  if (key === null || key.length === 0) {
    log("stopAndTranscribe: scribe key missing")
    writeError("缺少 ElevenLabs key")
    writeErrorKind("setup")
    writeState("done")
    doneStateSetAt = Date.now()
    await throttledActivityUpdate({
      status: "error",
      errorLabel: "准备失败",
    })
    return
  }

  let rawText: string
  try {
    rawText = await transcribeWithScribe(path, key)
    writeRawText(rawText)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    logErr("transcribe failed:", msg)
    writeError(msg)
    writeErrorKind("stt")
    writeState("done")
    doneStateSetAt = Date.now()
    await throttledActivityUpdate({
      status: "error",
      errorLabel: "转录失败",
    })
    return
  }

  // 3. polish / translate phase — 由 inputMode 决定走哪条路径：
  //    dictation   → 跳过 polish，键盘 rawText fallback 直接插入原文
  //    auto        → 现有 polish prompt（标点矫正 + 口语清洗）
  //    translation → 同样调 OpenAI，但 prompt 换成「中译英」
  const openaiKey = readOpenAIKey()
  const inputMode = readInputMode()
  log("inputMode=", inputMode)

  if (inputMode === "dictation") {
    log("inputMode=dictation · skipping polish · state=done with rawText")
    writeState("done")
    doneStateSetAt = Date.now()
    return
  }

  if (openaiKey === null || openaiKey.length === 0) {
    log("no OpenAI key · skipping polish · state=done with rawText")
    writeState("done")
    doneStateSetAt = Date.now()
    return
  }

  const isTranslate = inputMode === "translation"
  const instructions = isTranslate ? TRANSLATE_INSTRUCTIONS : POLISH_INSTRUCTIONS
  const debugLabel = isTranslate ? "openai.translate" : "openai.polish"
  const errorLabel = isTranslate ? "翻译失败" : "润色失败"

  writeState("polishing")
  await throttledActivityUpdate({ status: "polishing" })
  log("state=polishing · mode=", inputMode)
  try {
    const polished = await polishWithOpenAI(
      rawText,
      openaiKey,
      instructions,
      debugLabel
    )
    writeFinalText(polished)
    writeState("done")
    doneStateSetAt = Date.now()
    log("polish ok · state=done · keyboard will consume finalText")
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    logErr("polish failed:", msg)
    // rawText 留在 storage — 键盘优先级是 finalText > rawText > errorPlaceholder，
    // 所以润色失败时用户仍然会看到未润色的原文插入，而不是错误占位。
    writeError(msg)
    writeErrorKind("polish")
    writeState("done")
    doneStateSetAt = Date.now()
    await throttledActivityUpdate({
      status: "error",
      errorLabel,
    })
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
  // Stage 4.5b：也要拆掉 warm 相关资源。顺序与 stopWarmSession 一致。
  if (warmSilentKeeper !== null) {
    try {
      warmSilentKeeper.stop()
    } catch {}
    try {
      warmSilentKeeper.dispose()
    } catch {}
    warmSilentKeeper = null
  }
  if (warmActivity !== null) {
    try {
      await warmActivity.end(
        { status: "warm", remainingSec: 0 },
        { dismissTimeInterval: 0 }
      )
    } catch {}
    warmActivity = null
  }
  try {
    await BackgroundKeeper.stopKeepAlive()
  } catch {}
  try {
    await SharedAudioSession.setActive(false)
  } catch {}
  sessionActive = false
  workerCancelled = true
  doneStateSetAt = 0
  cycleEndInFlight = false
  lastActivityUpdateAt = 0
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
  // Stage 5.1：err 和 errorKind 配对清掉。原代码只清了 errorKind 漏了 err，
  // 依赖 MainView 按钮 action 里的 `clearError()` 补救；不健壮。
  clearError()
  clearErrorKind()
  clearSttMs()
  clearPolishMs()
  // Stage 4.5b：warm 会话标记归零。
  clearWarmUntil()
  // 注意：**不清 warmDurationMs**。"清除状态"重置的是 session 运行时状态，
  // 不是用户配置。时长偏好持久化，用户下次激活时 duration picker 回显。
  writeState("idle")
}

function scheduleWorker(): void {
  if (workerCancelled) return
  workerTick().finally(() => {
    if (workerCancelled) return
    setTimeout(scheduleWorker, 400)
  })
}

// Worker tick：每 400ms 跑一次。4.5b 之后不只看 action，还要做状态机的
// 周期性检查（warmUntil 过期、armed elapsed 更新、done 到 warm/idle 的
// 推进、warm 窗口里的 silent keeper watchdog）。
async function workerTick(): Promise<void> {
  writeHeartbeat()
  const action = readAction()
  const state = readState()

  // ---- 1. Action handling ------------------------------------------------
  if (action === "stop") {
    clearAction()
    log("worker · stop · state=", state)
    if (state === "armed") {
      await stopAndTranscribe()
      return
    }
    log("stop ignored · state not armed")
    return
  }
  if (action === "arm") {
    clearAction()
    log("worker · arm · state=", state)
    if (state === "warm") {
      await armFromWarm()
      return
    }
    log("arm ignored · state not warm")
    return
  }
  if (action !== null) {
    log("worker · unknown action, clearing:", action)
    clearAction()
  }

  // ---- 2. Periodic state maintenance ------------------------------------
  // 2a. warm：warmUntil 过期 → stopWarmSession；否则刷新 LA remainingSec；
  //           v2 watchdog：keeper 不变式违反 → 直接 abort（不尝试恢复）。
  if (state === "warm") {
    const warmUntil = readWarmUntil()
    const now = Date.now()
    if (warmUntil !== null && now >= warmUntil) {
      log("worker · warm expired · warmUntil=", warmUntil)
      await stopWarmSession("warmUntil expired")
      return
    }
    // v2 watchdog：warm 窗口里 keeper 必须一直在录。如果这个不变式被违反
    // （iOS 杀了 keeper / 硬件回收 / 内存压力），不要尝试 restart —— v1 已经
    // 证明"stop 过的 session recording 重启几乎必然失败"。直接 abort + teardown。
    // 这是 v2 与 v1 最核心的分歧：承认失败而不是假装能恢复。
    if (warmSilentKeeper === null || !warmSilentKeeper.isRecording) {
      logErr(
        "worker · warm · keeper invariant violated (keeper=",
        warmSilentKeeper === null ? "null" : "exists",
        "isRecording=",
        warmSilentKeeper?.isRecording,
        "); aborting warm"
      )
      writeError("保持静音 keeper 意外中断")
      writeErrorKind("record")
      await stopWarmSession("keeper watchdog invariant violation")
      return
    }
    // LA 刷新 remainingSec（节流 1s）
    if (warmUntil !== null) {
      const remainingSec = Math.max(
        0,
        Math.floor((warmUntil - now) / 1000)
      )
      await throttledActivityUpdate({ status: "warm", remainingSec })
    }
    return
  }

  // 2b. armed：LA 刷新 elapsedSec（节流 1s）。
  if (state === "armed") {
    const startedAt = readSessionStartedAt()
    if (startedAt !== null) {
      const elapsedSec = (Date.now() - startedAt) / 1000
      await throttledActivityUpdate({ status: "armed", elapsedSec })
    }
    return
  }

  // 2c. done：等 keyboard 消费（rawText/finalText 清空）或者 3s 超时兜底，
  //           然后调 handleCycleEnd 把 session 推向 warm 或 idle。
  //           至少等 1s 给 keyboard 400ms poll 跑两轮。
  if (state === "done") {
    if (doneStateSetAt === 0) {
      // 异常：state=done 但没记录何时进入的 —— 旧 session 残留？补记账并
      // 让下一轮正常走。
      doneStateSetAt = Date.now()
      return
    }
    const sinceDone = Date.now() - doneStateSetAt
    if (sinceDone < 1000) return // 给 keyboard 消费窗口

    const rawText = readRawText()
    const finalText = readFinalText()
    const consumed = rawText === null && finalText === null
    const timedOut = sinceDone > 3000

    if (consumed || timedOut) {
      log(
        "worker · done → cycle end · consumed=",
        consumed,
        "timedOut=",
        timedOut,
        "sinceDone=",
        sinceDone
      )
      await handleCycleEnd()
    }
    return
  }
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

// ---------------------------------------------------------------------------
// Stage 4.5a — 保活机制四组合实测
//
// 不改现有 `startSession` / `stopAndTranscribe` 等状态机路径，仅新增一组
// 独立的 "experiment" 入口：A1 / A2 / A3 / A4 分别对应四种保活组合，每组
// 跑 5 分钟，期间 400ms 写一次 heartbeat，结束后读 heartbeat 首尾时间判
// 断实际存活时长。
//
// 结果用于决定 4.5b 采用方案 C′（裸 keepAlive + LA 够用）还是方案 A
// （必须额外加静音录音 keeper）。
// ---------------------------------------------------------------------------

type ExperimentId = "A1" | "A2" | "A3" | "A4"
type ExperimentCause = "timer" | "cancel" | "error"

type ExperimentResult = {
  startedAt: number
  endedAt: number
  firstHeartbeatAt: number
  lastHeartbeatAt: number
  cause: ExperimentCause
}

const EXPERIMENT_DURATION_MS = 5 * 60 * 1000
const EXPERIMENT_TICK_MS = 400

let silentKeeper: AudioRecorder | null = null
let expRunning: ExperimentId | null = null
let expStartedAt = 0
let expEndAt = 0
let expFirstHeartbeatAt = 0
let expLastHeartbeatAt = 0
let expActivity: LiveActivity<VBActivityState> | null = null
let expCancelled = false
const expResults: Partial<Record<ExperimentId, ExperimentResult>> = {}

async function teardownExperiment(): Promise<void> {
  if (silentKeeper !== null) {
    try {
      silentKeeper.stop()
    } catch (e) {
      logErr("exp: silentKeeper.stop:", String(e))
    }
    try {
      silentKeeper.dispose()
    } catch (e) {
      logErr("exp: silentKeeper.dispose:", String(e))
    }
    silentKeeper = null
  }
  if (expActivity !== null) {
    try {
      await expActivity.end(
        {
          status: "ended",
          remainingSec: 0,
          label: expRunning ?? undefined,
        },
        { dismissTimeInterval: 0 }
      )
      log("exp: activity.end OK (immediate dismiss)")
    } catch (e) {
      logErr("exp: activity.end:", String(e))
    }
    expActivity = null
  }
  try {
    await BackgroundKeeper.stopKeepAlive()
    log("exp: stopKeepAlive OK")
  } catch (e) {
    logErr("exp: stopKeepAlive:", String(e))
  }
  try {
    await SharedAudioSession.setActive(false)
    log("exp: setActive(false) OK")
  } catch (e) {
    logErr("exp: setActive(false):", String(e))
  }
}

async function startSilentKeeperForExperiment(id: ExperimentId): Promise<boolean> {
  try {
    const dir = await ensureRecordingsDir()
    const path = Path.join(dir, "warm_keeper.m4a")
    log(`4.5a-${id}: silentKeeper path=`, path)
    const r = await AudioRecorder.create(path, {
      format: "MPEG4AAC",
      sampleRate: 22050,
      numberOfChannels: 1,
      encoderAudioQuality: AVAudioQuality.low,
    })
    r.onError = (m: string) =>
      logErr(`4.5a-${id}: silentKeeper.onError:`, m)
    r.onFinish = (ok: boolean) =>
      log(`4.5a-${id}: silentKeeper.onFinish ok=`, ok)
    const ok = r.record()
    log(`4.5a-${id}: silentKeeper.record()=`, ok, "isRecording=", r.isRecording)
    if (!ok) {
      try {
        r.dispose()
      } catch {}
      return false
    }
    silentKeeper = r
    return true
  } catch (e) {
    logErr(`4.5a-${id}: silentKeeper create/record failed:`, String(e))
    return false
  }
}

async function runExperiment(id: ExperimentId): Promise<void> {
  if (expRunning !== null) {
    log(`4.5a-${id}: another experiment (${expRunning}) is running; bail`)
    return
  }
  if (sessionActive) {
    log(`4.5a-${id}: main session active; bail`)
    return
  }

  const startedAt = Date.now()
  const endAt = startedAt + EXPERIMENT_DURATION_MS

  expRunning = id
  expStartedAt = startedAt
  expEndAt = endAt
  expFirstHeartbeatAt = 0
  expLastHeartbeatAt = 0
  expCancelled = false
  delete expResults[id]

  log(
    `---- 4.5a-${id} START · duration ${EXPERIMENT_DURATION_MS / 1000}s ` +
      `· endAt=${endAt} ----`
  )

  try {
    // 所有实验都共用这部分
    await configureAudioSession()
    await BackgroundKeeper.keepAlive()
    log(`4.5a-${id}: keepAlive OK`)

    // A2 / A4：带 Live Activity
    if (id === "A2" || id === "A4") {
      try {
        const activity = VoiceboardWarmActivity()
        const ok = await activity.start({
          status: `exp-${id}`,
          remainingSec: Math.floor(EXPERIMENT_DURATION_MS / 1000),
          label: id,
        })
        log(`4.5a-${id}: activity.start =>`, ok)
        expActivity = activity
      } catch (e) {
        logErr(`4.5a-${id}: activity.start failed:`, String(e))
        // 带 LA 的实验启动不了 LA 就不能继续 —— 否则跑的其实是 A1/A3
        expRunning = null
        await teardownExperiment()
        expResults[id] = {
          startedAt,
          endedAt: Date.now(),
          firstHeartbeatAt: 0,
          lastHeartbeatAt: 0,
          cause: "error",
        }
        return
      }
    }

    // A3 / A4：带静音 keeper recorder
    if (id === "A3" || id === "A4") {
      const ok = await startSilentKeeperForExperiment(id)
      if (!ok) {
        expRunning = null
        await teardownExperiment()
        expResults[id] = {
          startedAt,
          endedAt: Date.now(),
          firstHeartbeatAt: 0,
          lastHeartbeatAt: 0,
          cause: "error",
        }
        return
      }
    }

    scheduleExperimentTick(id)
  } catch (e) {
    logErr(`4.5a-${id}: setup failed:`, String(e))
    expRunning = null
    await teardownExperiment()
    expResults[id] = {
      startedAt,
      endedAt: Date.now(),
      firstHeartbeatAt: 0,
      lastHeartbeatAt: 0,
      cause: "error",
    }
  }
}

function scheduleExperimentTick(id: ExperimentId): void {
  if (expCancelled || expRunning !== id) return
  setTimeout(() => {
    experimentTick(id)
  }, EXPERIMENT_TICK_MS)
}

async function experimentTick(id: ExperimentId): Promise<void> {
  if (expCancelled || expRunning !== id) return
  const now = Date.now()

  // iOS 把 Scripting 挂起时 setTimeout 暂停；app 恢复时首个 tick 会带一个
  // 巨大的 gap（>> 400ms）。检测到就把"真实存活"标记在上一次 heartbeat
  // 处收尾 —— 否则 lastHeartbeatAt 会被恢复后的新 heartbeat 覆盖，把"存活
  // 时长"夸大到包含了整个挂起时间。
  const gap = expLastHeartbeatAt > 0 ? now - expLastHeartbeatAt : 0
  if (gap > 2000) {
    log(
      `4.5a-${id}: suspension detected · gap=${gap}ms · ` +
        `freezing lastHeartbeat at ${expLastHeartbeatAt} and ending`
    )
    await finishExperiment(id, "timer")
    return
  }

  // heartbeat —— 同时给主 UI 的 "heartbeat Xs ago" 显示用
  writeHeartbeat()
  if (expFirstHeartbeatAt === 0) expFirstHeartbeatAt = now
  expLastHeartbeatAt = now

  // 每 ~1s log 一次，降低日志噪声；所有 tick 都参与 heartbeat
  const elapsedMs = now - expStartedAt
  if (elapsedMs % 1000 < EXPERIMENT_TICK_MS) {
    log(
      `4.5a-${id}: tick · elapsed=${(elapsedMs / 1000).toFixed(1)}s ` +
        `· remaining=${((expEndAt - now) / 1000).toFixed(1)}s`
    )
  }

  // Live Activity update（只有 A2/A4 有 activity）—— 节流到 ~1s/次
  if (expActivity !== null && elapsedMs % 1000 < EXPERIMENT_TICK_MS) {
    const remaining = Math.max(0, Math.floor((expEndAt - now) / 1000))
    try {
      await expActivity.update({
        status: `exp-${id}`,
        remainingSec: remaining,
        label: id,
      })
    } catch (e) {
      logErr(`4.5a-${id}: activity.update failed:`, String(e))
    }
  }

  if (now >= expEndAt) {
    log(`4.5a-${id}: timer expired`)
    await finishExperiment(id, "timer")
    return
  }

  scheduleExperimentTick(id)
}

async function finishExperiment(
  id: ExperimentId,
  cause: ExperimentCause
): Promise<void> {
  const endedAt = Date.now()
  expResults[id] = {
    startedAt: expStartedAt,
    endedAt,
    firstHeartbeatAt: expFirstHeartbeatAt,
    lastHeartbeatAt: expLastHeartbeatAt,
    cause,
  }
  const durS = ((endedAt - expStartedAt) / 1000).toFixed(1)
  const hbS =
    expFirstHeartbeatAt > 0
      ? ((expLastHeartbeatAt - expFirstHeartbeatAt) / 1000).toFixed(1)
      : "—"
  log(
    `---- 4.5a-${id} END · cause=${cause} · wallDur=${durS}s ` +
      `· heartbeatDur=${hbS}s ----`
  )
  expRunning = null
  await teardownExperiment()
}

async function cancelExperiment(): Promise<void> {
  if (expRunning === null) return
  const id = expRunning
  expCancelled = true
  await finishExperiment(id, "cancel")
}

// Script.onResume 路径验证：已存活实例通过 `scripting://run/...` 触发时
// 会进这里，且不会重跑入口文件（reference/llms-full.md:29303-29311）。
// Stage 4.5b 的键盘 warm fast-path 就依赖这个特性。
let onResumeRemover: (() => void) | null = null

function registerOnResumeListener(): void {
  if (onResumeRemover !== null) return
  try {
    onResumeRemover = Script.onResume((details) => {
      log("onResume fired · details=", JSON.stringify(details))
      const q = details.queryParameters
      if (q && q.probe === "1") {
        log(
          "onResume · probe=1 detected · 既有实例仍存活，没有重跑入口"
        )
      }
    })
    log("Script.onResume listener registered")
  } catch (e) {
    logErr("Script.onResume register failed:", String(e))
  }
}

// Stage 6a Phase C — 键盘布局调参面板配置。
// 每项 = [存储键, 中文用户口径标签, 最小值, 最大值, 默认值]
// 用词规则（用户友好口径，不用 padding/spacing 等行话）：
//   空隙   = 元素与容器之间的内边距（原 padding）
//   距离   = 两个元素之间的间距（原 spacing）
//   移动   = 位置偏移（原 offset，+/- 表示右下/左上）
//   宽度/高度/大小 = 尺寸直白说
// 默认值必须与 keyboard.tsx 里 readTune(...) 的 def 对齐；
// 新加条目时两边同步。
const TUNE_SECTIONS: Array<{
  title: string
  params: Array<[string, string, number, number, number]>
}> = [
  {
    title: "键盘整体",
    params: [
      ["kbd.height",       "键盘高度",        180, 400, 199],
      ["outer.padH",       "左右空隙",          0,  40,  12],
      ["outer.padTop",     "顶部空隙",          0,  40,  10],
      ["outer.padBottom",  "底部空隙",          0,  40,  10],
      ["outer.rowSpacing", "三行上下距离",       0,  30,  10],
    ],
  },
  {
    title: "顶行布局",
    params: [
      ["top.rowSpacing",     "三元素左右距离",     0, 24, 8],
      ["top.tagMainSubGap",  "状态标签主副文字距离", 0,  8, 1],
    ],
  },
  {
    title: "状态标签（左上）",
    params: [
      ["tag.iconSize",     "图标大小",         8,  24, 12],
      ["tag.textSize",     "主文字大小",       9,  20, 12],
      ["tag.subTextSize",  "副文字大小",       8,  16, 11],
      ["tag.innerSpacing", "图标文字距离",     0,  12,  4],
      ["tag.offsetX",      "左右移动",       -60,  60,  9],
      ["tag.offsetY",      "上下移动",       -20,  20,  0],
    ],
  },
  {
    title: "右上时码",
    params: [
      ["mono.textSize", "字体大小",    9,  20, 14],
      ["mono.offsetX",  "左右移动",  -60,  60, -9],
      ["mono.offsetY",  "上下移动",  -20,  20,  0],
    ],
  },
  {
    title: "模式条（口述/自动/翻译）",
    params: [
      ["pill.width",        "宽度",         120, 340, 178],
      ["pill.containerPad", "外框空隙",       0,  12,   3],
      ["pill.segSpacing",   "三段距离",       0,  10,   2],
      ["pill.segHPad",      "段左右空隙",     4,  24,  11],
      ["pill.segVPad",      "段上下空隙",     0,  12,   4],
      ["pill.segTextSize",  "文字大小",       9,  20,  12],
      ["pill.offsetX",      "左右移动",    -100, 100,   0],
      ["pill.offsetY",      "上下移动",     -20,  20,   0],
    ],
  },
  {
    title: "主胶囊麦克风",
    params: [
      ["mic.minWidth",    "宽度",         140, 320, 167],
      ["mic.height",      "高度",          40,  80,  59],
      ["mic.padH",        "左右空隙",      10,  40,  26],
      ["mic.iconTextGap", "图标文字距离",   4,  24,  10],
      ["mic.iconSize",    "图标大小",      12,  40,  20],
      ["mic.textSize",    "文字大小",      12,  24,  17],
      ["mic.offsetX",     "左右移动",     -80,  80,   0],
      ["mic.offsetY",     "上下移动",     -40,  40,   0],
    ],
  },
  // ---------- Stage 6b v4.2 · 灵动岛（Dynamic Island）3 节 ----------
  //
  // v4.2 真机二次反馈：主文案从 Center region 移到 Trailing region，
  // 因为 Center 居中会挤占 Leading 图标视觉位置。Trailing wrap 到 pill
  // 下方右半，自然"下方中心偏右"。新增 offsetX/Y 让用户微调文案位置。
  //
  // 视觉参数热调，键名前缀 `di.*`，`live_activity.tsx` builder 每次 iOS update
  // 重读 Storage → 改参数 ≤1s（受 LA 1000ms 节流）生效。
  // LockScreenContent 留给 Step 3，本节不暴露其参数。
  {
    title: "灵动岛 · 紧凑态 + 最小",
    params: [
      ["di.cl.iconSize",   "紧凑左 图标大小",      10, 22, 14],
      ["di.cl.textSize",   "紧凑左 时码大小",      10, 18, 12],
      ["di.cl.innerGap",   "紧凑左 图标文字距离",   0, 12,  4],
      ["di.cl.padH",       "紧凑左 左右空隙",       0, 20,  6],
      ["di.cl.padV",       "紧凑左 上下空隙",       0, 16,  2],
      ["di.min.iconSize",  "最小态 图标大小",      10, 24, 16],
    ],
  },
  {
    title: "灵动岛 · 展开左（VOICEBOARD + 图标）",
    params: [
      ["di.el.iconSize",     "图标 大小",            14, 80,   56],
      ["di.el.brandIconGap", "品牌字↔图标 距离",      0, 16,    4],
      ["di.brand.textSize",  "VOICEBOARD 字号",       8, 18,   11],
      ["di.el.offsetX",      "左右移动",           -120,120,   17],
      ["di.el.offsetY",      "上下移动",            -80, 80,    0],
    ],
  },
  {
    title: "灵动岛 · 展开右（主文案 · 首字左对齐）",
    params: [
      ["di.et.headlineSize", "主文字 大小",          12, 24,   19],
      ["di.et.captionSize",  "副文字 大小",           9, 18,   13],
      ["di.et.rowSpacing",   "主副文字 距离",         0, 10,    3],
      ["di.et.offsetX",      "左右移动",           -180,120, -154],
      ["di.et.offsetY",      "上下移动",            -80, 80,   -2],
    ],
  },
]

// Stage 6a Phase C — 布尔开关（Toggle）配置。独立于 TUNE_SECTIONS，因为
// 滑杆/开关两类控件的 schema 不同（滑杆需 min/max/def，开关只需 def）。
// 每项 = [存储键, 中文标签, 默认值]。默认值必须与 keyboard.tsx 里
// readTuneBool(key, def) 的 def 对齐（系统 API 默认都是 true）。
const TUNE_BOOL_SECTIONS: Array<{
  title: string
  params: Array<[string, string, boolean]>
}> = [
  {
    title: "系统键盘层（iOS 原生）",
    params: [
      ["kbd.hasDictation",   "显示系统麦克风键",    true],
      ["kbd.toolbarVisible", "显示键盘顶部工具栏",  false],
    ],
  },
  // ---------- Stage 6b v4.1 · 灵动岛 · 显隐开关 ----------
  // brandVisible: Leading 顶部 "VOICEBOARD" 品牌字 显隐
  // (v4.1 去掉 cards.visible: 真机上圆角半透白卡片不渲染，已回到裸布局)
  {
    title: "灵动岛 · 显隐开关",
    params: [
      ["di.brand.visible",  "显示 VOICEBOARD 品牌字",  true],
    ],
  },
]

// 调参面板里的一根滑杆 + 即时数值显示。value 双向绑定到 Storage 的 tune key。
// 拖拽时本地 setState 即时 UI 响应；onChanged 同时写 Storage，键盘下一轮 poll 生效。
function TuneSlider({
  keyName,
  label,
  min,
  max,
  def,
}: {
  keyName: string
  label: string
  min: number
  max: number
  def: number
}) {
  const [val, setVal] = useState<number>(() => readTune(keyName, def))
  return (
    <VStack alignment="leading" spacing={2}>
      <HStack spacing={8}>
        <Text font="footnote">{label}</Text>
        <Spacer />
        <Text
          font="footnote"
          monospacedDigit
          foregroundStyle={val === def ? "secondaryLabel" : "systemBlue"}
        >
          {val}
          {val !== def ? ` · 默认 ${def}` : ""}
        </Text>
      </HStack>
      <Slider
        value={val}
        min={min}
        max={max}
        step={1}
        onChanged={(v) => {
          const rounded = Math.round(v)
          if (rounded === val) return
          setVal(rounded)
          writeTune(keyName, rounded)
        }}
      />
    </VStack>
  )
}

// Stage 6a Phase C — 布尔 tune 开关。与 TuneSlider 并列，不同点：
// 存储是 boolean（走 readTuneBool / writeTuneBool），控件是 iOS 原生 Toggle。
// 状态切到 true/false 立即写 Storage，键盘 useEffect 同步后调 CustomKeyboard.* 生效。
function TuneToggle({
  keyName,
  label,
  def,
}: {
  keyName: string
  label: string
  def: boolean
}) {
  const [val, setVal] = useState<boolean>(() => readTuneBool(keyName, def))
  return (
    <Toggle
      title={label}
      value={val}
      onChanged={(v) => {
        setVal(v)
        writeTuneBool(keyName, v)
      }}
    />
  )
}

function MainView() {
  const dismiss = Navigation.useDismiss()
  const [tick, setTick] = useState(0)
  const [bgActive, setBgActive] = useState<boolean | null>(null)
  // Stage 6a — 调参面板重置计数。点「重置全部」会 +1，所有 TuneSlider
  // 的 key 带上这个 suffix 从而强制 unmount/remount，重读 Storage 的新值。
  const [tuneResetCounter, setTuneResetCounter] = useState(0)
  const [scribeKeyDraft, setScribeKeyDraft] = useState<string>(
    readScribeKey() ?? ""
  )
  const [openAIKeyDraft, setOpenAIKeyDraft] = useState<string>(
    readOpenAIKey() ?? ""
  )
  // Stage 4.5b — duration picker 当前选择。默认 3 min；若用户之前用过
  // 其他档位就读回 warmDurationMs 作为初值（组件 mount 时一次性）。
  const [warmPickMinutes, setWarmPickMinutes] = useState<number>(() => {
    const prev = readWarmDurationMs()
    if (prev !== null && prev > 0) return Math.round(prev / 60000)
    return 3
  })
  // Stage 5b — polish timeout picker 当前选择（秒）。readPolishTimeoutSec
  // 对脏数据 / 未设置过自动 fallback 到默认 20s，拿回来就是合法值。
  const [polishTimeoutPick, setPolishTimeoutPick] = useState<number>(() =>
    readPolishTimeoutSec()
  )

  useEffect(() => {
    const q = Script.queryParameters ?? {}
    log("mount · queryParameters=", JSON.stringify(q))

    // L1-style 卡死防御（Stage 4 的 hygiene 教训在 v2 cold-start 路径的 recurrence 修复）：
    // 任何走到 MainView mount 的路径 —— 无论是用户从主 app 打开、键盘 tap
    // 触发的 run_single cold-start、还是 run + onResume —— 都必然意味着
    // "keyboard 侧可能刚写过的 activeTree=T_tap.ID 已经作废了"（tapping tree
    // 马上或已经被 iOS 在 VC 切换时销毁）。**如果这个 T_tap.ID 滞留在 Storage
    // 里，且新实例进入 armed/warm 的 ~300ms 里 iOS 又重建了 keyboard VC，
    // 新树 T_new2 会读到 activeTree=T_tap.ID（不是自己）+ state 还来得及
    // 更新成 idle → L3 shouldFast 判 false → 5s slow poll → 用户感知"卡死"**。
    //
    // 修法：mount 就无条件清 activeTree，把窗口从 ~300ms 缩到 0ms。
    // startWarmSession / startSession 内部在 await 前也各自再清一次（belt+suspenders）。
    clearActiveTree()

    // Stage 4.5b — 新实例启动时的陈旧 warm 状态清理。
    //
    // 场景：iOS 杀掉 warm 中的 Scripting（内存压力 / 用户上划）→ Storage
    // 里 state=warm / warmUntil=未来 / activeTree=某个死掉的 TREE_ID 全部
    // 残留。此时 sessionActive 是模块级 let 初值 false，即我们在内存里
    // 没有任何 warm 上下文（warmSilentKeeper / warmActivity 都 null）。
    //
    // 如果不清理，UI 会显示"保持中，剩余 XX:XX"但麦克风根本不通；键盘
    // tap 会走 warm fast-path（openURL run），但因为实例其实是新的、
    // 入口会被重跑、startSession 会被调（因为 queryParameters.action=arm），
    // 场面很乱。
    //
    // 策略：mount 时若 sessionActive=false（新实例）且 Storage 说 warm，
    // 直接清掉 warm 残留 + state=idle。让用户（或 coldStartArmed）重新激活。
    // 注：coldStartArmed 读的是 warmDurationMs（用户持久化偏好），此处**不清**。
    if (!sessionActive) {
      const staleState = readState()
      const staleWarmUntil = readWarmUntil()
      if (staleState !== "idle" || staleWarmUntil !== null) {
        log(
          "mount · stale session signals from prior instance, clearing: state=",
          staleState,
          "warmUntil=",
          staleWarmUntil
        )
        clearAction()
        // activeTree 上面已经清了，这里不重复
        clearWarmUntil()
        // 注意：**不清 warmDurationMs**。用户在主 app 配置的时长是持久化偏好，
        // 跨重启 / 清理 / run_single 重建实例都要保留。duration picker 的
        // useState 初值会读它回填，coldStartArmed 也会读它作为激活时长。
        // rawText/finalText 若还有待消费的内容先留着 —— 如果此时键盘
        // 其实还在目标 app 里准备 consume done，别把 payload 剪了。
        // startSession 路径会在 arm 时清，这里不动。
        clearSessionStartedAt()
        clearSessionEndedAt()
        writeState("idle")
      }
    }

    if (q.action === "arm") {
      // v2.4.5 Issue #1 修复：URL scheme cold-start 不再走老 startSession
      // （只到 armed、无保持），改走 coldStartArmed —— startWarmSession 先
      // 把 warm 全套拉起来（keeper + LA + warmUntil + keepAlive）再
      // armFromWarm 直接进入 armed。录完一次 cycle 后 handleCycleEnd 会
      // 自然回到 warm，等用户下一次 tap。
      // 这样"从键盘激活"和"从主 app 点激活保持"就等价了，用户的 warmDurationMs
      // 偏好在两条路径里一致生效。
      log("auto-arm from URL scheme → coldStartArmed")
      coldStartArmed()
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
  const warmUntil = readWarmUntil()
  const warmDurationMs = readWarmDurationMs()
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
  // Stage 4.5b — warm 剩余秒数 / mm:ss 显示
  const warmRemainingSec =
    warmUntil !== null ? Math.max(0, Math.floor((warmUntil - now) / 1000)) : 0
  const warmRemainingMMSS = (() => {
    const s = warmRemainingSec
    const m = Math.floor(s / 60)
    const ss = s % 60
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
    return `${pad(m)}:${pad(ss)}`
  })()

  const onEnd = async () => {
    await resetToIdle()
    dismiss()
    Script.exit()
  }

  const statusLabel =
    state === "warm"
      ? `warm · 保持中 · 剩余 ${warmRemainingMMSS}`
      : state === "armed" && recordingSec !== null
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
      : state === "warm"
      ? "systemBlue"
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

          {/* Stage 5b — polish 超时预设选择。脚本默认 20s，用户可按网络
               情况调大调小。点按钮即写 Storage + 刷新本地 state；下一次
               polish fetch 会读到新值。 */}
          <VStack spacing={4} alignment="leading">
            <Text font="caption" foregroundStyle="secondaryLabel">
              润色超时（polish timeout）· 当前 {polishTimeoutPick}s
            </Text>
            <HStack spacing={6}>
              {[10, 20, 30, 60].map((sec) => (
                <Button
                  key={`polish-to-${sec}`}
                  title={
                    polishTimeoutPick === sec ? `✓ ${sec}s` : `${sec}s`
                  }
                  action={() => {
                    writePolishTimeoutSec(sec)
                    setPolishTimeoutPick(sec)
                    setTick((t) => t + 1)
                  }}
                />
              ))}
              <Spacer />
            </HStack>
            <Text font="footnote" foregroundStyle="secondaryLabel">
              网速慢 / 海外 / 蜂窝网络建议 30s+；超时后会降级插入未润色原文。
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

          {/* ---------------------------------------------------------------
               Stage 4.5b — 保持麦克风（warm 会话面板）
               idle: 显示 duration picker + 激活按钮
               warm: 显示倒计时 + 提前结束
               其他态（armed/transcribing/polishing/done）：隐藏，不占位
             --------------------------------------------------------------- */}
          {state === "idle" || state === "warm" ? (
            <VStack spacing={8} alignment="leading">
              <Text font="caption" foregroundStyle="secondaryLabel">
                保持麦克风
              </Text>
              {state === "idle" ? (
                <VStack spacing={6} alignment="leading">
                  <Text font="footnote" foregroundStyle="secondaryLabel">
                    激活后 Scripting 会在后台保持麦克风就绪；在选定时长内，
                    你在任意 App 点键盘的录音按钮都可以直接录音。
                  </Text>
                  <HStack spacing={6}>
                    {[1, 3, 5, 15, 30, 60].map((m) => (
                      <Button
                        key={`warm-pick-${m}`}
                        title={
                          warmPickMinutes === m
                            ? `✓ ${m}min`
                            : `${m}min`
                        }
                        action={() => {
                          setWarmPickMinutes(m)
                          setTick((t) => t + 1)
                        }}
                      />
                    ))}
                  </HStack>
                  <Button
                    title={`🔊 激活保持 ${warmPickMinutes} min`}
                    action={async () => {
                      const ok = await startWarmSession(
                        warmPickMinutes * 60 * 1000
                      )
                      log("startWarmSession tap result:", ok)
                      setTick((t) => t + 1)
                    }}
                  />
                </VStack>
              ) : (
                <VStack spacing={6} alignment="leading">
                  <Text font="title" foregroundStyle="systemBlue">
                    剩余 {warmRemainingMMSS}
                  </Text>
                  <Text font="footnote" foregroundStyle="secondaryLabel">
                    切到任意 App，点键盘 🎙 录音 即可直接录音；
                    完成后自动回到保持态等待下一次。
                  </Text>
                  <Button
                    title="✕ 提前结束"
                    action={async () => {
                      await stopWarmSession("user early stop")
                      setTick((t) => t + 1)
                    }}
                  />
                </VStack>
              )}
            </VStack>
          ) : null}

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
              {/* Stage 5a — 调试回放。filePath.length===0 是 startWarmSession
                   置空的情况（warm 还没录过），按钮隐藏避免空播。 */}
              {filePath.length > 0 ? (
                <HStack spacing={8}>
                  <Button
                    title="▶ 播放"
                    action={() => debugPlayback(filePath)}
                  />
                  <Button title="⏸ 暂停" action={debugPlaybackPause} />
                  <Spacer />
                </HStack>
              ) : null}
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

          <VStack spacing={6} alignment="leading">
            <Text font="caption" foregroundStyle="secondaryLabel">
              4.5a 实验 · 保活机制实测（不影响正常录音链路）
            </Text>
            {(["A1", "A2", "A3", "A4"] as ExperimentId[]).map((id) => {
              const r = expResults[id]
              const label =
                id === "A1"
                  ? "A1 · 裸 keepAlive"
                  : id === "A2"
                  ? "A2 · keepAlive + Live Activity"
                  : id === "A3"
                  ? "A3 · keepAlive + 静音录音"
                  : "A4 · keepAlive + LA + 静音录音（官方组合）"
              const result =
                r === undefined
                  ? "—"
                  : r.firstHeartbeatAt === 0
                  ? `error at ${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s`
                  : `存活 ${(
                      (r.lastHeartbeatAt - r.firstHeartbeatAt) /
                      1000
                    ).toFixed(1)}s · ${r.cause}`
              return (
                <Text
                  key={id}
                  font="footnote"
                  foregroundStyle="systemBlue"
                >
                  {label}: {result}
                </Text>
              )
            })}
            {expRunning !== null ? (
              <Text font="footnote" foregroundStyle="orange">
                {expRunning} 运行中 · 剩余{" "}
                {Math.max(
                  0,
                  Math.floor((expEndAt - Date.now()) / 1000)
                )}
                s · 首 heartbeat 后持续{" "}
                {expFirstHeartbeatAt > 0
                  ? (
                      (Date.now() - expFirstHeartbeatAt) /
                      1000
                    ).toFixed(1)
                  : "—"}
                s
              </Text>
            ) : null}
            <Button
              title="A1 · 裸 keepAlive"
              action={() => {
                if (expRunning !== null || sessionActive) {
                  log("A1 tap ignored · busy")
                  return
                }
                runExperiment("A1")
                setTick((t) => t + 1)
              }}
            />
            <Button
              title="A2 · keepAlive + Live Activity"
              action={() => {
                if (expRunning !== null || sessionActive) {
                  log("A2 tap ignored · busy")
                  return
                }
                runExperiment("A2")
                setTick((t) => t + 1)
              }}
            />
            <Button
              title="A3 · keepAlive + 静音录音"
              action={() => {
                if (expRunning !== null || sessionActive) {
                  log("A3 tap ignored · busy")
                  return
                }
                runExperiment("A3")
                setTick((t) => t + 1)
              }}
            />
            <Button
              title="A4 · keepAlive + LA + 静音录音（官方组合）"
              action={() => {
                if (expRunning !== null || sessionActive) {
                  log("A4 tap ignored · busy")
                  return
                }
                runExperiment("A4")
                setTick((t) => t + 1)
              }}
            />
            {expRunning !== null ? (
              <Button
                title="提前结束当前实验"
                action={async () => {
                  await cancelExperiment()
                  setTick((t) => t + 1)
                }}
              />
            ) : null}
            <Text font="footnote" foregroundStyle="secondaryLabel">
              Script.onResume 路径测试：点下方按钮拷贝 URL 到剪贴板，切到备忘录
              粘贴并点击链接，应看到日志新增 "onResume fired"，且**没有**
              "script run · env=" 表示实例没重跑入口文件。
            </Text>
            <Button
              title="拷贝 scripting://run/Voiceboard-V0.1?probe=1"
              action={async () => {
                const url = `scripting://run/${encodeURIComponent(
                  Script.name
                )}?probe=1`
                await Pasteboard.setString(url)
                log("onResume probe URL copied:", url)
                setTick((t) => t + 1)
              }}
            />
          </VStack>

          {/* ---- Stage 6a · 键盘布局调参面板 ----
               拖滑杆实时写 Storage，键盘（在其他 app 打开）≤400ms 内 re-render 生效。
               字段按 5 大区分组；每区相互独立，不需要全量调。 */}
          <VStack spacing={10} alignment="leading">
            <HStack spacing={8}>
              <Text font="caption" foregroundStyle="secondaryLabel">
                键盘布局调参
              </Text>
              <Spacer />
              <Button
                title="重置全部"
                action={() => {
                  TUNE_SECTIONS.forEach((s) => {
                    s.params.forEach(([key, , , , def]) => {
                      writeTune(key, def)
                    })
                  })
                  TUNE_BOOL_SECTIONS.forEach((s) => {
                    s.params.forEach(([key, , def]) => {
                      writeTuneBool(key, def)
                    })
                  })
                  setTuneResetCounter((c) => c + 1)
                  log("tune reset to defaults (sliders + toggles)")
                }}
              />
            </HStack>
            <Text font="caption2" foregroundStyle="secondaryLabel">
              拖动 → 写 Storage → 键盘 ≤400ms 同步生效（回到有键盘的 app 即可看到）。
              带蓝色数值 = 已偏离默认。
            </Text>
            {TUNE_SECTIONS.map((section) => (
              <VStack
                key={section.title}
                spacing={8}
                alignment="leading"
              >
                <Text
                  font="footnote"
                  fontWeight="semibold"
                  foregroundStyle="secondaryLabel"
                >
                  · {section.title}
                </Text>
                {section.params.map(([keyName, label, min, max, def]) => (
                  <TuneSlider
                    key={`${keyName}-${tuneResetCounter}`}
                    keyName={keyName}
                    label={label}
                    min={min}
                    max={max}
                    def={def}
                  />
                ))}
              </VStack>
            ))}
            {TUNE_BOOL_SECTIONS.map((section) => (
              <VStack
                key={section.title}
                spacing={8}
                alignment="leading"
              >
                <Text
                  font="footnote"
                  fontWeight="semibold"
                  foregroundStyle="secondaryLabel"
                >
                  · {section.title}
                </Text>
                {section.params.map(([keyName, label, def]) => (
                  <TuneToggle
                    key={`${keyName}-${tuneResetCounter}`}
                    keyName={keyName}
                    label={label}
                    def={def}
                  />
                ))}
              </VStack>
            ))}
          </VStack>

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
            <Text font="footnote">
              silentKeeper != null = {String(silentKeeper !== null)}
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
  // 在 Navigation.present 之前注册 onResume，这样在 MainView 可见期间
  // 任何 scripting://run/... 触发都能走到 listener，不会丢事件。
  registerOnResumeListener()
  await Navigation.present({ element: <MainView /> })
  log("script exit")
  Script.exit()
}

run()
