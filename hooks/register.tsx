/**
 * Hands Off — keep your agent from writing to repos, deploys and databases that are not yours: read yes, write no.
 *
 * One guardrail (tool.call) on Bash, Edit, Write and NotebookEdit, and another on the MCP tools (`mcp__…`) that name a
 * protected Neon or Supabase project (projectId / project_id). Silent when all is well: it denies only on a positive
 * match (the repo's `origin` remote is in the list in ~/.claude/hands-off.json and the command has the shape of a
 * write) and lets the call through on any error of its own (fail-open, with one notice).
 *
 * The override is human and one-time: `/handsoff pass [owner/repo]` typed by a person (terminal, desktop app through
 * the SDK, or phone), or the "One-time pass" button of the panel. It covers the next blocked call on that target within
 * the following 10 minutes. A plugin or the model cannot give itself a pass (the panel's buttons are only pressed by a
 * person).
 *
 * `/handsoff` opens the panel: what is protected, active passes, this session's blocks and the list management.
 * In Spanish sessions the same command is also registered as `/intocables`, and `pase` / `estado` work as verbs.
 *
 * The pure rules live in ./rules.ts and the words in ./i18n.ts; this file is only the wiring and everything that
 * touches the disk.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ConfigView, Pass } from '../types'
import { pickLang, words, type Lang, type Words } from './i18n'
import {
  DEFAULT_CONFIG,
  HUMAN_ORIGINS,
  PASS_TTL_MS,
  ago,
  checkBash,
  checkMcp,
  checkPath,
  cleanSlug,
  defaultConfigText,
  denyText,
  dirname,
  editConfig,
  isLive,
  migrateConfig,
  minutesLeft,
  parseConfig,
  spendPasses,
  type Config,
  type ConfigEdit,
  type Deps,
  type Hit,
} from './rules'

const passes = atom({ plugin: 'hands-off', key: 'passes' } as const, [])
const lastDenied = atom({ plugin: 'hands-off', key: 'lastDenied' } as const, null)
const history = atom({ plugin: 'hands-off', key: 'history' } as const, [])
const view = atom({ plugin: 'hands-off', key: 'view' } as const, null)
const expanded = atom({ plugin: 'hands-off', key: 'expanded' } as const, null)
const confirm = atom({ plugin: 'hands-off', key: 'confirm' } as const, null)
const note = atom({ plugin: 'hands-off', key: 'note' } as const, null)
const tick = atom({ plugin: 'hands-off', key: 'tick' } as const, 0)

const PANE = 'hands-off'
const HISTORY_MAX = 30
/** Time cap for the analysis: if git or the disk hang, the call goes through (fail-open). */
const BUDGET_MS = 9000
const CACHE_TTL_MS = 15_000

// ── language ────────────────────────────────────────────────────────────────

let lang: Lang = 'en'
let langKnown = false

/** Claude Code's `language` setting, then LC_ALL/LANG; English by default. Looked up at session.start. */
async function detectLang($: EngineInterface): Promise<Lang> {
  const settings = (await $.settings.read().catch(() => ({}))) as { language?: unknown }
  const locale = (await $.env.get('LC_ALL').catch(() => null)) || (await $.env.get('LANG').catch(() => null)) || null
  lang = pickLang(undefined, settings.language, locale)
  langKnown = true
  return lang
}

/** The words in the session's language (looks the language up once if session.start has not yet). */
async function wordsOf($: EngineInterface): Promise<Words> {
  if (!langKnown) await detectLang($).catch(() => undefined)
  return words(lang)
}

// ── config and disk ─────────────────────────────────────────────────────────

async function homeOf($: EngineInterface) {
  return (await $.env.get('HOME')) ?? ''
}

const configPath = (home: string) => `${home}/.claude/hands-off.json`
/** The previous version's list: imported once when there is no hands-off.json yet (and left untouched). */
const legacyPath = (home: string) => `${home}/.claude/intocables.json`

