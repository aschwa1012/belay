export const PLUGIN_NAME: string
export const FRAME_BUDGET: number
export function byteLength(s: string): number
export function maxTextBytes(name?: string): number
export function capText(text: string, max?: number): string
export type WakeConfig = { role: 'orchestrator'; run_id: string; data_dir: string; belay_cli: string; node: string; orchestrator_dir: string; wake_nonce: string; session_id?: string }
export function activeConfig(jsonText: string): WakeConfig | null
export function streamArgv(c: WakeConfig): string[]
export function deliveredPath(c: WakeConfig): string
export type Parsed = { kind: 'wake'; id: string; text: string } | { kind: 'hb' } | { kind: 'ignore' }
export function parseLine(line: string): Parsed
export function parseDelivered(fileText: string): Set<string>
export function errorsPath(c: WakeConfig): string
export type DeliveryIo = { write(file: string, content: string): Promise<unknown>; submit(text: string): Promise<unknown>; log(entry: { at: number; id: string; stage: 'write' | 'submit' | 'held' | 'released'; held?: boolean; error?: string }): void; bound?(): Promise<boolean> }
export function isMissing(e: unknown): boolean
export function isUnboundSubmit(message: unknown): boolean
export const HELD_RETRY_MS: number
export function heldNotice(n: number, why?: 'unbound' | 'other-session'): string
export function releasedNotice(n: number): string
export function readDelivered(o: { read(): Promise<unknown>; sleep(ms: number): Promise<void>; tries?: number; delayMs?: number }): Promise<string | null>
export function createDelivery(o: { file: string; initial?: string; io: DeliveryIo; now?: () => number; cap?: (t: string) => string }): { delivered: Set<string>; pending: Map<string, string>; held: Set<string>; unrecorded: Set<string>; readonly heldWhy: 'unbound' | 'other-session' | null; takeReleased(): number; retryPending(): Promise<number>; deliver(id: string, text: string): Promise<'skip' | 'held' | 'submit-failed' | 'submitted'> }
export function deliveredLine(id: string, at: number): string
export function lineSplitter(): (chunk: string) => string[]
export function decide(parsed: Parsed, delivered: Set<string>): 'submit' | 'skip' | 'none'
