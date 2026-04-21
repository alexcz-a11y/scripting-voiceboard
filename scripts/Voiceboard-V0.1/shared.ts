import { Path } from "scripting"

export const K_STATE = "vb:state"
export const K_ACTION = "vb:action"
export const K_FILE_PATH = "vb:filePath"
export const K_SESSION_STARTED_AT = "vb:sessionStartedAt"
export const K_SESSION_ENDED_AT = "vb:sessionEndedAt"
export const K_ERROR = "vb:error"
export const K_LAST_HEARTBEAT = "vb:heartbeat"
export const K_LOG = "vb:log"
export const K_SCRIBE_KEY = "vb:scribeKey"
export const K_OPENAI_KEY = "vb:openAIKey"
export const K_RAW_TEXT = "vb:rawText"
export const K_FINAL_TEXT = "vb:finalText"
export const K_ACTIVE_TREE = "vb:activeTree"
export const K_ERROR_KIND = "vb:errorKind"
export const K_STT_MS = "vb:sttMs"
export const K_POLISH_MS = "vb:polishMs"
// Stage 4.5b — warm 保持态时长。warmUntil 是 ms timestamp，0 或过期（< Date.now()）
// 代表非 warm。warmDurationMs 是用户上一次选的时长，用于激活面板回显。
export const K_WARM_UNTIL = "vb:warmUntil"
export const K_WARM_DURATION_MS = "vb:warmDurationMs"

export const RECORDINGS_SUBDIR = "Voiceboard"
// Stage 4.5b — 静音 keeper 录音文件名。warm 窗口内持续录到这里（覆盖写），
// teardown 时 dispose 即可；暂不做分段轮转（A2/A3 实测 5 min 无挂起，
// 单文件在 60 min 上限下 ~170MB 可接受；真需要轮转等 Stage 5+ 评估）。
export const WARM_KEEPER_FILENAME = "warm_keeper.m4a"

export type VBState =
  | "idle"
  | "warm"
  | "armed"
  | "transcribing"
  | "polishing"
  | "done"
// Stage 4.5b — 键盘 → index 的动作信号集。
//   stop  — 结束当前录音（现有，armed → transcribing 路径）
//   arm   — 热启动：在 warm 态下建 fresh real recorder，让 warm → armed。
//           走这条就说明有 warm session 活着，不要再 cold-start。
export type VBAction = "stop" | "arm"
// Error classification for unified abort() handling:
//   setup  — pre-flight failure (missing key, missing file path, etc.)
//   record — AudioRecorder create / start / mid-recording failure
//   stt    — ElevenLabs Scribe request failure
//   polish — OpenAI Responses request failure (STT already succeeded)
// Keyboard uses this to render the right `[录音失败|转录失败|润色失败: …]` prefix.
export type VBErrorKind = "setup" | "record" | "stt" | "polish"

const opts = { shared: true } as const

export function readState(): VBState {
  return (Storage.get<VBState>(K_STATE, opts) ?? "idle") as VBState
}

export function writeState(s: VBState): void {
  Storage.set(K_STATE, s, opts)
}

export function readAction(): VBAction | null {
  return (Storage.get<VBAction>(K_ACTION, opts) as VBAction | null) ?? null
}

export function writeAction(a: VBAction): void {
  Storage.set(K_ACTION, a, opts)
}

export function clearAction(): void {
  Storage.remove(K_ACTION, opts)
}

export function readFilePath(): string | null {
  return Storage.get<string>(K_FILE_PATH, opts) ?? null
}

export function writeFilePath(p: string): void {
  Storage.set(K_FILE_PATH, p, opts)
}

export function clearFilePath(): void {
  Storage.remove(K_FILE_PATH, opts)
}

export function readSessionStartedAt(): number | null {
  return Storage.get<number>(K_SESSION_STARTED_AT, opts) ?? null
}

export function writeSessionStartedAt(ts: number): void {
  Storage.set(K_SESSION_STARTED_AT, ts, opts)
}