let badConfigWarned = false
let lastViewJson = ''

/** Copies the list to the state the panel reads, only when it changed (so it does not redraw on every call). */
async function syncView($: EngineInterface, config: Config, isDefault: boolean) {
  const next: ConfigView = { ...config, isDefault }
  const json = JSON.stringify(next)
  if (json === lastViewJson) return
  lastViewJson = json
  await update($, view, () => next)
}

/**
 * Reads ~/.claude/hands-off.json. If it does not exist it is created: from the previous version's
 * ~/.claude/intocables.json when that exists (read only), else with empty lists. Never throws.
 */
/** The last list read whole: a file broken later never leaves you unprotected (kept across sessions in the store). */
let lastGood: Config | null = null
let lastGoodJson = ''

async function rememberGood($: EngineInterface, config: Config) {
  const json = JSON.stringify(config)
  if (json === lastGoodJson) return
  lastGood = config
  lastGoodJson = json
  await $.store.set('lastGoodConfig', config).catch(() => undefined)
}

async function fallbackConfig($: EngineInterface): Promise<Config> {
  if (lastGood) return lastGood
  const stored = parseConfig(JSON.stringify((await $.store.get('lastGoodConfig').catch(() => undefined)) ?? null))
  return stored ?? DEFAULT_CONFIG
}

async function loadConfig($: EngineInterface, home: string): Promise<Config> {
  if (!home) return DEFAULT_CONFIG
  const path = configPath(home)
  try {
    if (!(await $.fs.exists(path))) {
      let text = defaultConfigText()
      let config = DEFAULT_CONFIG
      const old = legacyPath(home)
      if (await $.fs.exists(old).catch(() => false)) {
        const migrated = migrateConfig(await $.fs.read(old).catch(() => ''))
        if (migrated) {
          text = migrated.text
          config = migrated.config
        } else {
          $.ui.toast((await wordsOf($)).legacyUnreadable)
        }
      }
      let written = true
      await $.fs.write(path, text).catch(() => {
        written = false
      })
      await syncView($, config, !written).catch(() => undefined)
      await rememberGood($, config)
      return config
    }
    const parsed = parseConfig(await $.fs.read(path))
    if (parsed) {
      await syncView($, parsed, false).catch(() => undefined)
      await rememberGood($, parsed)
      return parsed
    }
  } catch {
    // falls back to the empty list
  }
  if (!badConfigWarned) {
    badConfigWarned = true
    $.ui.toast((await wordsOf($)).configUnreadable)
  }
  const fallback = await fallbackConfig($)
  await syncView($, fallback, true).catch(() => undefined)
  return fallback
}

async function git($: EngineInterface, dir: string, args: string[]) {
  try {
    const run = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: 5000 })
    return run.exitCode === 0 ? run.stdout.trim() : ''
  } catch {
    return ''
  }
}

// Module caches (a reload empties them): they only save git calls. Short-lived, because a remote can change.
const originCache = new Map<string, { at: number; url: string }>()

/** Real directory that contains `path`: the nearest existing ancestor, with symlinks resolved. */
async function containingDir($: EngineInterface, path: string) {
  let at = path
  for (let i = 0; i < 40 && at !== '/' && !(await $.fs.exists(at).catch(() => false)); i++) at = dirname(at)
  const st = await $.fs.stat(at, { resolve: true }).catch(() => null)
  if (!st) return at
  const real = st.realPath ?? at
  return st.kind === 'dir' ? real : dirname(real)
}

async function originOfPath($: EngineInterface, path: string) {
  const dir = await containingDir($, path)
  const now = await $.clock.now()
  const cached = originCache.get(dir)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.url
  const url = await git($, dir, ['remote', 'get-url', 'origin'])
  originCache.set(dir, { at: now, url })
  return url
}

