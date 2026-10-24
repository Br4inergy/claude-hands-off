import type { Words } from './i18n'

/**
 * Pure rules of Hands Off: no `$`, no side effects. The dependencies that touch the disk (a directory's origin,
 * remotes, the linked Railway project) come in as functions, so everything is tested without git or network.
 * Every user-facing string comes from the `Words` the caller passes in (see ./i18n.ts).
 *
 * Idea: a protected repo is recognised by its `origin` remote (never by the folder name). A Bash command is split with
 * a shell lexer (quotes, heredocs, $(...), redirections) and each simple command is analysed by its argv: a slug that
 * only appears inside a commit message or a heredoc is not an argument of any command, so it does not block. The origin
 * is only looked up when the command has the shape of a write.
 */

// ── configuration ───────────────────────────────────────────────────────────

export type Config = {
  /** Protected GitHub slugs (owner/repo). */
  repos: string[]
  /** Protected Railway project names. */
  railwayProjects: string[]
  /** Protected Vercel projects: name or id (`prj_…`). */
  vercelProjects: string[]
  /** Protected Neon projects: id (e.g. `proud-cloud-12345678`). */
  neonProjects: string[]
  /** Protected Supabase projects: project ref (20 lowercase letters). */
  supabaseProjects: string[]
}

/** Nothing is protected until the person adds it. */
export const DEFAULT_CONFIG: Config = {
  repos: [],
  railwayProjects: [],
  vercelProjects: [],
  neonProjects: [],
  supabaseProjects: [],
}

export const CONFIG_NOTE =
  'Hands Off: repos and projects that are not yours (read yes, write no). A repo is matched by its origin remote, not by its folder name. ' +
  'Add GitHub slugs (owner/repo), Railway and Vercel project names, Neon project ids and Supabase project refs to the lists. ' +
  'This file is NOT overwritten when the mod updates.'

export function defaultConfigText() {
  return `${JSON.stringify({ _note: CONFIG_NOTE, ...DEFAULT_CONFIG }, null, 2)}\n`
}

const LIST_KEYS = ['repos', 'railwayProjects', 'vercelProjects', 'neonProjects', 'supabaseProjects'] as const
/** Keys the mod owns in the config file: everything else is the person's and is kept as it is. */
const OWN_KEYS = new Set<string>(['_note', '_nota', ...LIST_KEYS])

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(x => typeof x === 'string') ? v.map(x => (x as string).trim()).filter(Boolean) : null

/**
 * null = invalid JSON or the wrong shape (the caller falls back to the empty list and warns). A missing list is empty;
 * keys it does not know (the note, an old key from a previous version, the person's own) are ignored.
 */
export function parseConfig(text: string): Config | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    const list = (key: (typeof LIST_KEYS)[number]) => (o[key] === undefined ? [] : strings(o[key]))
    const repos = list('repos')
    const railwayProjects = list('railwayProjects')
    const vercelProjects = list('vercelProjects')
    const neonProjects = list('neonProjects')
    const supabaseProjects = list('supabaseProjects')
    if (!repos || !railwayProjects || !vercelProjects || !neonProjects || !supabaseProjects) return null
    return { repos, railwayProjects, vercelProjects, neonProjects, supabaseProjects }
  } catch {
    return null
  }
}

/**
 * The text of a new config file built from the previous version's file (`~/.claude/intocables.json`): its lists carry
 * over, its note becomes the new `_note`, and any other key the person had is kept. null = it cannot be read.
 */
export function migrateConfig(oldText: string): { text: string; config: Config } | null {
  const config = parseConfig(oldText)
  if (!config) return null
  const old = JSON.parse(oldText) as Record<string, unknown>
  const extras = Object.fromEntries(Object.entries(old).filter(([key]) => !OWN_KEYS.has(key)))
  return { text: `${JSON.stringify({ _note: CONFIG_NOTE, ...config, ...extras }, null, 2)}\n`, config }
}

// ── slugs ───────────────────────────────────────────────────────────────────

/** "owner/repo" of a remote (https, ssh, scp-like, with a token) or of a bare slug; null if there is none. */
export function slugFromUrl(url: string): string | null {
  const u = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  const m = u.match(/[/:]([^/:\s@]+)\/([^/:\s]+)$/) ?? u.match(/^([^/:\s@]+)\/([^/:\s]+)$/)
  return m ? `${m[1]}/${m[2]}` : null
}

/** The protected slug (spelled as in the config) this remote points to, or null. */
export function matchSlug(url: string, config: Config): string | null {
  const slug = slugFromUrl(url)?.toLowerCase()
  return slug ? (config.repos.find(r => r.toLowerCase() === slug) ?? null) : null
}

// ── shell lexer ──────────────────────────────────────────────────────────

export type Redirect = { op: string; target: string }
/** A simple command. `subs` = nested commands ($(...), `...`, <(...), subshells), which run separately. */
export type Simple = { argv: string[]; redirects: Redirect[]; subs: Simple[][] }

const MAX_LEX_DEPTH = 6
const MAX_CHARS = 100_000
const SUB = '$(…)'

function skipHeredoc(s: string, from: number, strip: boolean, delim: string) {
  let i = from
  while (i < s.length) {
    const nl = s.indexOf('\n', i)
    let line = s.slice(i, nl === -1 ? s.length : nl).replace(/\r$/, '')
    if (strip) line = line.replace(/^\t+/, '')
    i = nl === -1 ? s.length : nl + 1
    if (line === delim) break
  }
  return i
}

