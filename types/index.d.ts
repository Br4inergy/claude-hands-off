// State contract of Hands Off: every value the mod keeps in $.state.

/** A pass given by a person: covers the next blocked call on that target, up to 10 minutes after it is given. */
export type Pass = { key: string; label: string; at: number }

/** The last block (so `/handsoff pass` with no arguments knows which target it means). */
export type LastDenied = { keys: string[]; labels: string[]; at: number }

/** A block (or a spent pass) of this session, for the panel. */
export type Block = { keys: string[]; labels: string[]; detail: string; at: number; passed: boolean }

/** The list as the panel shows it (a copy of ~/.claude/hands-off.json). */
export type ConfigView = { repos: string[]; railwayProjects: string[]; vercelProjects: string[]; neonProjects: string[]; supabaseProjects: string[]; isDefault: boolean }

/** Notice in the panel after an action (added, removed, error). */
export type Note = { text: string; isError: boolean }

declare module 'claude-code' {
  interface PluginState {
    'hands-off': {
      passes: Pass[]
      lastDenied: LastDenied | null
      history: Block[]
      view: ConfigView | null
      expanded: string | null
      confirm: string | null
      note: Note | null
      tick: number
    }
  }
}