/** Railway project linked to the directory, from ~/.railway/config.json (no network): the nearest link going up. */
async function railwayLinked($: EngineInterface, home: string, dir: string) {
  try {
    const text = await $.fs.read(`${home}/.railway/config.json`)
    const projects = (JSON.parse(text) as { projects?: Record<string, { name?: string }> }).projects ?? {}
    let at = dir
    for (let i = 0; i < 40; i++) {
      const name = projects[at]?.name
      if (name) return name
      if (at === '/') break
      at = dirname(at)
    }
  } catch {
    // no Railway config: no known link
  }
  return ''
}

/** Vercel project linked to the directory: the nearest `.vercel/project.json` going up. */
async function vercelLinked($: EngineInterface, dir: string) {
  let at = dir
  for (let i = 0; i < 40; i++) {
    const file = `${at === '/' ? '' : at}/.vercel/project.json`
    if (await $.fs.exists(file).catch(() => false)) {
      try {
        const json = JSON.parse(await $.fs.read(file)) as { projectName?: unknown; projectId?: unknown }
        return {
          name: typeof json.projectName === 'string' ? json.projectName : '',
          id: typeof json.projectId === 'string' ? json.projectId : '',
        }
      } catch {
        return { name: '', id: '' }
      }
    }
    if (at === '/') break
    at = dirname(at)
  }
  return { name: '', id: '' }
}

/** Neon project id of a context file (`.neon`, JSON with `projectId`); '' if it cannot be read. */
async function readNeonContext($: EngineInterface, file: string) {
  try {
    const json = JSON.parse(await $.fs.read(file)) as { projectId?: unknown }
    return typeof json.projectId === 'string' ? json.projectId.trim() : ''
  } catch {
    return ''
  }
}

/** Neon project `dir` points to: the nearest `.neon` going up, or only `file` (--context-file). */
async function neonContext($: EngineInterface, dir: string, file?: string) {
  if (file) return (await $.fs.exists(file).catch(() => false)) ? readNeonContext($, file) : ''
  let at = dir
  for (let i = 0; i < 40; i++) {
    const candidate = `${at === '/' ? '' : at}/.neon`
    if (await $.fs.exists(candidate).catch(() => false)) return readNeonContext($, candidate)
    if (at === '/') break
    at = dirname(at)
  }
  return ''
}

/** Linked Supabase project ref: the nearest `supabase/.temp/project-ref` going up (or only in `dir` with `exact`, from --workdir). */
async function supabaseLinked($: EngineInterface, dir: string, exact = false) {
  let at = dir
  for (let i = 0; i < 40; i++) {
    const file = `${at === '/' ? '' : at}/supabase/.temp/project-ref`
    if (await $.fs.exists(file).catch(() => false)) return (await $.fs.read(file).catch(() => '')).trim()
    if (exact || at === '/') break
    at = dirname(at)
  }
  return ''
}

async function depsFor($: EngineInterface): Promise<Deps> {
  const home = await homeOf($)
  const config = await loadConfig($, home)
  return {
    cwd: await $.session.cwd(),
    home,
    config,
    words: await wordsOf($),
    originOf: path => originOfPath($, path),
    remoteUrl: async (dir, name) => git($, await containingDir($, dir), ['remote', 'get-url', name]),
    railwayLinked: dir => railwayLinked($, home, dir),
    vercelLinked: dir => vercelLinked($, dir),
    neonContext: (dir, file) => neonContext($, dir, file),
    supabaseLinked: (dir, exact) => supabaseLinked($, dir, exact),
  }
}

// ── fail-open ───────────────────────────────────────────────────────────────

let failWarned = false

async function failOpen($: EngineInterface, error: unknown) {
  if (failWarned) return
  failWarned = true
  const why = error instanceof Error ? error.message : String(error)
  $.ui.toast((await wordsOf($)).ruleFailed(why.slice(0, 80)))
}

async function withBudget<T>($: EngineInterface, work: Promise<T>): Promise<T> {
  let timer: { cancel: () => void } | undefined
  const w = await wordsOf($)
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(BUDGET_MS, () => reject(new Error(w.tookTooLong)))
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    timer?.cancel()
  }
}