function lexList(s: string, start: number, closer: ')' | '`' | null, out: Simple[], depth: number): number {
  let i = start
  let argv: string[] = []
  let redirects: Redirect[] = []
  let subs: Simple[][] = []
  let buf = ''
  let inWord = false
  let redir: string | null = null
  const heredocs: { delim: string; strip: boolean }[] = []

  const sub = (from: number, close: ')' | '`') => {
    if (depth >= MAX_LEX_DEPTH) return s.length
    const inner: Simple[] = []
    const next = lexList(s, from, close, inner, depth + 1)
    subs.push(inner)
    return next
  }
  const endWord = () => {
    if (!inWord) return
    const w = buf
    buf = ''
    inWord = false
    if (redir === null) {
      argv.push(w)
      return
    }
    const op = redir
    redir = null
    if (op === '<<' || op === '<<-') heredocs.push({ delim: w, strip: op === '<<-' })
    else if (op === '<' || op === '<<<' || op === '<&' || op === '<>') return
    else if (op === '>&' && /^(\d+|-)$/.test(w)) return
    else redirects.push({ op, target: w })
  }
  const endSimple = () => {
    endWord()
    redir = null
    if (argv.length || redirects.length || subs.length) out.push({ argv, redirects, subs })
    argv = []
    redirects = []
    subs = []
  }

  while (i < s.length) {
    const c = s[i]!
    if (c === '\n') {
      endSimple()
      i++
      for (const h of heredocs) i = skipHeredoc(s, i, h.strip, h.delim)
      heredocs.length = 0
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2
        continue
      }
      inWord = true
      buf += s[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      const end = j === -1 ? s.length : j
      inWord = true
      buf += s.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (c === '"') {
      inWord = true
      i++
      while (i < s.length && s[i] !== '"') {
        const d = s[i]!
        if (d === '\\') {
          const n = s[i + 1] ?? ''
          buf += '$"\\`'.includes(n) ? n : d + n
          i += 2
        } else if (d === '$' && s[i + 1] === '(') {
          buf += SUB
          i = sub(i + 2, ')')
        } else if (d === '`') {
          buf += SUB
          i = sub(i + 1, '`')
        } else {
          buf += d
          i++
        }
      }
      i++
      continue
    }
    if (c === '$' && s[i + 1] === '(') {
      inWord = true
      buf += SUB
      i = sub(i + 2, ')')
      continue
    }
    if (c === '`') {
      if (closer === '`') {
        endSimple()
        return i + 1
      }
      inWord = true
      buf += SUB
      i = sub(i + 1, '`')
      continue
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      inWord = true
      buf += SUB
      i = sub(i + 2, ')')
      continue
    }
    if (c === '>' || c === '<' || (c === '&' && s[i + 1] === '>')) {
      if (inWord && /^\d+$/.test(buf)) {
        buf = ''
        inWord = false
      } else endWord()
      let op: string
      if (c === '&') {
        i += 2
        op = '&>'
        if (s[i] === '>') {
          op = '&>>'
          i++
        }
      } else if (c === '>') {
        i++
        op = '>'
        if (s[i] === '>') (op = '>>'), i++
        else if (s[i] === '|') (op = '>|'), i++
        else if (s[i] === '&') (op = '>&'), i++
      } else {
        i++
        op = '<'
        if (s[i] === '<') {
          i++
          op = '<<'
          if (s[i] === '<') (op = '<<<'), i++
          else if (s[i] === '-') (op = '<<-'), i++
        } else if (s[i] === '&') (op = '<&'), i++
        else if (s[i] === '>') (op = '<>'), i++
      }
      redir = op
      continue
    }
    if (c === ';' || c === '|' || c === '&') {
      endSimple()
      i++
      if ((c === '&' || c === '|') && s[i] === c) i++
      else if (c === '|' && s[i] === '&') i++
      else if (c === ';' && s[i] === ';') i++
      continue
    }
    if (c === '(' && !inWord) {
      endSimple()
      i = sub(i + 1, ')')
      const group = subs.pop()
      if (group) out.push({ argv: [], redirects: [], subs: [group] })
      continue
    }
    if (c === ')' && (closer === ')' || !inWord)) {
      endSimple()
      i++
      if (closer === ')') return i
      continue
    }
    if (c === '#' && !inWord) {
      const nl = s.indexOf('\n', i)
      i = nl === -1 ? s.length : nl
      continue
    }
    inWord = true
    buf += c
    i++
  }
  endSimple()
  return s.length
}

export function lex(src: string): Simple[] {
  const out: Simple[] = []
  lexList(src.slice(0, MAX_CHARS), 0, null, out, 0)
  return out
}

// ── commands: wrappers (sudo, env, npx…), shells (-c) and arguments ─────────

export const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p
export const dirname = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'time', 'coproc'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const SKIP_ONE = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'setsid', 'nice', 'ionice', 'caffeinate', 'timeout', 'stdbuf', 'unbuffer', 'env'])
const WRAP_VALUE: Record<string, string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'],
  doas: ['-u', '-C'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e'],
  caffeinate: ['-t', '-w'],
  env: ['-u', '-C', '-S'],
}
const RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** `neonctl@latest` / `@scope/pkg@1.2` → the package without the version (what `npx` and `dlx` accept). */
const unversioned = (pkg: string) => pkg.replace(/(?<=.)@[^/@]*$/, '')

export type Cmd = { name: string; args: string[]; env: Record<string, string> }
export type Resolved = { cmd: Cmd } | { inner: string } | null

/** Strips assignments, keywords and wrappers; recognises `bash -c "…"` and `eval`. */
export function resolveCommand(argv: string[]): Resolved {
  const env: Record<string, string> = {}
  let a = [...argv]
  for (let guard = 0; guard < 24; guard++) {
    const w = a[0]
    if (w === undefined) return null
    if (KEYWORDS.has(w)) {
      a.shift()
      continue
    }
    if (ENV_ASSIGN.test(w)) {
      const eq = w.indexOf('=')
      env[w.slice(0, eq)] = w.slice(eq + 1)
      a.shift()
      continue
    }
    const base = basename(w)
    if (SKIP_ONE.has(base)) {
      a.shift()
      const values = WRAP_VALUE[base] ?? []
      while (a[0] !== undefined) {
        const x = a[0]
        if (base === 'env' && ENV_ASSIGN.test(x)) {
          env[x.slice(0, x.indexOf('='))] = x.slice(x.indexOf('=') + 1)
          a.shift()
        } else if (x.startsWith('-') && x.length > 1) {
          a.shift()
          if (values.includes(x)) a.shift()
        } else break
      }
      if (base === 'timeout' && a[0] !== undefined && /^\d/.test(a[0])) a.shift()
      continue
    }
    if (RUNNERS.has(base)) {
      a.shift()
      while (a[0] !== undefined && a[0].startsWith('-')) {
        const f = a.shift()!
        if (f === '-p' || f === '--package') a.shift()
      }
      if (a[0] !== undefined) a[0] = unversioned(a[0])
      continue
    }
    if (PKG.has(base) && a[1] !== undefined && ['dlx', 'exec', 'x', 'vercel', 'changeset', 'neonctl', 'neon', 'supabase'].includes(a[1])) {
      a.shift()
      if (a[0] === 'dlx' || a[0] === 'exec' || a[0] === 'x') a.shift()
      while (a[0] !== undefined && a[0].startsWith('-')) a.shift()
      if (a[0] !== undefined) a[0] = unversioned(a[0])
      continue
    }
    if (SHELLS.has(base)) {
      const k = a.findIndex((x, n) => n > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x))
      const script = k === -1 ? undefined : a[k + 1]
      return script === undefined ? { cmd: { name: base, args: a.slice(1), env } } : { inner: script }
    }
    if (base === 'eval') return { inner: a.slice(1).join(' ') }
    return { cmd: { name: base, args: a.slice(1), env } }
  }
  return null
}

export type Parsed = {
  pos: string[]
  flags: Map<string, string | true>
  has: (...names: string[]) => boolean
  /** There is a grouped short flag (-rf, -ni) with this letter. */
  short: (letter: string) => boolean
  value: (...names: string[]) => string | undefined
}

/** Splits positionals and flags; `valueFlags` are the ones that take the next argument. */
export function parseArgs(args: string[], valueFlags: readonly string[] = []): Parsed {
  const values = new Set(valueFlags)
  const pos: string[] = []
  const flags = new Map<string, string | true>()
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') {
      pos.push(...args.slice(k + 1))
      flags.set('--', true)
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags.set(a.slice(0, eq), a.slice(eq + 1))
      else if (values.has(a)) flags.set(a, args[++k] ?? '')
      else flags.set(a, true)
      continue
    }
    if (a.length > 1 && a.startsWith('-')) {
      const f = a.slice(0, 2)
      if (values.has(f)) flags.set(f, a.length > 2 ? a.slice(2).replace(/^=/, '') : (args[++k] ?? ''))
      else flags.set(a, true)
      continue
    }
    pos.push(a)
  }
  return {
    pos,
    flags,
    has: (...names) => names.some(n => flags.has(n)),
    short: letter => [...flags.keys()].some(k => /^-[^-]/.test(k) && k.slice(1).includes(letter)),
    value: (...names) => {
      for (const n of names) {
        const v = flags.get(n)
        if (typeof v === 'string') return v
      }
      return undefined
    },
  }
}

