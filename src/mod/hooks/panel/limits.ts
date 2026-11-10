// The panel's waits and timeouts (index.tsx and settle.ts use them). Pure values. The refresh periods themselves are refreshEvery in fetch.ts.

export const SETTINGS_EVERY_MS = 10000
export const COMMAND_TIMEOUT_MS = 8000 // the panel's patience under host load (reads of 3.5 to 4.8 s were seen), not a product budget
export const ROUND_TIMEOUT_MS = 25000 // one panel-read runs up to five reads, each bounded at 6 s inside the verb; this bounds the process
// `belay transcript --tail N`: the band reads the last 10 entries (it shows the newest words among them), the pane the last 50. Null would read it all.
export const TRANSCRIPT_TAIL: { band: number | null; pane: number | null } = { band: 10, pane: 50 }
export const MENU_EVERY_MS = 30000 // the Memory menu's facts while only the badge needs them; 10 s while the menu is open
export const MENU_OPEN_EVERY_MS = 10000
export const MEM_TIMEOUT_MS = { set: 20000, delete: 30000, verify: 180000 } as const // a verify hashes the whole model
export const START_TIMEOUT_MS = 40000 // the review launcher waits up to 20 s for the claim; a settle has the same patience