// ── passes and blocks ────────────────────────────────────────────────────────

async function remember($: EngineInterface, hits: Hit[], now: number, passed: boolean) {
  const entry = { keys: hits.map(h => h.key), labels: hits.map(h => h.label), detail: hits[0]!.detail, at: now, passed }
  await update($, history, list => [...list, entry].slice(-HISTORY_MAX))
}

/** Lets the call through if a person gave a pass for ALL the targets of the block (it is spent); otherwise denies with the reason. */
async function gate($: EngineInterface, hits: Hit[]) {
  const w = await wordsOf($)
  const keys = hits.map(h => h.key)
  const now = await $.clock.now()
  let ok = false
  await update($, passes, list => {
    const spent = spendPasses(list, keys, now)
    ok = spent.ok
    return spent.left
  })
  await remember($, hits, now, ok).catch(() => undefined)
  if (ok) {
    $.ui.toast(w.passUsed(hits.map(h => h.label).join(', ')))
    return null
  }
  await update($, lastDenied, () => ({ keys, labels: hits.map(h => h.label), at: now }))
  $.ui.toast(w.blockedToast(hits[0]!.detail, hits.map(h => h.label).join(', ')))
  return { deny: denyText(hits, w) }
}

let ticking = false

/** While there are live passes, the panel redraws every 30 s (countdown and expiry). */
function keepTicking($: EngineInterface) {
  if (ticking) return
  ticking = true
  const step = () => {
    $.clock.after(30_000, () => {
      void (async () => {
        const now = await $.clock.now()
        const live = (await read($, passes)).filter(p => isLive(p, now))
        await update($, tick, n => n + 1)
        if (live.length > 0) step()
        else ticking = false
      })().catch(() => {
        ticking = false
      })
    })
  }
  step()
}

async function grant($: EngineInterface, hits: { key: string; label: string }[]) {
  const now = await $.clock.now()
  const fresh: Pass[] = hits.map(h => ({ key: h.key, label: h.label, at: now }))
  await update($, passes, list => [...list.filter(p => isLive(p, now) && !hits.some(h => h.key === p.key)), ...fresh])
  keepTicking($)
}

async function revoke($: EngineInterface, key: string) {
  await update($, passes, list => list.filter(p => p.key !== key))
}

const repoKey = (slug: string) => slug.toLowerCase()
const railwayKey = (name: string) => `railway:${name.toLowerCase()}`
const vercelKey = (name: string) => `vercel:${name.toLowerCase()}`
const neonKey = (id: string) => `neon:${id.toLowerCase()}`
const supabaseKey = (ref: string) => `supabase:${ref.toLowerCase()}`

async function statusText($: EngineInterface) {
  const w = await wordsOf($)
  const config = await loadConfig($, await homeOf($))
  const now = await $.clock.now()
  const live = (await read($, passes)).filter(p => isLive(p, now))
  const nothing = !(config.repos.length || config.railwayProjects.length || config.vercelProjects.length || config.neonProjects.length || config.supabaseProjects.length)
  const lines = [
    w.statusIntro,
    nothing ? w.statusNothing : '',
    config.repos.length ? w.statusRepos(config.repos.length, config.repos.join(', ')) : '',
    config.railwayProjects.length ? w.statusProjects(w.kind.railway, config.railwayProjects.join(', ')) : '',
    config.vercelProjects.length ? w.statusProjects(w.kind.vercel, config.vercelProjects.join(', ')) : '',
    config.neonProjects.length ? w.statusProjects(w.kind.neon, config.neonProjects.join(', ')) : '',
    config.supabaseProjects.length ? w.statusProjects(w.kind.supabase, config.supabaseProjects.join(', ')) : '',
    live.length ? w.statusPasses(live.map(p => w.statusMinutes(p.label, minutesLeft(p, now))).join(', ')) : w.statusNoPasses,
    w.statusFooter,
  ]
  return lines.filter(Boolean).join('\n')
}