// ── rutas ───────────────────────────────────────────────────────────────────

export function normalizePath(p: string) {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** Absolute path of a shell argument, or null if it depends on something unknowable ($VAR, $(...)). */
export function resolvePath(p: string, dir: string | null, home: string): string | null {
  const q = p.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home)
  if (q.includes('$') || q.includes('`')) return null
  if (q.startsWith('/')) return normalizePath(q)
  return dir === null ? null : normalizePath(`${dir}/${q}`)
}

// ── Bash analysis ────────────────────────────────────────────────────────

export type Hit = { key: string; label: string; detail: string }

/** Notices the rules can raise through `Deps.warn`. */
export type Warning = 'forkUnchecked'

export type Deps = {
  cwd: string
  home: string
  config: Config
  words: Words
  /** URL of the origin remote of the repo that contains `path` (nearest existing ancestor); '' if there is no repo. */
  originOf: (path: string) => Promise<string>
  /** URL of the remote `name` of the repo of `dir`; ''. */
  remoteUrl: (dir: string, name: string) => Promise<string>
  /** URLs of ALL the remotes of the repo that contains `dir` (local, no network); [] if there is no repo or on any error. */
  remotesOf: (dir: string) => Promise<string[]>
  /**
   * The repo the GitHub repo `slug` (owner/repo) was forked from, asked to GitHub (network, cached by the caller):
   * its `owner/repo`; `null` = GitHub says it is not a fork; `undefined` = it could not be checked (offline, no gh, no login).
   */
  parentOf: (slug: string) => Promise<string | null | undefined>
  /** Raises a notice the caller shows to the person (once per session); the rules stay pure. */
  warn: (key: Warning) => void | Promise<void>
  /** Name of the Railway project linked to `dir`; ''. */
  railwayLinked: (dir: string) => Promise<string>
  /** Vercel project linked to `dir` (.vercel/project.json); empty strings if none. */
  vercelLinked: (dir: string) => Promise<{ name: string; id: string }>
  /**
   * Id of the Neon project the context file points to (`.neon`, JSON, field `projectId`); ''.
   * Without `file`: the nearest `.neon` going up from `dir` (up to 40 levels). With `file` (`--context-file`,
   * ya resuelta): solo ese archivo.
   */
  neonContext: (dir: string, file?: string) => Promise<string>
  /**
   * Linked Supabase project ref (`supabase/.temp/project-ref`, trimmed); ''.
   * Without `exact`: the nearest one going up from `dir` (up to 40 levels). With `exact` (`--workdir`): only in `dir`.
   */
  supabaseLinked: (dir: string, exact?: boolean) => Promise<string>
}

const MAX_ORIGIN_LOOKUPS = 24
const MAX_DEPTH = 5

const FS_OPS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'touch', 'mkdir', 'truncate', 'tee', 'chmod', 'chown', 'chgrp', 'mv', 'cp', 'install', 'rsync', 'ln', 'dd', 'find', 'sed', 'perl'])
const FIND_WRITERS = new Set(['rm', 'mv', 'cp', 'chmod', 'chown', 'tee', 'touch', 'truncate', 'unlink', 'rmdir', 'shred'])
const OUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])

const GH_VALUE = ['-R', '--repo', '-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-b', '--body', '-B', '--base', '--head', '--title', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '--body-file', '-F', '--notes', '--notes-file', '--target']
const GH_WRITE: Record<string, readonly string[]> = {
  pr: ['create', 'merge', 'edit', 'close', 'comment', 'review', 'ready', 'reopen', 'update-branch', 'lock', 'unlock'],
  // `issue create` / `issue comment` are not here on purpose: filing a ticket or commenting on one does not change the repo
  // (José, 24-oct-2026: "Hands Off sí debería permitir crear tickets"). Editing, closing, deleting or moving issues still writes.
  issue: ['edit', 'close', 'reopen', 'delete', 'transfer', 'pin', 'unpin', 'lock', 'unlock', 'develop'],
  release: ['create', 'edit', 'delete', 'upload', 'delete-asset'],
  repo: ['edit', 'delete', 'archive', 'unarchive', 'rename', 'sync', 'deploy-key'],
  workflow: ['disable', 'enable', 'run'],
  run: ['rerun', 'cancel', 'delete'],
  label: ['create', 'edit', 'delete', 'clone'],
  secret: ['set', 'delete', 'remove'],
  variable: ['set', 'delete'],
  cache: ['delete'],
}