export function clearSessionStartedAt(): void {
  Storage.remove(K_SESSION_STARTED_AT, opts)
}

export function readSessionEndedAt(): number | null {
  return Storage.get<number>(K_SESSION_ENDED_AT, opts) ?? null
}

export function writeSessionEndedAt(ts: number): void {
  Storage.set(K_SESSION_ENDED_AT, ts, opts)
}

export function clearSessionEndedAt(): void {
  Storage.remove(K_SESSION_ENDED_AT, opts)
}

export function writeHeartbeat(): void {
  Storage.set(K_LAST_HEARTBEAT, Date.now(), opts)
}

export function readHeartbeat(): number | null {
  return Storage.get<number>(K_LAST_HEARTBEAT, opts) ?? null
}

export function readError(): string | null {
  return Storage.get<string>(K_ERROR, opts) ?? null
}

export function writeError(msg: string): void {
  Storage.set(K_ERROR, msg, opts)
}

export function clearError(): void {
  Storage.remove(K_ERROR, opts)
}

export function readErrorKind(): VBErrorKind | null {
  return (Storage.get<VBErrorKind>(K_ERROR_KIND, opts) as VBErrorKind | null) ?? null
}

export function writeErrorKind(kind: VBErrorKind): void {
  Storage.set(K_ERROR_KIND, kind, opts)
}

export function clearErrorKind(): void {
  Storage.remove(K_ERROR_KIND, opts)
}

// Per-stage latency, written by index.tsx after each successful HTTP call.
// Preserved across sessions so the main-app debug area can show
// "上次链路耗时: STT Xs · polish Ys" — cleared at the start of the next
// startSession().
export function readSttMs(): number | null {
  return Storage.get<number>(K_STT_MS, opts) ?? null
}

export function writeSttMs(ms: number): void {
  Storage.set(K_STT_MS, ms, opts)
}

export function clearSttMs(): void {
  Storage.remove(K_STT_MS, opts)
}

export function readPolishMs(): number | null {
  return Storage.get<number>(K_POLISH_MS, opts) ?? null
}

export function writePolishMs(ms: number): void {
  Storage.set(K_POLISH_MS, ms, opts)
}

export function clearPolishMs(): void {
  Storage.remove(K_POLISH_MS, opts)
}

// Stage 4.5b — warm 保持态时间戳。
//   readWarmUntil() > Date.now()  → warm 还在窗口内
//   readWarmUntil() === null or < Date.now() → 非 warm / 过期
// 键盘 fast-path 判断用这个。index 的 worker tick 每帧也检查过期。
export function readWarmUntil(): number | null {
  return Storage.get<number>(K_WARM_UNTIL, opts) ?? null
}

export function writeWarmUntil(ts: number): void {
  Storage.set(K_WARM_UNTIL, ts, opts)
}

export function clearWarmUntil(): void {
  Storage.remove(K_WARM_UNTIL, opts)
}

// warmDurationMs 是用户上次选的时长（ms）。纯 UI 辅助，用于 MainView
// 激活面板回显"上次选的是 3 min"之类；机制上不参与决策。
export function readWarmDurationMs(): number | null {
  return Storage.get<number>(K_WARM_DURATION_MS, opts) ?? null
}

export function writeWarmDurationMs(ms: number): void {
  Storage.set(K_WARM_DURATION_MS, ms, opts)
}

export function clearWarmDurationMs(): void {
  Storage.remove(K_WARM_DURATION_MS, opts)
}

export function readScribeKey(): string | null {
  return Storage.get<string>(K_SCRIBE_KEY, opts) ?? null
}

export function writeScribeKey(k: string): void {
  Storage.set(K_SCRIBE_KEY, k, opts)
}

export function clearScribeKey(): void {
  Storage.remove(K_SCRIBE_KEY, opts)
}

export function readOpenAIKey(): string | null {
  return Storage.get<string>(K_OPENAI_KEY, opts) ?? null
}