// ── list management (panel) ─────────────────────────────────────────────────

async function say($: EngineInterface, text: string, isError = false) {
  await update($, note, () => ({ text, isError }))
}

/** Applies a change to ~/.claude/hands-off.json without overwriting anything else; an unreadable file is left alone. */
async function applyEdit($: EngineInterface, edit: ConfigEdit, suffix = '') {
  const w = await wordsOf($)
  const home = await homeOf($)
  if (!home) return say($, w.noHome, true)
  const path = configPath(home)
  try {
    const text = (await $.fs.exists(path)) ? await $.fs.read(path) : null
    const out = editConfig(text, edit, w)
    if ('error' in out) return say($, w.nothingChanged(out.error), true)
    await $.fs.write(path, out.text)
    await syncView($, out.config, false)
    await update($, confirm, () => null)
    return say($, `${out.changed}${suffix}.`)
  } catch (error) {
    return say($, w.writeFailed(error instanceof Error ? error.message : String(error)), true)
  }
}

/** Adds a repo; if `gh` confirms it, its spelling is used, otherwise it is added anyway with a warning (it may be a typo). */
async function addRepo($: EngineInterface, input: string) {
  const w = await wordsOf($)
  const slug = cleanSlug(input)
  if (!slug) return say($, w.notRepoInput(input.trim()), true)
  let canonical = ''
  try {
    const run = await $.process.run(['gh', 'repo', 'view', slug, '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { timeoutMs: 8000 })
    if (run.exitCode === 0) canonical = cleanSlug(run.stdout) ?? ''
  } catch {
    // no gh or no network: it is added as typed
  }
  return applyEdit($, { op: 'addRepo', slug: canonical || slug }, canonical ? w.verified : w.unverified)
}

/** Opens the panel; true when a surface shows it now (then the command leaves no text in the conversation). */
async function openPane($: EngineInterface) {
  await loadConfig($, await homeOf($)).catch(() => undefined)
  await update($, note, () => null)
  const opened = await $.ui.open({ id: PANE, title: (await wordsOf($)).brand, closeOnEscape: true })
  return opened.isPlaced
}

// ── commands ────────────────────────────────────────────────────────────────

/**
 * `/handsoff` (and `/intocables` in Spanish sessions). No verb → the panel, and text only where no panel shows, so a
 * click on Open leaves nothing in the conversation. `status` / `estado` → always the summary as text.
 * `pass` / `pase` [target] → a one-time pass (only a person, from the prompt).
 */
async function runCommand($: EngineInterface, e: { args?: string; origin: { kind: string } }): Promise<{ text?: string }> {
  const [rawVerb, slug] = (e.args ?? '').trim().split(/\s+/)
  const verb = rawVerb?.toLowerCase()
  if (verb === 'status' || verb === 'estado') return { text: await statusText($) }
  if (verb !== 'pass' && verb !== 'pase') {
    const shown = await openPane($).catch(() => false)
    return shown ? {} : { text: await statusText($) }
  }
  const w = await wordsOf($)
  if (!HUMAN_ORIGINS.has(e.origin.kind)) return { text: w.onlyHuman }

  const config = await loadConfig($, await homeOf($))
  const now = await $.clock.now()
  if (slug) {
    const wanted = slug.toLowerCase()
    const named = (prefix: string, name: string) => `${prefix}:${name.toLowerCase()}` === wanted || name.toLowerCase() === wanted
    const found: { key: string; label: string } | undefined =
      config.repos.filter(r => r.toLowerCase() === wanted).map(r => ({ key: repoKey(r), label: r }))[0] ??
      config.railwayProjects.filter(r => named('railway', r)).map(r => ({ key: railwayKey(r), label: `Railway ${r}` }))[0] ??
      config.vercelProjects.filter(r => named('vercel', r)).map(r => ({ key: vercelKey(r), label: `Vercel ${r}` }))[0] ??
      config.neonProjects.filter(r => named('neon', r)).map(r => ({ key: neonKey(r), label: `Neon ${r}` }))[0] ??
      config.supabaseProjects.filter(r => named('supabase', r)).map(r => ({ key: supabaseKey(r), label: `Supabase ${r}` }))[0]
    if (!found) {
      const all = [
        ...config.repos,
        ...config.railwayProjects.map(r => `Railway ${r}`),
        ...config.vercelProjects.map(r => `Vercel ${r}`),
        ...config.neonProjects.map(r => `Neon ${r}`),
        ...config.supabaseProjects.map(r => `Supabase ${r}`),
      ]
      return { text: w.notProtected(slug, all.length ? all.join(', ') : w.none) }
    }
    await grant($, [found])
    return { text: w.passGranted(found.label) }
  }
  const last = await read($, lastDenied)
  if (!last || now - last.at > PASS_TTL_MS) return { text: w.noRecentBlock }
  await grant($, last.keys.map((key, i) => ({ key, label: last.labels[i] ?? key })))
  await update($, lastDenied, () => null)
  return { text: w.passGrantedLast(last.labels.join(', ')) }
}

// ── registration ────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    lastViewJson = ''
    const l = await detectLang($)
    const w = words(l)
    await $.command.register({ name: 'handsoff', description: w.commandDescription, argumentHint: w.argumentHint })
    // Spanish sessions also get the original name.
    if (l === 'es') await $.command.register({ name: 'intocables', description: w.commandDescription, argumentHint: w.argumentHint })
    await loadConfig($, await homeOf($)).catch(() => undefined)
    return next(e)
  })

  // /clear: new conversation, no passes, blocks or pending notices.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, passes, () => [])
      await update($, lastDenied, () => null)
      await update($, history, () => [])
      await update($, note, () => null)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let hits: Hit[] = []
    try {
      const deps = await depsFor($)
      hits = await withBudget($, checkBash(e.command, deps))
    } catch (error) {
      await failOpen($, error)
      return next(e)
    }
    if (hits.length > 0) {
      const denied = await gate($, hits)
      if (denied) return denied
    }
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    let hits: Hit[] = []
    try {
      const deps = await depsFor($)
      hits = await withBudget($, checkPath(e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path, deps))
    } catch (error) {
      await failOpen($, error)
      return next(e)
    }
    if (hits.length > 0) {
      const denied = await gate($, hits)
      if (denied) return denied
    }
    return next(e)
  })

  // MCP tools (Neon, Supabase…): only the ones that name a protected project and do not read. The rest goes through
  // at once (a single name comparison), without touching the disk.
  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith('mcp__')) return next(e)
    let hits: Hit[] = []
    try {
      const config = await withBudget($, homeOf($).then(home => loadConfig($, home)))
      hits = checkMcp(e.tool, e as unknown as Record<string, unknown>, config)
    } catch (error) {
      await failOpen($, error)
      return next(e)
    }
    if (hits.length > 0) {
      const denied = await gate($, hits)
      if (denied) return denied
    }
    return next(e)
  })

  // /handsoff (and /intocables in Spanish sessions) → panel · status · pass.
  on('command.run', { command: 'handsoff' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'intocables' }, ($, e) => runCommand($, e))

  // The panel: what is protected, passes, this session's blocks and the list management. Its buttons are only pressed by
  // a person (the model has no way to), so passes and changes from here are a person's.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input
    const w = await wordsOf($)
    await read($, tick)
    const cfg = (await read($, view)) ?? { ...DEFAULT_CONFIG, isDefault: true }
    const now = await $.clock.now()
    const live = (await read($, passes)).filter(p => isLive(p, now))
    const blocks = await read($, history)
    const open = await read($, expanded)
    const pending = await read($, confirm)
    const msg = await read($, note)
    const last = await read($, lastDenied)
    const denied = blocks.filter(b => !b.passed)

    type Row = { id: string; key: string; label: string; owner: string; remove: ConfigEdit }
    const rows: Row[] = [
      ...cfg.repos.map((slug, i) => ({ id: `repo-${i}`, key: repoKey(slug), label: slug, owner: w.kind.github, remove: { op: 'removeRepo', slug } as ConfigEdit })),
      ...cfg.railwayProjects.map((name, i) => ({ id: `rail-${i}`, key: railwayKey(name), label: `Railway ${name}`, owner: w.kind.railway, remove: { op: 'removeRailway', name } as ConfigEdit })),
      ...cfg.vercelProjects.map((name, i) => ({ id: `vercel-${i}`, key: vercelKey(name), label: `Vercel ${name}`, owner: w.kind.vercel, remove: { op: 'removeVercel', name } as ConfigEdit })),
      ...cfg.neonProjects.map((id, i) => ({ id: `neon-${i}`, key: neonKey(id), label: `Neon ${id}`, owner: w.kind.neon, remove: { op: 'removeNeon', id } as ConfigEdit })),
      ...cfg.supabaseProjects.map((ref, i) => ({ id: `supabase-${i}`, key: supabaseKey(ref), label: `Supabase ${ref}`, owner: w.kind.supabase, remove: { op: 'removeSupabase', ref } as ConfigEdit })),
    ]

    const card = (r: Row) => {
      const pass = live.find(p => p.key === r.key)
      const mine = denied.filter(b => b.keys.includes(r.key))
      const lastHit = mine[mine.length - 1]
      const isOpen = open === r.id
      return (
        <Box
          key={`card-${r.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={pass ? 'warning' : 'promptBorder'}
          paddingX={1}
          marginBottom={1}
          overflow="hidden"
        >
          <Box justifyContent="space-between" alignItems="center" gap={1} minWidth={0}>
            <Box gap={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text color="claude">🔒</Text>
              <Text bold wrap="truncate-end">{r.label}</Text>
              <Text dimColor>{r.owner}</Text>
            </Box>
            {pass ? <Text color="warning" bold>{w.passTag(minutesLeft(pass, now))}</Text> : <Text color="success">{w.protectedTag}</Text>}
          </Box>
          <Text dimColor wrap="wrap">
            {mine.length === 0 ? w.noBlocksYet : w.blockSummary(mine.length, ago(now - lastHit!.at, w), lastHit!.detail)}
          </Text>
          <Box gap={1} marginTop={1} flexWrap="wrap">
            {pass ? (
              <Button key={`${r.id}-revoke`} label={w.revoke} onPress={() => void revoke($, r.key)} />
            ) : (
              <Button key={`${r.id}-pass`} label={w.onePass} onPress={() => void grant($, [{ key: r.key, label: r.label }])} />
            )}
            <Button
              key={`${r.id}-more`}
              dimColor
              label={isOpen ? w.less : w.manage}
              onPress={() => void update($, expanded, x => (x === r.id ? null : r.id)).then(() => update($, confirm, () => null))}
            />
          </Box>
          {isOpen && (
            <Box gap={1} marginTop={1} flexWrap="wrap">
              {pending === r.id ? (
                <Button key={`${r.id}-remove`} variant="primary" label={w.confirmRemove(r.label)} onPress={() => void applyEdit($, r.remove).then(() => revoke($, r.key))} />
              ) : (
                <Button key={`${r.id}-remove`} dimColor label={w.removeFromList} onPress={() => void update($, confirm, () => r.id)} />
              )}
            </Box>
          )}
          {isOpen && pending === r.id && <Text color="warning" wrap="wrap">{w.removeWarning}</Text>}
        </Box>
      )
    }

    const recent = blocks.slice(-8).reverse()

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`🛡 ${w.brand} · ${w.tagline}`}</Text>
          <Text dimColor wrap="wrap">
            {w.summary({ repos: cfg.repos.length, railway: cfg.railwayProjects.length, vercel: cfg.vercelProjects.length, neon: cfg.neonProjects.length, supabase: cfg.supabaseProjects.length, live: live.length, denied: denied.length })}
          </Text>
          {cfg.isDefault && <Text color="warning" wrap="wrap">{w.defaultListWarning}</Text>}
        </Box>

        {msg && (
          <Box marginBottom={1}>
            <Text color={msg.isError ? 'error' : 'success'} wrap="wrap">{msg.text}</Text>
          </Box>
        )}

        {last && now - last.at <= PASS_TTL_MS && !live.some(p => last.keys.includes(p.key)) && (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginBottom={1}>
            <Text color="warning" bold wrap="wrap">{w.recentBlock(last.labels.join(', '), ago(now - last.at, w))}</Text>
            <Box gap={1} marginTop={1}>
              <Button
                key="last-pass"
                variant="primary"
                label={w.givePass}
                onPress={() =>
                  void grant($, last.keys.map((key, i) => ({ key, label: last.labels[i] ?? key })))
                    .then(() => update($, lastDenied, () => null))
                    .then(() => say($, w.passGivenNote(last.labels.join(', '))))
                }
              />
            </Box>
          </Box>
        )}

        <Text bold>{w.headingProtected}</Text>
        {rows.length === 0 && <Text dimColor>{w.emptyList}</Text>}
        {rows.map(card)}

        <Text bold>{w.headingAdd}</Text>
        {Input ? (
          <Box flexDirection="column" marginBottom={1}>
            <Input key="add-repo" label={w.inputRepo} placeholder={w.placeholderRepo} submitLabel={w.submit} onSubmit={value => void addRepo($, value)} />
            <Input
              key="add-railway"
              label={w.inputRailway}
              placeholder={w.placeholderRailway}
              submitLabel={w.submit}
              onSubmit={value => void applyEdit($, { op: 'addRailway', name: value })}
            />
            <Input
              key="add-vercel"
              label={w.inputVercel}
              placeholder={w.placeholderVercel}
              submitLabel={w.submit}
              onSubmit={value => void applyEdit($, { op: 'addVercel', name: value })}
            />
            <Input
              key="add-neon"
              label={w.inputNeon}
              placeholder={w.placeholderNeon}
              submitLabel={w.submit}
              onSubmit={value => void applyEdit($, { op: 'addNeon', id: value })}
            />
            <Input
              key="add-supabase"
              label={w.inputSupabase}
              placeholder={w.placeholderSupabase}
              submitLabel={w.submit}
              onSubmit={value => void applyEdit($, { op: 'addSupabase', ref: value })}
            />
          </Box>
        ) : (
          <Box marginBottom={1}>
            <Text dimColor wrap="wrap">{w.mobileNote}</Text>
          </Box>
        )}

        <Text bold>{w.headingActivity}</Text>
        {recent.length === 0 ? (
          <Text dimColor>{w.nothingBlocked}</Text>
        ) : (
          <Box flexDirection="column" marginBottom={1}>
            {recent.map((b, i) => (
              <Text key={`act-${i}`} wrap="truncate-end">
                <Text color={b.passed ? 'warning' : 'error'}>{b.passed ? w.activityPass : w.activityBlock}</Text>
                <Text dimColor>{` ${ago(now - b.at, w)} · `}</Text>
                <Text>{b.labels.join(', ')}</Text>
                <Text dimColor>{` · ${b.detail}`}</Text>
              </Text>
            ))}
          </Box>
        )}

        <Box gap={1} marginTop={1} flexWrap="wrap">
          <Button key="reload" hotkey="r" dimColor label={w.reload} onPress={() => void homeOf($).then(home => loadConfig($, home)).then(() => say($, w.reloaded))} />
          {blocks.length > 0 && <Button key="clear-history" dimColor label={w.clearActivity} onPress={() => void update($, history, () => [])} />}
        </Box>
        <Text dimColor wrap="wrap">{w.footer}</Text>
      </Box>
    )
  })
}