/** `gh api` endpoints that only file a ticket or comment on one (POST): allowed even in a protected repo. */
const ISSUE_TICKET_ENDPOINT = /^\/?repos\/[^/]+\/[^/?#]+\/issues(\/\d+\/comments)?\/?(\?.*)?$/i

const VERCEL_VALUE = ['--cwd', '-t', '--token', '-S', '--scope', '-A', '--local-config', '-Q', '--global-config', '-e', '--env', '-b', '--build-env', '-m', '--meta', '--target', '--regions', '-n', '--name', '--org', '--project']
const VERCEL_READ = new Set(['ls', 'list', 'inspect', 'logs', 'whoami', 'help', 'login', 'logout', 'teams', 'switch', 'bisect', 'curl', 'httpstat', 'telemetry', 'dev'])
const VERCEL_READ_SUB = new Set(['ls', 'list', 'inspect', 'get', 'view'])

const RAILWAY_VALUE = ['-s', '--service', '-e', '--environment', '-p', '--project', '-t', '--team', '-w', '--workspace', '--set', '--set-from-stdin']
const RAILWAY_TOP_WRITE = new Set(['up', 'redeploy', 'down', 'deploy', 'delete', 'rm', 'remove', 'init', 'new', 'add', 'link', 'unlink', 'restart', 'scale', 'rollback'])
const RAILWAY_GROUPS = new Set(['environment', 'env', 'service', 'domain', 'deployment', 'deployments', 'project', 'projects', 'volume', 'bucket', 'buckets', 'cdn', 'config', 'postgres', 'mysql', 'private-network', 'outbound-network', 'flag', 'flags'])
const RAILWAY_READ_SUB = new Set(['list', 'ls', 'status', 'logs', 'show', 'get', 'info', 'view', 'inspect', 'help'])

const NEON_VALUE = ['--project-id', '--context-file', '--org-id', '--api-key', '-o', '--output', '--config-dir', '--branch', '--parent', '--name', '-n', '--cu', '--region-id', '--role', '--role-name', '--database', '--database-name', '--owner-name', '--type', '--endpoint', '--suspend-timeout', '--compute-unit', '--vpc-endpoint-id', '--vpc-project-id']
const NEON_READ_SUB: Record<string, ReadonlySet<string>> = {
  projects: new Set(['list', 'get', 'help']),
  project: new Set(['list', 'get', 'help']),
  branches: new Set(['list', 'get', 'schema-diff', 'help']),
  branch: new Set(['list', 'get', 'schema-diff', 'help']),
  databases: new Set(['list', 'get', 'help']),
  database: new Set(['list', 'get', 'help']),
  roles: new Set(['list', 'help']),
  role: new Set(['list', 'help']),
  'ip-allow': new Set(['list', 'help']),
}

const SUPABASE_VALUE = ['--workdir', '--project-ref', '--db-url', '--password', '-p', '--network-id', '--dns-resolver', '--profile', '-o', '--output', '--schema', '-s', '--file', '-f', '--org-id', '--name', '--region', '--size', '--import-map', '--env-file', '--status']
const SUPABASE_WRITE_SUB: Record<string, readonly string[]> = {
  functions: ['deploy', 'delete'],
  secrets: ['set', 'unset'],
  projects: ['delete', 'create'],
  config: ['push'],
  branches: ['create', 'delete', 'update', 'disable'],
  'postgres-config': ['update', 'delete'],
  domains: ['create', 'activate', 'delete', 'reverify'],
  'vanity-subdomains': ['activate', 'delete'],
  'network-restrictions': ['update'],
  'ssl-enforcement': ['update'],
  sso: ['add', 'update', 'remove'],
  backups: ['restore'],
}

const NPM_VALUE = ['-C', '--dir', '--prefix', '--cwd', '-w', '--workspace', '--filter', '-F', '--tag', '--registry', '--otp', '--access']

/** Does `git <sub> …` write to the repo? (conservative: when in doubt about a read, it does not block). */
export function gitWrites(sub: string, rest: string[]): boolean {
  const p = parseArgs(rest, ['-m', '-F', '-u', '--set-upstream-to', '--contains', '--points-at', '--merged', '--no-merged', '--sort', '--format'])
  const flagNames = [...p.flags.keys()].map(k => k.split('=')[0]!)
  const any = (...f: string[]) => f.some(x => flagNames.includes(x))
  switch (sub) {
    case 'commit': case 'rm': case 'mv': case 'reset': case 'rebase': case 'merge': case 'cherry-pick': case 'revert': case 'am':
    case 'restore': case 'update-ref': case 'filter-branch': case 'fast-import': case 'commit-tree': case 'replace':
      return true
    case 'add':
      return !any('-n', '--dry-run')
    case 'push':
      return !any('-n', '--dry-run')
    case 'clean':
      return !(any('-n', '--dry-run') || p.short('n'))
    case 'apply':
      return !any('--check', '--stat', '--numstat', '--summary')
    case 'tag': {
      if (any('-l', '--list', '-v', '--verify', '--contains', '--points-at', '--merged', '--no-merged')) return false
      if (any('-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '-F', '-u')) return true
      return p.pos.length > 0
    }
    case 'branch': {
      if (any('-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-u', '--set-upstream-to', '--set-upstream', '--unset-upstream', '-f', '--force', '--edit-description', '-t', '--track')) return true
      if (any('-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column')) return false
      return p.pos.length > 0
    }
    case 'checkout':
      return any('-b', '-B', '--orphan', '--') || p.pos.includes('.') || rest.some(a => /^-[bB]\S/.test(a))
    case 'switch':
      return any('-c', '-C', '--create', '--force-create', '--orphan') || rest.some(a => /^-[cC]\S/.test(a) && !a.startsWith('--'))
    case 'stash':
      return !['list', 'show'].includes(p.pos[0] ?? '')
    case 'remote':
      return ['add', 'set-url', 'set-head', 'set-branches', 'remove', 'rm', 'rename', 'prune'].includes(p.pos[0] ?? '')
    case 'config': {
      if (any('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '--global', '--system')) return false
      return p.pos.length >= 2 || any('--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section')
    }
    case 'worktree':
      return ['add', 'remove', 'move', 'prune', 'lock', 'unlock', 'repair'].includes(p.pos[0] ?? '')
    case 'submodule':
      return ['add', 'update', 'init', 'deinit', 'sync', 'set-url', 'set-branch', 'absorbgitdirs'].includes(p.pos[0] ?? '')
    case 'notes':
      return ['add', 'append', 'copy', 'edit', 'merge', 'remove', 'prune'].includes(p.pos[0] ?? '')
    case 'reflog':
      return ['expire', 'delete'].includes(p.pos[0] ?? '')
    default:
      return false
  }
}

function vercelWrites(p: Parsed): boolean {
  if (p.has('--version', '-v', '--help', '-h')) return false
  const first = p.pos[0]
  if (first === undefined) return true
  if (/^[./~]/.test(first)) return true
  if (VERCEL_READ.has(first)) return false
  return !VERCEL_READ_SUB.has(p.pos[1] ?? '')
}

function railwayWrites(p: Parsed): boolean {
  const top = p.pos[0]
  const sub = p.pos[1]
  if (top === undefined || p.has('--help', '-h', '--version', '-V')) return false
  if (RAILWAY_TOP_WRITE.has(top)) return true
  if (['variable', 'variables', 'vars', 'var'].includes(top)) {
    return p.has('--set', '--set-from-stdin') || ['set', 'delete', 'rm', 'remove', 'edit'].includes(sub ?? '')
  }
  if (RAILWAY_GROUPS.has(top)) return sub === undefined ? ['service', 'environment', 'env', 'domain'].includes(top) : !RAILWAY_READ_SUB.has(sub)
  if (top === 'api') return [...p.pos.slice(1), ...[...p.flags.values()].filter((v): v is string => typeof v === 'string')].some(x => /\bmutation\b/.test(x))
  return false
}

/** Does `neon <group> <sub>` change anything? (`nx` is a common wrapper for the Neon CLI). An unknown subcommand of a write group: yes. */
function neonWrites(p: Parsed): boolean {
  if (p.has('--help', '-h', '--version')) return false
  const [group, sub] = p.pos
  if (group === undefined) return false
  if (group === 'set-context') return true
  if (group === 'vpc') return sub !== undefined && !p.pos.slice(1).some(x => x === 'list' || x === 'status')
  const reads = NEON_READ_SUB[group]
  return reads !== undefined && sub !== undefined && !reads.has(sub)
}

/** Does `supabase …` change the remote project? `db reset` only if it points at one (`--linked` / `--db-url`). */
function supabaseWrites(p: Parsed): boolean {
  if (p.has('--help', '-h')) return false
  const [top, sub] = p.pos
  if (top === undefined) return false
  // Without --local (or with --linked / --db-url) the target is the remote project.
  const remote = !p.has('--local') || p.has('--linked', '--db-url')
  switch (top) {
    case 'link': case 'unlink':
      return true
    case 'db':
      if (sub === 'push') return remote && !p.has('--dry-run')
      return sub === 'reset' && p.has('--linked', '--db-url')
    case 'migration':
      if (sub === 'repair') return remote
      return sub === 'up' && p.has('--linked', '--db-url')
    case 'storage': {
      if (sub === 'rm') return remote
      if (sub === 'cp' || sub === 'mv') return remote && /^ss:\/\//.test(p.pos.length >= 4 ? p.pos.at(-1)! : '')
      return false
    }
    default:
      return SUPABASE_WRITE_SUB[top]?.includes(sub ?? '') ?? false
  }
}

export class Scan {
  hits: Hit[] = []
  private lookups = 0
  private cache = new Map<string, string | null>()
  private forks = new Map<string, string | null>()

  constructor(private deps: Deps) {}

  private get config() {
    return this.deps.config
  }

  private hit(slug: string, detail: string) {
    const key = slug.toLowerCase()
    if (!this.hits.some(h => h.key === key)) this.hits.push({ key, label: slug, detail })
  }

  /** The protected slug of the repo that contains `path`, or null (also once the lookup cap is exceeded). */
  async slugAt(path: string | null): Promise<string | null> {
    if (path === null) return null
    if (this.cache.has(path)) return this.cache.get(path) ?? null
    if (++this.lookups > MAX_ORIGIN_LOOKUPS) return null
    const url = await this.deps.originOf(path).catch(() => '')
    const slug = url ? matchSlug(url, this.config) : null
    this.cache.set(path, slug)
    return slug
  }

  /**
   * The protected repo a `gh` WRITE reaches from `dir` when the command names no repo. `gh` aims at the PARENT of a fork,
   * not at its `origin`, so besides the origin it looks at (1) every remote of the repo (local) and (2) only if those
   * find nothing, at the repo `origin` was forked from, asked to GitHub (skipped when nothing is protected).
   */
  private async ghTarget(dir: string | null): Promise<string | null> {
    const origin = await this.slugAt(dir)
    if (origin || dir === null) return origin
    if (this.forks.has(dir)) return this.forks.get(dir) ?? null
    const slug = await this.forkTarget(dir)
    this.forks.set(dir, slug)
    return slug
  }

  private async forkTarget(dir: string): Promise<string | null> {
    if (++this.lookups > MAX_ORIGIN_LOOKUPS) return null
    for (const url of await this.deps.remotesOf(dir).catch(() => [] as string[])) {
      const slug = matchSlug(url, this.config)
      if (slug) return slug
    }
    if (this.config.repos.length === 0) return null
    const origin = await this.deps.originOf(dir).catch(() => '')
    const own = /github\.com[/:]/i.test(origin) ? slugFromUrl(origin) : null
    if (!own) return null
    const parent = await this.deps.parentOf(own).catch(() => undefined)
    if (parent === undefined) {
      await Promise.resolve(this.deps.warn('forkUnchecked')).catch(() => undefined)
      return null
    }
    return parent ? matchSlug(parent, this.config) : null
  }

  private async hitPath(path: string | null, detail: string) {
    const slug = await this.slugAt(path)
    if (slug) this.hit(slug, detail)
  }

  async seq(list: Simple[], start: string | null, depth: number): Promise<void> {
    let dir = start
    for (const sp of list) {
      for (const inner of sp.subs) if (depth < MAX_DEPTH) await this.seq(inner, dir, depth + 1)
      for (const r of sp.redirects) {
        if (!OUT_OPS.has(r.op)) continue
        const target = resolvePath(r.target, dir, this.deps.home)
        if (target !== null && !target.startsWith('/dev/')) await this.hitPath(target, this.deps.words.redirectTo(basename(target)))
      }
      const res = resolveCommand(sp.argv)
      if (res === null) continue
      if ('inner' in res) {
        if (depth < MAX_DEPTH) await this.seq(lex(res.inner), dir, depth + 1)
        continue
      }
      dir = await this.run(res.cmd, dir)
    }
  }

  private async run(cmd: Cmd, dir: string | null): Promise<string | null> {
    const { name, args } = cmd
    switch (name) {
      case 'cd': case 'pushd': case 'chdir': {
        const target = args.find(a => !a.startsWith('-') || a === '-')
        if (target === undefined) return this.deps.home
        // A destination that cannot be known ($VAR, $(...), cd -) leaves the directory where it was: the safe thing is
        // to keep treating the command as if it ran where it already was.
        return resolvePath(target, dir, this.deps.home) ?? dir
      }
      case 'popd':
        return dir
      case 'git':
        await this.git(args, dir)
        break
      case 'gh':
        await this.gh(args, dir, cmd.env)
        break
      case 'vercel':
        await this.vercel(args, dir)
        break
      case 'railway':
        await this.railway(args, dir)
        break
      case 'neon': case 'neonctl': case 'nx':
        await this.neon(args, dir)
        break
      case 'supabase':
        await this.supabase(args, dir)
        break
      case 'npm': case 'pnpm': case 'yarn': case 'bun': case 'changeset':
        await this.publish(name, args, dir)
        break
      default:
        if (FS_OPS.has(name)) await this.files(name, args, dir)
    }
    return dir
  }

  // ── git ───────────────────────────────────────────────────────────────────

  private async git(args: string[], start: string | null) {
    let dir = start
    let i = 0
    for (; i < args.length; i++) {
      const a = args[i]!
      if (!a.startsWith('-')) break
      if (a === '-C') dir = resolvePath(args[++i] ?? '', dir, this.deps.home) ?? dir
      else if (a === '-c' || a === '--namespace' || a === '--exec-path' || a === '--super-prefix' || a === '--config-env') i++
      else if (a === '--work-tree' || a === '--git-dir') dir = resolvePath(args[++i] ?? '', dir, this.deps.home) ?? dir
      else if (a.startsWith('--work-tree=') || a.startsWith('--git-dir=')) dir = resolvePath(a.slice(a.indexOf('=') + 1), dir, this.deps.home) ?? dir
    }
    const sub = args[i]
    if (sub === undefined || dir === null) return
    const rest = args.slice(i + 1)
    if (!gitWrites(sub, rest)) return
    await this.hitPath(dir, `git ${sub}`)
    if (sub !== 'push') return
    const p = parseArgs(rest, ['-o', '--push-option', '--receive-pack', '--exec', '--repo'])
    for (const target of [p.value('--repo'), p.pos[0]]) {
      if (!target) continue
      const url = /[/:]/.test(target) ? target : await this.deps.remoteUrl(dir, target).catch(() => '')
      const slug = url ? matchSlug(url, this.config) : null
      if (slug) this.hit(slug, 'git push')
    }
  }

  // ── gh ────────────────────────────────────────────────────────────────────

  private async gh(args: string[], dir: string | null, env: Record<string, string>) {
    const p = parseArgs(args, GH_VALUE)
    const [group, sub] = p.pos
    if (group === undefined) return
    const repoFlag = p.value('-R', '--repo') ?? env.GH_REPO
    // `gh api` ignores -R: a repo flag or GH_REPO there keeps the origin-only check it always had.
    const current = async (named = false) => (repoFlag ? matchSlug(repoFlag, this.config) : named ? this.slugAt(dir) : this.ghTarget(dir))

    if (group === 'api') {
      const endpoint = p.pos[1] ?? ''
      const hasBody = p.has('-f', '-F', '--field', '--raw-field', '--input')
      const method = (p.value('-X', '--method') ?? (hasBody ? 'POST' : 'GET')).toUpperCase()
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return
      if (endpoint === 'graphql') {
        if (!args.some(a => /\bmutation\b/.test(a))) return
        const mentioned = this.config.repos.find(r => args.some(a => a.toLowerCase().includes(r.toLowerCase())))
        // gh fills the repo of a mutation from -R / GH_REPO when given, else from the folder (and its fork parent).
        const slug = mentioned ?? (repoFlag ? matchSlug(repoFlag, this.config) : await this.ghTarget(dir))
        if (slug) this.hit(slug, 'gh api graphql (mutation)')
        return
      }
      const m = endpoint.match(/^\/?repos\/([^/]+)\/([^/?#]+)/i)
      if (!m) return
      // Filing a ticket (POST …/issues) or commenting on one (POST …/issues/N/comments) is allowed, like `gh issue create/comment`.
      if (method === 'POST' && ISSUE_TICKET_ENDPOINT.test(endpoint)) return
      // `{owner}/{repo}` is filled by gh from -R / GH_REPO when given, else from the folder (and its fork parent).
      const slug = m[1]!.includes('{') ? (repoFlag ? matchSlug(repoFlag, this.config) : await this.ghTarget(dir)) : matchSlug(`${m[1]}/${m[2]}`, this.config)
      if (slug) this.hit(slug, `gh api -X ${method}`)
      return
    }

    // A PR/issue by URL, or `gh repo edit owner/repo`, names the repo without -R.
    const rest = p.pos.slice(2)
    const named = rest.map(x => {
      const url = x.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i)
      return url ? matchSlug(`${url[1]}/${url[2]}`, this.config) : group === 'repo' ? matchSlug(x, this.config) : null
    })
    const writes = GH_WRITE[group]
    if (!writes || sub === undefined || !writes.includes(sub)) return
    // A repo named by URL or position decides as before (the fork layers apply only when nothing names the repo).
    const mentionsRepo = rest.some(x => /github\.com[/:]/i.test(x) || group === 'repo')
    const slug = named.find(Boolean) ?? (await current(mentionsRepo))
    if (slug) this.hit(slug, `gh ${group} ${sub}`)
  }

  // ── vercel, railway, publish ──────────────────────────────────────────────

  private async vercel(args: string[], dir: string | null) {
    const p = parseArgs(args, VERCEL_VALUE)
    if (!vercelWrites(p)) return
    let at = dir
    const cwdFlag = p.value('--cwd')
    if (cwdFlag) at = resolvePath(cwdFlag, dir, this.deps.home) ?? dir
    const first = p.pos[0]
    if (first && /^[./~]/.test(first)) at = resolvePath(first, at, this.deps.home) ?? at
    const sub = first && !/^[./~]/.test(first) ? first : 'deploy'
    const protectedEntry = (n: string) => (n ? this.config.vercelProjects.find(x => x.toLowerCase() === n.toLowerCase()) : undefined)
    const named = [p.value('--project'), first === 'link' ? p.pos[1] : undefined].filter((x): x is string => !!x)
    for (const n of named) {
      const hit = protectedEntry(n)
      if (hit) this.hitVercel(hit, sub)
    }
    if (at !== null && this.config.vercelProjects.length > 0) {
      const linked = await this.deps.vercelLinked(at).catch(() => ({ name: '', id: '' }))
      const hit = protectedEntry(linked.name) ?? protectedEntry(linked.id)
      if (hit) this.hitVercel(hit, sub)
    }
    await this.hitPath(at, `vercel ${sub}`)
  }

  private hitVercel(name: string, sub: string) {
    const key = `vercel:${name.toLowerCase()}`
    if (!this.hits.some(h => h.key === key)) this.hits.push({ key, label: `Vercel ${name}`, detail: `vercel ${sub}` })
  }

  private async railway(args: string[], dir: string | null) {
    const p = parseArgs(args, RAILWAY_VALUE)
    if (!railwayWrites(p)) return
    const sub = p.pos[0]!
    const protectedName = (n: string) => this.config.railwayProjects.find(x => x.toLowerCase() === n.toLowerCase())
    const named = [p.value('-p', '--project'), sub === 'link' ? p.pos[1] : undefined].filter((x): x is string => !!x)
    for (const n of named) {
      const hit = protectedName(n)
      if (hit) this.hitRailway(hit, sub)
    }
    if (named.length > 0 || sub === 'link' || sub === 'unlink') return
    if (dir !== null) {
      const linked = protectedName(await this.deps.railwayLinked(dir).catch(() => ''))
      if (linked) this.hitRailway(linked, sub)
      await this.hitPath(dir, `railway ${sub}`)
    }
  }

  private hitRailway(name: string, sub: string) {
    const key = `railway:${name.toLowerCase()}`
    if (!this.hits.some(h => h.key === key)) this.hits.push({ key, label: `Railway ${name}`, detail: `railway ${sub}` })
  }

  private async neon(args: string[], dir: string | null) {
    const p = parseArgs(args, NEON_VALUE)
    if (!neonWrites(p)) return
    const sub = `neon ${p.pos.slice(0, 2).join(' ')}`
    const list = this.config.neonProjects
    const protectedId = (id: string) => (id ? list.find(x => x.toLowerCase() === id.toLowerCase()) : undefined)
    const id = p.value('--project-id')
    if (id) {
      const hit = protectedId(id)
      if (hit) this.hitNeon(hit, sub)
    } else if (dir !== null && list.length > 0) {
      const flag = p.value('--context-file')
      const file = flag ? resolvePath(flag, dir, this.deps.home) : undefined
      // A --context-file that cannot be resolved ($VAR) is not guessed.
      if (file !== null) {
        const hit = protectedId(await this.deps.neonContext(dir, file).catch(() => ''))
        if (hit) this.hitNeon(hit, sub)
      }
    }
    await this.hitPath(dir, sub)
  }

  private hitNeon(id: string, detail: string) {
    const key = `neon:${id.toLowerCase()}`
    if (!this.hits.some(h => h.key === key)) this.hits.push({ key, label: `Neon ${id}`, detail })
  }

  private async supabase(args: string[], dir: string | null) {
    const p = parseArgs(args, SUPABASE_VALUE)
    if (!supabaseWrites(p)) return
    const sub = `supabase ${p.pos.slice(0, 2).join(' ')}`
    const list = this.config.supabaseProjects
    const protectedRef = (ref: string) => (ref ? list.find(x => x.toLowerCase() === ref.toLowerCase()) : undefined)
    const workdir = p.value('--workdir')
    const at = workdir ? resolvePath(workdir, dir, this.deps.home) : dir
    const named = [p.value('--project-ref'), p.pos[0] === 'projects' && p.pos[1] === 'delete' ? p.pos[2] : undefined].filter((x): x is string => !!x)
    for (const n of named) {
      const hit = protectedRef(n)
      if (hit) this.hitSupabase(hit, sub)
    }
    // A database URL names the project (db.<ref>.supabase.co, postgres.<ref>@…pooler).
    const dbUrl = p.value('--db-url')?.toLowerCase()
    if (dbUrl) for (const x of list) if (dbUrl.includes(x.toLowerCase())) this.hitSupabase(x, sub)
    // A local URL (the development database) is not the linked project; any other one without the ref falls back to the link.
    const localUrl = !!dbUrl && /(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)/.test(dbUrl)
    if (named.length === 0 && !localUrl && at !== null && list.length > 0) {
      const hit = protectedRef(await this.deps.supabaseLinked(at, !!workdir).catch(() => ''))
      if (hit) this.hitSupabase(hit, sub)
    }
    await this.hitPath(at, sub)
  }

  private hitSupabase(ref: string, detail: string) {
    const key = `supabase:${ref.toLowerCase()}`
    if (!this.hits.some(h => h.key === key)) this.hits.push({ key, label: `Supabase ${ref}`, detail })
  }

  private async publish(name: string, args: string[], dir: string | null) {
    const p = parseArgs(args, NPM_VALUE)
    const pos = [...p.pos]
    if (name === 'yarn' && pos[0] === 'npm') pos.shift()
    if (pos[0] !== 'publish' || p.has('--dry-run')) return
    let at = dir
    const prefix = p.value('--prefix', '-C', '--dir', '--cwd')
    if (prefix) at = resolvePath(prefix, dir, this.deps.home) ?? dir
    const operand = pos[1]
    if (operand && /^[./~]/.test(operand)) at = resolvePath(operand, at, this.deps.home) ?? at
    await this.hitPath(at, `${name} publish`)
  }

  // ── archivos ──────────────────────────────────────────────────────────────

  private async files(name: string, args: string[], dir: string | null) {
    const paths = this.writtenPaths(name, args, dir)
    for (const w of paths.slice(0, 12)) {
      const path = resolvePath(w, dir, this.deps.home)
      await this.hitPath(path, `${name} ${basename(path ?? w)}`)
    }
  }

  /** Arguments the command writes, deletes or moves (the raw paths; they are resolved separately). */
  private writtenPaths(name: string, args: string[], dir: string | null): string[] {
    switch (name) {
      case 'rm': case 'rmdir': case 'unlink': case 'shred': case 'trash': case 'mkdir': case 'tee':
        return parseArgs(args).pos
      case 'touch':
        return parseArgs(args, ['-t', '-d', '-r', '--date', '--reference']).pos
      case 'truncate':
        return parseArgs(args, ['-s', '--size', '-r', '--reference']).pos
      case 'chmod': case 'chown': case 'chgrp': {
        const p = parseArgs(args)
        return p.has('--reference') ? p.pos : p.pos.slice(1)
      }
      case 'mv': {
        const p = parseArgs(args, ['-t', '--target-directory', '-S', '--suffix'])
        const t = p.value('-t', '--target-directory')
        return t ? [t, ...p.pos] : p.pos
      }
      case 'cp': case 'install': case 'ln': {
        const p = parseArgs(args, ['-t', '--target-directory', '-S', '--suffix', '-m', '-o', '-g', '--mode', '--owner', '--group'])
        const t = p.value('-t', '--target-directory')
        if (t) return [t]
        if (name === 'ln' && p.pos.length < 2) return dir === null ? [] : ['.']
        return p.pos.length >= 2 ? [p.pos.at(-1)!] : []
      }
      case 'rsync': {
        const p = parseArgs(args, ['-e', '--rsh', '--exclude', '--include', '--exclude-from', '--include-from', '--port', '--bwlimit'])
        if (p.has('--dry-run') || p.short('n')) return []
        const last = p.pos.at(-1)
        return p.pos.length >= 2 && last && !/^[\w.@-]+:/.test(last) ? [last] : []
      }
      case 'dd':
        return args.filter(a => a.startsWith('of=')).map(a => a.slice(3))
      case 'find': {
        const start: string[] = []
        for (const a of args) {
          if (a.startsWith('-') || a === '(' || a === '!') break
          start.push(a)
        }
        const k = args.findIndex(a => ['-exec', '-execdir', '-ok', '-okdir'].includes(a))
        const writes = args.includes('-delete') || (k !== -1 && FIND_WRITERS.has(basename(args[k + 1] ?? '')))
        return writes ? (start.length ? start : ['.']) : []
      }
      case 'sed': {
        const p = parseArgs(args, ['-e', '--expression', '-f', '--file', '-l', '--line-length'])
        const inPlace = args.some(a => /^-[nEersuz]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))
        if (!inPlace) return []
        // BSD: `sed -i '' …` leaves the empty string (the suffix) as the first positional.
        const pos = p.pos[0] === '' ? p.pos.slice(1) : p.pos
        const files = p.has('-e', '--expression', '-f', '--file') ? pos : pos.slice(1)
        return files.filter(f => f !== '')
      }
      case 'perl': {
        const p = parseArgs(args, ['-e', '-E', '-I', '-M', '-m', '-F', '-x'])
        const inPlace = args.some(a => /^-[A-Za-z]*i/.test(a) && !a.startsWith('--'))
        if (!inPlace) return []
        return p.has('-e', '-E') ? p.pos : p.pos.slice(1)
      }
      default:
        return []
    }
  }
}

/** Everything protected that this Bash command would write (empty = nothing). */
export async function checkBash(cmd: string, deps: Deps): Promise<Hit[]> {
  const scan = new Scan(deps)
  await scan.seq(lex(cmd), deps.cwd, 0)
  return scan.hits
}

/** Edit/Write/NotebookEdit: does the file fall inside a protected repo? */
export async function checkPath(path: string, deps: Deps): Promise<Hit[]> {
  const scan = new Scan(deps)
  const abs = resolvePath(path, deps.cwd, deps.home)
  const slug = await scan.slugAt(abs)
  return slug ? [{ key: slug.toLowerCase(), label: slug, detail: deps.words.editOf(basename(path)) }] : []
}

/** Keys of an MCP input that name the project (Neon: projectId; Supabase: project_id). */
const MCP_PROJECT_KEYS = ['projectId', 'project_id', 'projectRef', 'project_ref']
const MCP_READ_PREFIX = ['get_', 'list_', 'describe_', 'search', 'fetch', 'explain_', 'compare_', 'inspect_', 'query_logs', 'read_', 'generate_typescript_types']

/** Short name of an MCP tool (`mcp__Neon__run_sql` → `run_sql`). */
export const mcpShortName = (tool: string) => tool.split('__').pop() ?? tool

/** An MCP tool that only reads (short, explicit list; when in doubt, it writes). */
export function mcpReads(tool: string): boolean {
  const short = mcpShortName(tool).toLowerCase()
  return MCP_READ_PREFIX.some(p => short.startsWith(p)) || short === 'get_advisors' || short === 'get_logs'
}

/**
 * MCP tool (Neon, Supabase…): does it write to a protected project? The project comes from `projectId` / `project_id` /
 * `projectRef` / `project_ref`; an id can be in both lists. Without an id (a single-project connection) there is no match.
 */
export function checkMcp(tool: string, input: Record<string, unknown>, config: Config): Hit[] {
  // `explain_…` with `analyze` really runs the statement: a write, like run_sql.
  const runs = mcpShortName(tool).toLowerCase().startsWith('explain_') && input.analyze === true
  if (mcpReads(tool) && !runs) return []
  const ids = new Set<string>()
  for (const k of MCP_PROJECT_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) ids.add(v.trim().toLowerCase())
  }
  if (ids.size === 0) return []
  const detail = `mcp ${mcpShortName(tool)}`
  const hits: Hit[] = []
  for (const [list, kind, name] of [
    [config.neonProjects, 'neon', 'Neon'],
    [config.supabaseProjects, 'supabase', 'Supabase'],
  ] as const) {
    for (const entry of list) {
      if (ids.has(entry.toLowerCase())) hits.push({ key: `${kind}:${entry.toLowerCase()}`, label: `${name} ${entry}`, detail })
    }
  }
  return hits
}

// ── messages ────────────────────────────────────────────────────────────────

/** The reason the model sees when a call is denied. */
export function denyText(hits: Hit[], w: Words): string {
  const first = hits[0]!
  return w.deny(first.label, hits.slice(1).map(h => h.label).join(', '), first.detail)
}

// ── passes (one-time, humans only) ────────────────────────────────────────

export const PASS_TTL_MS = 10 * 60 * 1000
export type PassLike = { key: string; at: number }

export const isLive = (p: PassLike, now: number) => now - p.at <= PASS_TTL_MS && now >= p.at

/**
 * Spends the passes that cover ALL the keys of the block. If any is missing, it spends none.
 * Expired passes are always dropped.
 */
export function spendPasses<T extends PassLike>(passes: T[], keys: string[], now: number): { ok: boolean; left: T[] } {
  const live = passes.filter(p => isLive(p, now))
  const ok = keys.length > 0 && keys.every(k => live.some(p => p.key === k))
  return { ok, left: ok ? live.filter(p => !keys.includes(p.key)) : live }
}

/** Who can give a pass: a person typing (terminal, desktop app through the SDK, or phone), never a plugin or the model. */
export const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

// ── list management (panel) ─────────────────────────────────────────────

export type ConfigEdit =
  | { op: 'addRepo'; slug: string }
  | { op: 'removeRepo'; slug: string }
  | { op: 'addRailway'; name: string }
  | { op: 'removeRailway'; name: string }
  | { op: 'addVercel'; name: string }
  | { op: 'removeVercel'; name: string }
  | { op: 'addNeon'; id: string }
  | { op: 'removeNeon'; id: string }
  | { op: 'addSupabase'; ref: string }
  | { op: 'removeSupabase'; ref: string }

const SLUG = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const without = (list: string[], x: string) => list.filter(v => !same(v, x))

/** Clean "owner/repo" from whatever the person pastes (slug, https or ssh URL); null if it does not look like a GitHub repo. */
export function cleanSlug(input: string): string | null {
  const t = input.trim()
  if (!t || /\s/.test(t)) return null
  const slug = SLUG.test(t) ? t : slugFromUrl(t)
  return slug && SLUG.test(slug) ? slug : null
}

/** Acceptable Railway project name: one line, no "/", up to 100 characters. */
export function cleanRailway(input: string): string | null {
  const t = input.trim()
  return t && t.length <= 100 && !/[/\n\r\t]/.test(t) ? t : null
}

/** Acceptable Vercel project: a name or a `prj_…` id (one line, no "/", up to 100 characters). */
export function cleanVercel(input: string): string | null {
  const t = input.trim()
  return t && t.length <= 100 && !/[/\s]/.test(t) ? t : null
}

/** Acceptable Neon project id: lowercase letters, digits and dashes, 3 to 100 characters (e.g. `proud-cloud-12345678`). */
export function cleanNeon(input: string): string | null {
  const t = input.trim()
  return /^[a-z0-9-]{3,100}$/.test(t) ? t : null
}

/** Acceptable Supabase project ref: exactly 20 lowercase letters a–z. */
export function cleanSupabase(input: string): string | null {
  const t = input.trim()
  return /^[a-z]{20}$/.test(t) ? t : null
}

/**
 * Applies a change to the text of ~/.claude/hands-off.json keeping everything else (`_note`, the person's own keys).
 * With `text` null (it does not exist) it starts from the empty lists. An unreadable file is not overwritten: error.
 */
export function editConfig(text: string | null, edit: ConfigEdit, w: Words): { text: string; config: Config; changed: string } | { error: string } {
  let raw: Record<string, unknown> = { _note: CONFIG_NOTE }
  if (text !== null) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape')
      raw = parsed as Record<string, unknown>
    } catch {
      return { error: w.invalidJson }
    }
  }
  const current = parseConfig(JSON.stringify(raw))
  if (!current) return { error: w.badShape }
  const next: Config = { repos: [...current.repos], railwayProjects: [...current.railwayProjects], vercelProjects: [...current.vercelProjects], neonProjects: [...current.neonProjects], supabaseProjects: [...current.supabaseProjects] }
  let changed = ''

  switch (edit.op) {
    case 'addRepo': {
      const slug = cleanSlug(edit.slug)
      if (!slug) return { error: w.notRepo(edit.slug.trim()) }
      if (next.repos.some(r => same(r, slug))) return { error: w.already(slug) }
      next.repos.push(slug)
      changed = w.added(slug)
      break
    }
    case 'removeRepo': {
      const found = next.repos.find(r => same(r, edit.slug))
      if (!found) return { error: w.absent(edit.slug) }
      next.repos = without(next.repos, found)
      changed = w.removed(found)
      break
    }
    case 'addRailway': {
      const name = cleanRailway(edit.name)
      if (!name) return { error: w.notRailway(edit.name.trim()) }
      if (next.railwayProjects.some(r => same(r, name))) return { error: w.already(`Railway ${name}`) }
      next.railwayProjects.push(name)
      changed = w.added(`Railway ${name}`)
      break
    }
    case 'removeRailway': {
      const found = next.railwayProjects.find(r => same(r, edit.name))
      if (!found) return { error: w.absent(`Railway ${edit.name}`) }
      next.railwayProjects = without(next.railwayProjects, found)
      changed = w.removed(`Railway ${found}`)
      break
    }
    case 'addVercel': {
      const name = cleanVercel(edit.name)
      if (!name) return { error: w.notVercel(edit.name.trim()) }
      if (next.vercelProjects.some(r => same(r, name))) return { error: w.already(`Vercel ${name}`) }
      next.vercelProjects.push(name)
      changed = w.added(`Vercel ${name}`)
      break
    }
    case 'removeVercel': {
      const found = next.vercelProjects.find(r => same(r, edit.name))
      if (!found) return { error: w.absent(`Vercel ${edit.name}`) }
      next.vercelProjects = without(next.vercelProjects, found)
      changed = w.removed(`Vercel ${found}`)
      break
    }
    case 'addNeon': {
      const id = cleanNeon(edit.id)
      if (!id) return { error: w.notNeon(edit.id.trim()) }
      if (next.neonProjects.some(r => same(r, id))) return { error: w.already(`Neon ${id}`) }
      next.neonProjects.push(id)
      changed = w.added(`Neon ${id}`)
      break
    }
    case 'removeNeon': {
      const found = next.neonProjects.find(r => same(r, edit.id))
      if (!found) return { error: w.absent(`Neon ${edit.id}`) }
      next.neonProjects = without(next.neonProjects, found)
      changed = w.removed(`Neon ${found}`)
      break
    }
    case 'addSupabase': {
      const ref = cleanSupabase(edit.ref)
      if (!ref) return { error: w.notSupabase(edit.ref.trim()) }
      if (next.supabaseProjects.some(r => same(r, ref))) return { error: w.already(`Supabase ${ref}`) }
      next.supabaseProjects.push(ref)
      changed = w.added(`Supabase ${ref}`)
      break
    }
    case 'removeSupabase': {
      const found = next.supabaseProjects.find(r => same(r, edit.ref))
      if (!found) return { error: w.absent(`Supabase ${edit.ref}`) }
      next.supabaseProjects = without(next.supabaseProjects, found)
      changed = w.removed(`Supabase ${found}`)
      break
    }
  }
  return { text: `${JSON.stringify({ ...raw, ...next }, null, 2)}\n`, config: next, changed }
}

/** "3 min ago" / "2 h ago" without depending on the time zone. */
export function ago(ms: number, w: Words): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return w.ago.now
  if (min < 60) return w.ago.min(min)
  const h = Math.floor(min / 60)
  return h < 24 ? w.ago.hours(h) : w.ago.days(Math.floor(h / 24))
}

/** Minutes a pass has left (at least 1 while it lives). */
export const minutesLeft = (p: PassLike, now: number) => Math.max(1, Math.ceil((PASS_TTL_MS - (now - p.at)) / 60_000))
