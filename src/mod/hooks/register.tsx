import type { Register } from 'claude-code'
import { registerPanel } from './panel/index'
import { registerWake } from './wake/index'

// The belay mod: the visual panel (src/mod/hooks/panel/, owned by the panel session) and the interactive
// wake (src/mod/hooks/wake/, ADR 0037 amendment 5). The wake activates only for the orchestrator's session.
export const register: Register = on => {
  registerPanel(on)
  registerWake(on)
}
