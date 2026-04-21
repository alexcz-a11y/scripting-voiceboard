import { Path } from "scripting"

export const K_STATE = "vb:state"
export const K_ACTION = "vb:action"
export const K_FILE_PATH = "vb:filePath"
export const K_SESSION_STARTED_AT = "vb:sessionStartedAt"
export const K_SESSION_ENDED_AT = "vb:sessionEndedAt"
export const K_ERROR = "vb:error"
export const K_LAST_HEARTBEAT = "vb:heartbeat"
export const K_LOG = "vb:log"

export const RECORDINGS_SUBDIR = "Voiceboard"

export type VBState = "idle" | "armed" | "done"
export type VBAction = "stop"

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