export function writeOpenAIKey(k: string): void {
  Storage.set(K_OPENAI_KEY, k, opts)
}

export function clearOpenAIKey(): void {
  Storage.remove(K_OPENAI_KEY, opts)
}

export function readRawText(): string | null {
  return Storage.get<string>(K_RAW_TEXT, opts) ?? null
}

export function writeRawText(t: string): void {
  Storage.set(K_RAW_TEXT, t, opts)
}

export function clearRawText(): void {
  Storage.remove(K_RAW_TEXT, opts)
}

export function readFinalText(): string | null {
  return Storage.get<string>(K_FINAL_TEXT, opts) ?? null
}

export function writeFinalText(t: string): void {
  Storage.set(K_FINAL_TEXT, t, opts)
}

export function clearFinalText(): void {
  Storage.remove(K_FINAL_TEXT, opts)
}

// Active-tree filter: each keyboard React tree gets a unique id at module
// load. The user's tap on the mic button writes that id here. The done
// consumer only fires for the matching tree, so ghost React trees (from
// hot-reload or iOS view-controller reuse) cannot win the consume race.
export function readActiveTree(): string | null {
  return Storage.get<string>(K_ACTIVE_TREE, opts) ?? null
}

export function writeActiveTree(id: string): void {
  Storage.set(K_ACTIVE_TREE, id, opts)
}

export function clearActiveTree(): void {
  Storage.remove(K_ACTIVE_TREE, opts)
}

export async function ensureRecordingsDir(): Promise<string> {
  const dir = Path.join(
    FileManager.appGroupDocumentsDirectory,
    RECORDINGS_SUBDIR
  )
  const exists = await FileManager.exists(dir)
  if (!exists) {
    await FileManager.createDirectory(dir, true)
  }
  return dir
}

export async function buildRecordingPath(): Promise<string> {
  const dir = await ensureRecordingsDir()
  const ts = Date.now()
  return Path.join(dir, `rec_${ts}.m4a`)
}

// Stage 4.5b — warm 窗口期间的静音 keeper 文件。单文件覆盖写，
// stopWarmSession 时 dispose 即可；不做时间戳命名避免 warm 窗口
// 结束后残留一堆历史文件。
export async function buildWarmKeeperPath(): Promise<string> {
  const dir = await ensureRecordingsDir()
  return Path.join(dir, WARM_KEEPER_FILENAME)
}

export type LogEntry = { ts: number; src: string; msg: string }

const LOG_MAX = 500

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a
      if (a === null || a === undefined) return String(a)
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(" ")
}

function appendLogEntry(src: string, msg: string): void {
  try {
    const existing = (Storage.get<LogEntry[]>(K_LOG, opts) ?? []) as LogEntry[]
    existing.push({ ts: Date.now(), src, msg })
    while (existing.length > LOG_MAX) existing.shift()
    Storage.set(K_LOG, existing, opts)
  } catch {
    // best-effort
  }
}

export function vblog(src: string, ...args: unknown[]): void {
  console.log(`[vb/${src}]`, ...args)
  appendLogEntry(src, formatArgs(args))
}

export function vblogErr(src: string, ...args: unknown[]): void {
  console.error(`[vb/${src}]`, ...args)
  appendLogEntry(`${src}!`, formatArgs(args))
}

export function readLog(): LogEntry[] {
  return (Storage.get<LogEntry[]>(K_LOG, opts) ?? []) as LogEntry[]
}

export function clearLog(): void {
  Storage.remove(K_LOG, opts)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
function pad3(n: number): string {
  if (n < 10) return `00${n}`
  if (n < 100) return `0${n}`
  return String(n)
}

export function formatLog(entries: LogEntry[]): string {
  return entries
    .map((e) => {
      const d = new Date(e.ts)
      const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
        d.getSeconds()
      )}.${pad3(d.getMilliseconds())}`
      return `${t} [${e.src}] ${e.msg}`
    })
    .join("\n")
}
