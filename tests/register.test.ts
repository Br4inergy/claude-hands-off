// Hands Off tests against the real engine: `claude plugin test <mod folder>`.
// The hooks of each test sit BELOW the plugin: they answer like the disk, git and the tool, so nothing really runs.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const T0 = 1_790_000_000_000
const MIN = 60_000
const HOME = '/home/user'
const CONFIG_PATH = `${HOME}/.claude/hands-off.json`
const LEGACY_PATH = `${HOME}/.claude/intocables.json`
const RAILWAY_PATH = `${HOME}/.railway/config.json`
const PRESENTATION = { isFullscreen: false, columns: 100 }
const HUMAN = { origin: { kind: 'composer' }, presentation: PRESENTATION } as const
const SDK = { origin: { kind: 'sdk' }, presentation: PRESENTATION } as const
const FROM_PLUGIN = { origin: { kind: 'plugin', name: 'other' }, presentation: PRESENTATION } as const
const OK = { ref: 1, result: { stdout: '', stderr: '', interrupted: false } }

const ORIGINS: Record<string, string> = {
  '/w/fleet': 'https://github.com/acme/api.git',
  '/w/portal': 'git@github.com:acme/web.git',
  '/w/crm': 'git@github.com:acme/crm.git',
  '/w/mine': 'https://github.com/acme/own-app.git',
  '/w/fork': 'https://github.com/someone/api.git',
  '/w/other': 'https://github.com/someone/legacy-app.git',
}
const DIRS = new Set(['/', '/w', '/tmp', '/home', HOME, ...Object.keys(ORIGINS)])
const proc = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** A list file with five repos and one Railway project (the default list is empty, so tests bring their own). */
const BASE = {
  repos: ['acme/api', 'acme/web', 'acme/server', 'acme/platform', 'acme/crm'],
  railwayProjects: ['shop-api'],
  vercelProjects: [] as string[],
  neonProjects: [] as string[],
  supabaseProjects: [] as string[],
}
const listText = (over: Partial<typeof BASE> = {}) => `${JSON.stringify({ _note: 'x', ...BASE, ...over }, null, 2)}\n`
/** The key an older version used, assembled from pieces (the concept no longer exists). */
const OLD_KEY = ['ter', 'ceros'].join('')

type World = {
  cwd: string
  /** Text of ~/.claude/hands-off.json; null = it does not exist. */
  config?: string | null
  /** Text of the previous version's ~/.claude/intocables.json; null = it does not exist. */
  legacy?: string | null
  /** Claude Code's `language` setting. */
  language?: string
  /** LC_ALL / LANG. */
  locale?: string
  railway?: string
  /** dir → content of `<dir>/.vercel/project.json` (linked Vercel project). */
  vercel?: Record<string, string>
  /** dir → content of `<dir>/.neon` (Neon project context). */
  neon?: Record<string, string>
  /** dir → content of `<dir>/supabase/.temp/project-ref` (linked Supabase project). */
  supabase?: Record<string, string>
  failCwd?: boolean
}

/** The fake disk and git + the clock. `seen` = the tools that reached the bottom (the ones Hands Off let through). */
function world(on: On, w: World) {
  const clock = mock.clock(on, { now: T0 })
  const seen: string[] = []
  const toasts: string[] = []
  const commands: { name: string; description: string; argumentHint?: string }[] = []
  const writes: Record<string, string> = {}
  let config = w.config === undefined ? null : w.config
  const legacy = w.legacy === undefined ? null : w.legacy
  const vercelFile = (path: string) => {
    const m = path.match(/^(.*)\/\.vercel\/project\.json$/)
    return m ? w.vercel?.[m[1] || '/'] : undefined
  }
  const neonFile = (path: string) => {
    const m = path.match(/^(.*)\/\.neon$/)
    return m ? w.neon?.[m[1] || '/'] : undefined
  }
  const supabaseFile = (path: string) => {
    const m = path.match(/^(.*)\/supabase\/\.temp\/project-ref$/)
    return m ? w.supabase?.[m[1] || '/'] : undefined
  }
  const rootOf = (path: string) =>
    Object.keys(ORIGINS)
      .filter(r => path === r || path.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)[0]

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    commands.push(e as never)
    return { value: undefined } as never
  })
  on('settings.read', () => ({ value: w.language === undefined ? {} : { language: w.language } }) as never)
  on('env.get', (_$, e) => {
    const name = (e as { name?: string }).name
    return { value: name === 'HOME' ? HOME : name === 'LANG' ? w.locale : undefined } as never
  })
  on('session.cwd', () => (w.failCwd ? { deny: 'boom' } : { value: w.cwd }))
  on('fs.exists', (_$, e) => ({
    value:
      (e.path === CONFIG_PATH && config !== null) ||
      (e.path === LEGACY_PATH && legacy !== null) ||
      (e.path === RAILWAY_PATH && w.railway !== undefined) ||
      vercelFile(e.path) !== undefined ||
      neonFile(e.path) !== undefined ||
      supabaseFile(e.path) !== undefined ||
      DIRS.has(e.path),
  }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.read', (_$, e) => {
    if (e.path === CONFIG_PATH && config !== null) return { value: config }
    if (e.path === LEGACY_PATH && legacy !== null) return { value: legacy }
    if (e.path === RAILWAY_PATH && w.railway !== undefined) return { value: w.railway }
    const vercel = vercelFile(e.path)
    if (vercel !== undefined) return { value: vercel }
    const neon = neonFile(e.path)
    if (neon !== undefined) return { value: neon }
    const supabase = supabaseFile(e.path)
    if (supabase !== undefined) return { value: supabase }
    return { deny: 'ENOENT' }
  })
  on('fs.write', (_$, e) => {
    writes[e.path] = e.text
    if (e.path === CONFIG_PATH) config = e.text
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const [bin, flag, dir = '', , , name = ''] = e.argv
    const root = rootOf(dir)
    if (bin !== 'git' || flag !== '-C' || !root || name !== 'origin') return proc(1)
    return proc(0, `${ORIGINS[root]}\n`)
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', (_$, e) => {
    seen.push(e.tool === 'Bash' ? `Bash:${e.command}` : e.tool)
    return e.tool === 'Bash' ? OK : { result: {} }
  })
  return { setConfig: (text: string | null) => { config = text }, clock, seen, toasts, writes, commands }
}

const start = ($: Engine) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
const bash = (command: string) => ({ tool: 'Bash', command }) as const
const pass = (args = '', who: typeof HUMAN | typeof SDK | typeof FROM_PLUGIN = HUMAN, verb = 'pass') => ({ command: 'handsoff', args: `${verb} ${args}`.trim(), ...who })
const summary = ($: Engine, args = '') => $.command.run({ command: 'handsoff', args, ...HUMAN })

// ── language ────────────────────────────────────────────────────────────────

test('Spanish: settings.language "español" gives Spanish texts and the intocables alias', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText(), language: 'español' })
  await start($)
  const out = await $.tool.call(bash('git commit -m "x"'))
  expect(out.deny).toContain('Intocables: acme/api está protegido — leer sí, escribir no.')
  expect(out.deny).toContain('/intocables pase')
  expect(out.deny).toContain('[bloqueado: git commit]')
  expect(w.toasts.join('\n')).toContain('Intocables bloqueó git commit en acme/api')
  expect(w.commands.map(c => c.name)).toEqual(['handsoff', 'intocables'])
  expect(w.commands[1]!.description).toContain('leer sí, escribir no')
  expect(w.commands[1]!.argumentHint).toBe('[estado | pase [owner/repo]]')
  expect(w.commands[1]!.description).toBe(w.commands[0]!.description)
})

test('Spanish: settings.language "es" does the same', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText(), language: 'es' })
  await start($)
  expect(w.commands.map(c => c.name)).toEqual(['handsoff', 'intocables'])
  expect((await $.tool.call(bash('git commit -m x'))).deny).toContain('Intocables: acme/api está protegido')
})

test('Spanish: the alias answers like handsoff, with Spanish verbs and replies', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: listText(), language: 'español' })
  await start($)
  const status = (await $.command.run({ command: 'intocables', args: 'estado', ...HUMAN })).text ?? ''
  expect(status).toContain('Intocables: leer sí, escribir no.')
  expect(status).toContain('Repos protegidos (5): acme/api')
  expect(status).toContain('Sin pases activos')
  expect((await $.command.run({ command: 'intocables', args: 'pase acme/api', ...HUMAN })).text).toContain('pase de una vez para acme/api')
  expect((await $.command.run({ command: 'intocables', args: 'pase', ...FROM_PLUGIN })).text).toBe('Intocables: los pases solo los da una persona, tecleándolos en el prompt.')
  expect((await $.command.run({ command: 'handsoff', args: 'status', ...HUMAN })).text).toContain('Pases activos')
  expect((await $.command.run({ command: 'intocables', args: 'pase nada', ...HUMAN })).text).toContain('no está en la lista protegida')
})

test('English is the default; the locale decides when Claude Code has no language setting', async ($, on) => {
  const plain = world(on, { cwd: '/w/fleet', config: listText() })
  await start($)
  const out = await $.tool.call(bash('git commit -m x'))
  expect(out.deny).toContain('Hands Off: acme/api is protected — read yes, write no.')
  expect(plain.commands.map(c => c.name)).toEqual(['handsoff'])
  expect(plain.commands[0]!.description).toContain('read yes, write no')
  expect(plain.commands[0]!.argumentHint).toBe('[status | pass [owner/repo]]')
})

test('the locale (LANG) picks Spanish when there is no language setting', async ($, on) => {
  const es = world(on, { cwd: '/w/fleet', config: listText(), locale: 'es_MX.UTF-8' })
  await start($)
  expect(es.commands.map(c => c.name)).toEqual(['handsoff', 'intocables'])
  expect((await $.tool.call(bash('git commit -m x'))).deny).toContain('Intocables: acme/api está protegido')
})

test('an English setting wins over a Spanish locale: no alias', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText(), language: 'English', locale: 'es_ES.UTF-8' })
  await start($)
  expect(w.commands.map(c => c.name)).toEqual(['handsoff'])
  expect((await $.tool.call(bash('git commit -m x'))).deny).toContain('Hands Off: acme/api is protected')
})

test('with no session.start the language is still looked up (Spanish from the setting)', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: listText(), language: 'es' })
  expect((await $.tool.call(bash('git commit -m x'))).deny).toContain('está protegido')
})

// ── verbs ───────────────────────────────────────────────────────────────────

test('pass and pase are the same verb; status and estado too; no verb opens the panel', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  await start($)
  for (const verb of ['pass', 'pase', 'PASS']) {
    expect((await $.tool.call(bash('git commit -m x'))).deny).toBeDefined()
    const granted = await $.command.run(pass('', HUMAN, verb))
    expect([verb, granted.text]).toEqual([verb, expect.stringContaining('one-time pass for acme/api')])
    expect((await $.tool.call(bash('git commit -m y'))).deny).toBeUndefined()
  }
  expect(w.seen.length).toBe(3)
  const a = (await summary($, 'status')).text
  const b = (await summary($, 'estado')).text
  expect(a).toBeDefined()
  expect(a).toBe(b)
  expect(a).toContain('Protected repos (5): acme/api, acme/web, acme/server, acme/platform, acme/crm.')
  // No verb: no panel is placed in the test engine, so the summary comes back as text.
  expect((await summary($, '')).text).toBe(a)
})

// ── protection ──────────────────────────────────────────────────────────────

test('Bash that writes to a protected repo is denied with the reason and never runs', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  const out = await $.tool.call(bash('git commit -m "x"'))
  expect(out.deny).toBe(
    'Hands Off: acme/api is protected — read yes, write no. If it needs a change, ask its owner. ' +
      'For a one-time exception a person must type /handsoff pass. Do not work around this with another command. [blocked: git commit]',
  )
  expect(w.seen).toEqual([])
  expect(w.toasts.join('\n')).toContain('/handsoff pass')
  // Reads are fine.
  for (const command of ['git log --oneline', 'git status', 'cat README.md', 'gh pr list']) {
    expect((await $.tool.call(bash(command))).deny).toBeUndefined()
  }
  expect(w.seen).toEqual(['Bash:git log --oneline', 'Bash:git status', 'Bash:cat README.md', 'Bash:gh pr list'])
})

test('an own repo, my fork and unrelated folders pass', async ($, on) => {
  const w = world(on, { cwd: '/w/mine', config: listText() })
  for (const cwd of ['/w/mine', '/w/fork', '/w/other']) {
    expect((await $.tool.call(bash(`git -C ${cwd} commit -m x`))).deny).toBeUndefined()
  }
  expect((await $.tool.call(bash('gh pr create --fill'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('vercel --prod'))).deny).toBeUndefined()
  expect(w.seen.length).toBe(5)
})

test('the slug inside a heredoc or a message does not block', async ($, on) => {
  const w = world(on, { cwd: '/w/mine', config: listText() })
  const cmd = 'git commit -m "$(cat <<\'EOF\'\nDo not touch acme/api (git push, gh pr merge -R acme/api)\nEOF\n)"'
  expect((await $.tool.call(bash(cmd))).deny).toBeUndefined()
  expect(w.seen.length).toBe(1)
})

test('Edit and Write inside a protected repo are denied (even if the folder does not exist); own files pass', async ($, on) => {
  const w = world(on, { cwd: '/w/mine', config: listText() })
  const write = await $.tool.call({ tool: 'Write', file_path: '/w/fleet/src/new/a.ts', content: 'x' })
  expect(write.deny).toContain('acme/api is protected')
  expect(write.deny).toContain('[blocked: edit of a.ts]')
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/w/portal/a.ts', old_string: 'a', new_string: 'b' })
  expect(edit.deny).toContain('acme/web')
  expect((await $.tool.call({ tool: 'Write', file_path: '/w/mine/a.ts', content: 'x' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/tmp/a.ts', content: 'x' })).deny).toBeUndefined()
  expect(w.seen).toEqual(['Write', 'Write'])
})

test('a plugin (or the model) cannot give itself a pass', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeDefined()
  const out = await $.command.run(pass('', FROM_PLUGIN))
  expect(out.text).toBe('Hands Off: Only a person can give a pass, typing it at the prompt.')
  expect((await $.command.run(pass('', FROM_PLUGIN, 'pase'))).text).toContain('Only a person can give a pass')
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeDefined()
  expect(w.seen).toEqual([])
})

test('a person\'s pass lets exactly ONE call through and the next one is denied again', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  expect((await $.tool.call(bash('git commit -m one'))).deny).toBeDefined()
  const granted = await $.command.run(pass())
  expect(granted.text).toContain('one-time pass for acme/api')
  expect((await $.tool.call(bash('git commit -m two'))).deny).toBeUndefined()
  expect(w.toasts.join('\n')).toContain('pass used')
  expect((await $.tool.call(bash('git commit -m three'))).deny).toBeDefined()
  expect(w.seen).toEqual(['Bash:git commit -m two'])
})

test('the pass only covers the blocked repo, and also works from the SDK (-p)', async ($, on) => {
  const w = world(on, { cwd: '/w/mine', config: listText() })
  expect((await $.tool.call(bash('git -C /w/fleet commit -m x'))).deny).toBeDefined()
  await $.command.run(pass('', SDK))
  const portal = await $.tool.call(bash('git -C /w/portal commit -m x'))
  expect(portal.deny).toContain('acme/web')
  expect((await $.tool.call(bash('git -C /w/fleet commit -m x'))).deny).toBeUndefined()
  expect(w.seen).toEqual(['Bash:git -C /w/fleet commit -m x'])
})

test('a command that touches two protected repos needs the pass for both', async ($, on) => {
  const w = world(on, { cwd: '/w/mine', config: listText() })
  const both = 'git -C /w/fleet commit -m a && git -C /w/portal commit -m b'
  const denied = await $.tool.call(bash(both))
  expect(denied.deny).toContain('acme/api is protected — read yes, write no (also: acme/web).')
  await $.command.run(pass())
  expect((await $.tool.call(bash(both))).deny).toBeUndefined()
  expect((await $.tool.call(bash(both))).deny).toBeDefined()
  expect(w.seen.length).toBe(1)
})

test('the pass expires after 10 minutes', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  expect((await $.tool.call(bash('git push'))).deny).toBeDefined()
  await $.command.run(pass())
  await w.clock.advance(10 * MIN + 1000)
  expect((await $.tool.call(bash('git push'))).deny).toBeDefined()
  expect(w.seen).toEqual([])
  // And a fresh pass, inside the window, works.
  await $.command.run(pass())
  await w.clock.advance(9 * MIN)
  expect((await $.tool.call(bash('git push'))).deny).toBeUndefined()
})

test('/handsoff pass with no recent block asks for the repo; with the slug it grants in advance; an unknown one is refused', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  expect((await $.command.run(pass())).text).toContain('there is no recent block')
  const unknown = (await $.command.run(pass('acme/nope'))).text ?? ''
  expect(unknown).toContain('"acme/nope" is not in the protected list')
  expect(unknown).toContain('acme/api')
  expect((await $.command.run(pass('ACME/api'))).text).toContain('one-time pass for acme/api')
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('git commit -m y'))).deny).toBeDefined()
  expect(w.seen.length).toBe(1)
})

test('/handsoff status lists what is protected and the active passes', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: listText() })
  const before = (await summary($, 'status')).text ?? ''
  expect(before).toContain('acme/api')
  expect(before).toContain('acme/crm')
  expect(before).toContain('Railway projects: shop-api.')
  expect(before).not.toContain('own-app')
  expect(before).toContain('No active passes')
  await $.command.run(pass('acme/api'))
  expect((await summary($, 'status')).text).toContain('Active passes')
})

test('if the rule fails, the call goes through and the person is told once', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText(), failCwd: true })
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/w/fleet/a.ts', content: 'x' })).deny).toBeUndefined()
  expect(w.seen.length).toBe(2)
  expect(w.toasts.filter(t => t.includes('the call was let through')).length).toBe(1)
})

test('if the rule fails in Spanish, the notice is in Spanish', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText(), failCwd: true, language: 'es' })
  await start($)
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeUndefined()
  expect(w.toasts.filter(t => t.includes('dejé pasar la llamada')).length).toBe(1)
})

// ── the list file ───────────────────────────────────────────────────────────

test('the list lives in ~/.claude/hands-off.json: created with empty lists and a note when neither file exists', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: null, legacy: null })
  // Nothing is protected by default.
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeUndefined()
  const created = JSON.parse(w.writes[CONFIG_PATH] ?? '{}') as Record<string, unknown>
  expect(created).toEqual({
    _note: expect.stringContaining('Hands Off'),
    repos: [],
    railwayProjects: [],
    vercelProjects: [],
    neonProjects: [],
    supabaseProjects: [],
  })
  expect(created).not.toHaveProperty('_nota')
  expect(w.writes[LEGACY_PATH]).toBeUndefined()
})

test('migration: with no hands-off.json and an old intocables.json, the new file is written from the old one and the old stays untouched', async ($, on) => {
  const legacy = JSON.stringify(
    { _nota: 'old note', repos: ['someone/legacy-app', 'acme/api'], [OLD_KEY]: ['acme/api'], railwayProjects: ['shop-api'], vercelProjects: ['locked-app'], mine: { keep: true } },
    null,
    2,
  )
  const w = world(on, { cwd: '/w/other', config: null, legacy })
  const out = await $.tool.call(bash('git commit -m x'))
  expect(out.deny).toContain('someone/legacy-app is protected')
  const written = JSON.parse(w.writes[CONFIG_PATH] ?? '{}') as Record<string, unknown>
  expect(written.repos).toEqual(['someone/legacy-app', 'acme/api'])
  expect(written.railwayProjects).toEqual(['shop-api'])
  expect(written.vercelProjects).toEqual(['locked-app'])
  expect(written.neonProjects).toEqual([])
  expect(written.mine).toEqual({ keep: true })
  expect(typeof written._note).toBe('string')
  expect(written).not.toHaveProperty('_nota')
  // The old file is never written.
  expect(w.writes[LEGACY_PATH]).toBeUndefined()
  expect(Object.keys(w.writes)).toEqual([CONFIG_PATH])
})

test('migration happens once: an existing hands-off.json wins and the old file is ignored', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText({ repos: ['someone/legacy-app'] }), legacy: JSON.stringify({ repos: ['acme/api'] }) })
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('migration: an unreadable old file is not imported; the new file starts empty and the person is told', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: null, legacy: '{ not json' })
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeUndefined()
  expect(JSON.parse(w.writes[CONFIG_PATH] ?? '{}')).toMatchObject({ repos: [] })
  expect(w.toasts.join('\n')).toContain('intocables.json could not be read')
  expect(w.writes[LEGACY_PATH]).toBeUndefined()
})

test('an edited list rules and is not rewritten; an old key in it is ignored', async ($, on) => {
  const custom = world(on, { cwd: '/w/fleet', config: JSON.stringify({ repos: ['someone/legacy-app'], [OLD_KEY]: ['someone/legacy-app'], railwayProjects: [] }) })
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('git -C /w/other commit -m x'))).deny).toContain('someone/legacy-app is protected')
  expect(custom.writes[CONFIG_PATH]).toBeUndefined()
})

test('a corrupt list: nothing is protected, the person is told once, and the file is not rewritten', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: '{ not json' })
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('git commit -m y'))).deny).toBeUndefined()
  expect(w.toasts.filter(t => t.includes('hands-off.json could not be read')).length).toBe(1)
  expect(w.writes[CONFIG_PATH]).toBeUndefined()
})

test('Railway: the project linked in ~/.railway/config.json counts even if the folder is not a protected repo', async ($, on) => {
  const railway = JSON.stringify({ projects: { '/w/other': { name: 'shop-api' }, '/w/mine': { name: 'bob' } } })
  const w = world(on, { cwd: '/w/other', config: listText(), railway })
  const up = await $.tool.call(bash('railway up'))
  expect(up.deny).toContain('Railway shop-api is protected')
  expect((await $.tool.call(bash('railway status'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('railway logs'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('cd /w/mine && railway up'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('railway link -p shop-api'))).deny).toBeDefined()
  expect(w.seen.length).toBe(3)
})

// ── Vercel ──────────────────────────────────────────────────────────────────

const withVercel = (...names: string[]) => listText({ vercelProjects: names })
const projectJson = (projectName: string, projectId: string) => JSON.stringify({ projectId, orgId: 'team_1', projectName })

test('Vercel: the linked protected project (.vercel/project.json) is denied, by name or by id; reads and other projects pass', async ($, on) => {
  const vercel = { '/w/other': projectJson('locked-app', 'prj_abc123'), '/w/mine': projectJson('free-app', 'prj_zzz') }
  const w = world(on, { cwd: '/w/other/app/src', config: withVercel('locked-app'), vercel })
  const deploy = await $.tool.call(bash('vercel deploy --prod'))
  expect(deploy.deny).toContain('Vercel locked-app is protected')
  expect(deploy.deny).toContain('/handsoff pass')
  expect((await $.tool.call(bash('vercel env add FOO'))).deny).toContain('Vercel locked-app')
  expect((await $.tool.call(bash('vercel link --project locked-app'))).deny).toContain('Vercel locked-app')
  for (const cmd of ['vercel ls', 'vercel logs x', 'vercel inspect x', 'cd /w/mine && vercel --prod']) {
    expect([cmd, (await $.tool.call(bash(cmd))).deny]).toEqual([cmd, undefined])
  }
  expect(w.seen.length).toBe(4)
  expect(w.toasts.join('\n')).toContain('Vercel locked-app')
})

test('Vercel: a prj_… entry matches the projectId; a broken or missing project.json neither blocks nor blows up', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: withVercel('PRJ_ABC123'), vercel: { '/w/other': projectJson('anything', 'prj_abc123'), '/w/mine': '{ broken' } })
  expect((await $.tool.call(bash('vercel --prod'))).deny).toContain('Vercel PRJ_ABC123')
  expect((await $.tool.call(bash('cd /w/mine && vercel --prod'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('cd /w/fork && vercel --prod'))).deny).toBeUndefined()
  expect(w.seen.length).toBe(2)
})

test('Vercel: /handsoff pass <name> lets exactly one call through; an unknown name lists everything', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: withVercel('locked-app'), vercel: { '/w/other': projectJson('locked-app', 'prj_abc123') } })
  expect((await $.tool.call(bash('vercel --prod'))).deny).toBeDefined()
  const unknown = await $.command.run(pass('nothing'))
  expect(unknown.text).toContain('is not in the protected list')
  expect(unknown.text).toContain('Vercel locked-app')
  expect(unknown.text).toContain('Railway shop-api')
  expect(unknown.text).toContain('acme/api')
  expect((await $.command.run(pass('locked-app', FROM_PLUGIN))).text).toContain('Only a person can give a pass')
  const granted = await $.command.run(pass('locked-app'))
  expect(granted.text).toContain('Vercel locked-app')
  expect((await $.tool.call(bash('vercel --prod'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('vercel --prod'))).deny).toBeDefined()
  expect(w.seen).toEqual(['Bash:vercel --prod'])
  await $.command.run(pass('vercel:LOCKED-APP'))
  expect((await $.tool.call(bash('vercel deploy'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('vercel deploy'))).deny).toBeDefined()
  // The text summary lists the Vercel projects.
  expect((await summary($, 'status')).text).toContain('Vercel projects: locked-app.')
})

// ── panel ───────────────────────────────────────────────────────────────────

const PANE_PROPS = { title: 'Hands Off', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const
const mountPane = <P extends 'terminal' | 'desktop' | 'mobile' = 'terminal'>($: Engine, surface: P = 'terminal' as P) =>
  $.ui.mount({ plugin: 'hands-off', surface, component: 'Pane', props: PANE_PROPS, requestId: 'hands-off' })
const saved = (w: { writes: Record<string, string> }) =>
  JSON.parse(w.writes[CONFIG_PATH] ?? '{}') as {
    _note?: string
    repos: string[]
    railwayProjects: string[]
    vercelProjects: string[]
    neonProjects: string[]
    supabaseProjects: string[]
  }

test('panel: shows what is protected, the kind, and the session\'s blocks', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: listText() })
  await summary($)
  await $.tool.call(bash('git push'))
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /acme\/api/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /GitHub/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5 repos · 1 Railway · 0 Vercel · 0 Neon · 0 Supabase · 0 active passes · 1 block in this session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 block · last just now/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Recent block on acme\/api/ })).toBeDefined()
  await ui.unmount()
})

test('panel: with the default (empty) list it says nothing is protected', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: null })
  await summary($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /The list is empty: nothing is protected/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 repos · 0 Railway/ })).toBeDefined()
  await ui.unmount()
})

test('panel: in Spanish it speaks Spanish', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: listText(), language: 'español' })
  await start($)
  await $.tool.call(bash('git push'))
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /Intocables · leer sí, escribir no/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5 repos · 1 Railway · 0 Vercel · 0 Neon · 0 Supabase · 0 pases activos · 1 bloqueo en esta sesión/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 bloqueo · último ahora/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Bloqueo reciente en acme\/api/ })).toBeDefined()
  await ui.unmount()
})

test('panel: the pass button lets one call through and can be revoked', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  await summary($)
  const ui = await mountPane($)
  await ui.press({ key: 'repo-0-pass' })
  expect(await ui.find({ type: 'Text', text: /pass · 10 min/ })).toBeDefined()
  await ui.press({ key: 'repo-0-revoke' })
  expect((await $.tool.call(bash('git commit -m x'))).deny).toBeDefined()
  await ui.press({ key: 'repo-0-pass' })
  expect((await $.tool.call(bash('git commit -m y'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('git commit -m z'))).deny).toBeDefined()
  expect(w.seen.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /↷ pass/ })).toBeDefined()
  await ui.unmount()
})

test('panel: "Give pass and retry" covers the last block', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: listText() })
  await summary($)
  expect((await $.tool.call(bash('git push'))).deny).toBeDefined()
  const ui = await mountPane($)
  await ui.press({ key: 'last-pass' })
  expect((await $.tool.call(bash('git push'))).deny).toBeUndefined()
  await ui.unmount()
})

test('panel: adding and removing repos edits the file without losing the note, and the rule respects it', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: listText() })
  await summary($)
  expect((await $.tool.call(bash('git commit -m a'))).deny).toBeUndefined()
  const ui = await mountPane($)
  await ui.input({ key: 'add-repo', text: 'https://github.com/someone/legacy-app.git' })
  expect(saved(w).repos).toContain('someone/legacy-app')
  expect(saved(w)._note).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /someone\/legacy-app added/ })).toBeDefined()
  expect((await $.tool.call(bash('git commit -m b'))).deny).toContain('someone/legacy-app')
  // Removing asks for confirmation.
  await ui.press({ key: 'repo-5-more' })
  await ui.press({ key: 'repo-5-remove' })
  expect(saved(w).repos).toContain('someone/legacy-app')
  await ui.press({ key: 'repo-5-remove' })
  expect(saved(w).repos).not.toContain('someone/legacy-app')
  expect((await $.tool.call(bash('git commit -m c'))).deny).toBeUndefined()
  await ui.unmount()
})

test('panel: there is no "third party" toggle; invalid or duplicate entries do not touch the file', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  await summary($)
  const ui = await mountPane($)
  await ui.press({ key: 'repo-0-more' })
  expect(await ui.find({ key: 'repo-0-toggle' })).toBeUndefined()
  const before = w.writes[CONFIG_PATH]
  await ui.input({ key: 'add-repo', text: 'not a repo' })
  await ui.input({ key: 'add-repo', text: 'ACME/WEB' })
  await ui.input({ key: 'add-railway', text: 'shop-api' })
  expect(w.writes[CONFIG_PATH]).toBe(before)
  expect(await ui.find({ type: 'Text', text: /is already in the list/ })).toBeDefined()
  await ui.unmount()
})

test('panel: a corrupt file is not overwritten from the panel', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: '{ not json' })
  await summary($)
  const ui = await mountPane($)
  await ui.input({ key: 'add-railway', text: 'bob' })
  expect(w.writes[CONFIG_PATH]).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /not valid JSON/ })).toBeDefined()
  await ui.unmount()
})

test('panel: on the phone it is drawn without text fields', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: listText() })
  await summary($)
  const ui = await mountPane($, 'mobile')
  expect(await ui.find({ type: 'Text', text: /use the panel in the terminal or the desktop app/ })).toBeDefined()
  await ui.unmount()
})

test('panel: shows the Vercel card and adding from "add-vercel" writes vercelProjects to the list', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: withVercel('locked-app'), vercel: { '/w/other': projectJson('new-app', 'prj_new1') } })
  await summary($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /Vercel locked-app/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5 repos · 1 Railway · 1 Vercel · 0 Neon · 0 Supabase · 0 active passes/ })).toBeDefined()
  expect((await $.tool.call(bash('vercel --prod'))).deny).toBeUndefined()
  await ui.input({ key: 'add-vercel', text: 'prj_new1' })
  expect(saved(w).vercelProjects).toEqual(['locked-app', 'prj_new1'])
  expect(saved(w)._note).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Vercel prj_new1 added/ })).toBeDefined()
  expect((await $.tool.call(bash('vercel --prod'))).deny).toContain('Vercel prj_new1')
  // Duplicate and invalid entries do not touch the file.
  const before = w.writes[CONFIG_PATH]
  await ui.input({ key: 'add-vercel', text: 'LOCKED-APP' })
  await ui.input({ key: 'add-vercel', text: 'a/b' })
  expect(w.writes[CONFIG_PATH]).toBe(before)
  // Pass from the card, and removal with confirmation.
  await ui.press({ key: 'vercel-1-pass' })
  expect((await $.tool.call(bash('vercel --prod'))).deny).toBeUndefined()
  await ui.press({ key: 'vercel-1-more' })
  await ui.press({ key: 'vercel-1-remove' })
  expect(saved(w).vercelProjects).toEqual(['locked-app', 'prj_new1'])
  await ui.press({ key: 'vercel-1-remove' })
  expect(saved(w).vercelProjects).toEqual(['locked-app'])
  expect((await $.tool.call(bash('vercel --prod'))).deny).toBeUndefined()
  await ui.unmount()
})

test('/handsoff with the panel in view leaves no text in the conversation; /handsoff status does', async ($, on) => {
  world(on, { cwd: '/w/fleet', config: listText() })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  expect((await summary($)).text).toBeUndefined()
  expect((await summary($, 'status')).text).toContain('acme/api')
})

// ── Neon and Supabase ───────────────────────────────────────────────────────

const NEON_ID = 'proud-cloud-12345678'
const REF = 'abcdefghijklmnopqrst'
const withNeonSupabase = (neon: string[], supabase: string[]) => listText({ neonProjects: neon, supabaseProjects: supabase })
const mcp = (tool: string, input: Record<string, unknown>) => ({ tool, ...input }) as never

test('Neon: nx with a protected --project-id is denied with "Neon <id>"; so is the .neon context; reads and other projects pass', async ($, on) => {
  const w = world(on, { cwd: '/w/other/app', config: withNeonSupabase([NEON_ID], []), neon: { '/w/other': JSON.stringify({ projectId: NEON_ID, orgId: 'org-1' }) } })
  const byFlag = await $.tool.call(bash(`nx branches create --project-id ${NEON_ID}`))
  expect(byFlag.deny).toContain(`Neon ${NEON_ID} is protected`)
  expect(byFlag.deny).toContain('/handsoff pass')
  expect((await $.tool.call(bash('nx branches delete dev'))).deny).toContain(`Neon ${NEON_ID}`)
  expect((await $.tool.call(bash('npx neonctl projects delete'))).deny).toContain(`Neon ${NEON_ID}`)
  for (const cmd of ['nx branches list', 'nx connection-string', 'nx projects list', 'nx branches create --project-id other-id-12345678', 'git status']) {
    expect([cmd, (await $.tool.call(bash(cmd))).deny]).toEqual([cmd, undefined])
  }
  expect(w.seen.length).toBe(5)
  expect(w.toasts.join('\n')).toContain(`Neon ${NEON_ID}`)
})

test('Supabase: the linked ref or a protected --project-ref is denied; reads and local reset pass', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: withNeonSupabase([], [REF]), supabase: { '/w/other': `${REF}\n` } })
  expect((await $.tool.call(bash('supabase db push'))).deny).toContain(`Supabase ${REF} is protected`)
  expect((await $.tool.call(bash('supabase db reset --linked'))).deny).toContain(`Supabase ${REF}`)
  expect((await $.tool.call(bash(`supabase functions deploy x --project-ref ${REF}`))).deny).toContain(`Supabase ${REF}`)
  for (const cmd of ['supabase db pull', 'supabase status', 'supabase gen types typescript --linked', 'supabase functions list', 'supabase db reset']) {
    expect([cmd, (await $.tool.call(bash(cmd))).deny]).toEqual([cmd, undefined])
  }
  expect(w.seen.length).toBe(5)
})

test('MCP: a write on a protected Neon project is denied and never reaches the bottom; reads pass', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: withNeonSupabase([NEON_ID], [REF]) })
  const sql = await $.tool.call(mcp('mcp__Neon__run_sql', { projectId: NEON_ID, sql: 'drop table x' }))
  expect(sql.deny).toContain(`Neon ${NEON_ID} is protected — read yes, write no`)
  expect(sql.deny).toContain('[blocked: mcp run_sql]')
  expect(sql.deny).toContain('/handsoff pass')
  expect(w.seen).toEqual([])
  expect(w.toasts.join('\n')).toContain('/handsoff pass')
  expect((await $.tool.call(mcp('mcp__supabase__execute_sql', { project_id: REF, query: 'delete from t' }))).deny).toContain(`Supabase ${REF}`)
  expect((await $.tool.call(mcp('mcp__supabase__apply_migration', { project_id: REF, name: 'x', query: 'select 1' }))).deny).toContain('mcp apply_migration')
  for (const [tool, input] of [
    ['mcp__Neon__get_project', { projectId: NEON_ID }],
    ['mcp__Neon__list_branches', { projectId: NEON_ID }],
    ['mcp__supabase__list_tables', { project_id: REF }],
    ['mcp__Neon__run_sql', { projectId: 'other-id-12345678', sql: 'select 1' }],
    ['mcp__Neon__run_sql', { sql: 'select 1' }],
  ] as const) {
    expect([tool, (await $.tool.call(mcp(tool, input))).deny]).toEqual([tool, undefined])
  }
  expect(w.seen).toEqual(['mcp__Neon__get_project', 'mcp__Neon__list_branches', 'mcp__supabase__list_tables', 'mcp__Neon__run_sql', 'mcp__Neon__run_sql'])
  // Other (non-MCP) tools are left alone.
  expect((await $.tool.call({ tool: 'Write', file_path: '/tmp/a.ts', content: 'x' })).deny).toBeUndefined()
})

test('MCP: a person\'s pass lets exactly one write through; /handsoff pass accepts neon:<id>, supabase:<ref> or the bare id', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: withNeonSupabase([NEON_ID], [REF]) })
  const write = () => $.tool.call(mcp('mcp__Neon__run_sql', { projectId: NEON_ID, sql: 'update t set a = 1' }))
  expect((await write()).deny).toBeDefined()
  expect((await $.command.run(pass(`neon:${NEON_ID}`, FROM_PLUGIN))).text).toContain('Only a person can give a pass')
  expect((await write()).deny).toBeDefined()
  // After the block, the pass with no arguments covers the last one.
  const granted = await $.command.run(pass())
  expect(granted.text).toContain(`Neon ${NEON_ID}`)
  expect((await write()).deny).toBeUndefined()
  expect((await write()).deny).toBeDefined()
  expect(w.seen).toEqual(['mcp__Neon__run_sql'])
  expect(w.toasts.join('\n')).toContain('pass used')
  // In advance, with the prefix and in capitals.
  expect((await $.command.run(pass(`NEON:${NEON_ID.toUpperCase()}`))).text).toContain(`one-time pass for Neon ${NEON_ID}`)
  expect((await write()).deny).toBeUndefined()
  expect((await write()).deny).toBeDefined()
  // Supabase: with the prefix and with the bare ref; one's pass does not cover the other.
  const sb = () => $.tool.call(mcp('mcp__supabase__execute_sql', { project_id: REF, query: 'delete from t' }))
  await $.command.run(pass(`supabase:${REF}`))
  expect((await write()).deny).toBeDefined()
  expect((await sb()).deny).toBeUndefined()
  expect((await sb()).deny).toBeDefined()
  expect((await $.command.run(pass(REF))).text).toContain(`Supabase ${REF}`)
  expect((await sb()).deny).toBeUndefined()
  expect(w.seen.length).toBe(4)
  // An unknown id lists everything.
  const unknown = (await $.command.run(pass('nothing'))).text ?? ''
  expect(unknown).toContain('is not in the protected list')
  expect(unknown).toContain(`Neon ${NEON_ID}`)
  expect(unknown).toContain(`Supabase ${REF}`)
  expect(unknown).toContain('Railway shop-api')
})

test('Neon and Supabase through Bash: a pass lets a single call through', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: withNeonSupabase([NEON_ID], [REF]), neon: { '/w/other': JSON.stringify({ projectId: NEON_ID }) } })
  expect((await $.tool.call(bash('nx branches create'))).deny).toBeDefined()
  await $.command.run(pass())
  expect((await $.tool.call(bash('nx branches create'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('nx branches create'))).deny).toBeDefined()
  expect(w.seen).toEqual(['Bash:nx branches create'])
})

test('the text status lists the Neon and Supabase projects', async ($, on) => {
  world(on, { cwd: '/w/other', config: withNeonSupabase([NEON_ID], [REF]) })
  const text = (await summary($, 'status')).text ?? ''
  expect(text).toContain(`Neon projects: ${NEON_ID}.`)
  expect(text).toContain(`Supabase projects: ${REF}.`)
})

test('the text status does not mention Neon or Supabase while their lists are empty', async ($, on) => {
  world(on, { cwd: '/w/other', config: listText() })
  const plain = (await summary($, 'status')).text ?? ''
  expect(plain).not.toContain('Neon projects')
  expect(plain).not.toContain('Supabase projects')
})

test('the text status with nothing protected says so', async ($, on) => {
  world(on, { cwd: '/w/other', config: null })
  const text = (await summary($, 'status')).text ?? ''
  expect(text).toContain('Nothing is protected yet')
  expect(text).not.toContain('Protected repos')
})

test('panel: shows the Neon and Supabase cards; add-neon and add-supabase write the list; duplicates and invalid ones leave it alone', async ($, on) => {
  const w = world(on, { cwd: '/w/other', config: withNeonSupabase([NEON_ID], [REF]) })
  await summary($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: new RegExp(`Neon ${NEON_ID}`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`Supabase ${REF}`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5 repos · 1 Railway · 0 Vercel · 1 Neon · 1 Supabase · 0 active passes/ })).toBeDefined()
  await ui.input({ key: 'add-neon', text: 'free-river-99999999' })
  expect(saved(w).neonProjects).toEqual([NEON_ID, 'free-river-99999999'])
  expect(saved(w)._note).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Neon free-river-99999999 added/ })).toBeDefined()
  await ui.input({ key: 'add-supabase', text: 'zzzzzzzzzzzzzzzzzzzz' })
  expect(saved(w).supabaseProjects).toEqual([REF, 'zzzzzzzzzzzzzzzzzzzz'])
  expect(await ui.find({ type: 'Text', text: /Supabase zzzzzzzzzzzzzzzzzzzz added/ })).toBeDefined()
  expect((await $.tool.call(mcp('mcp__Neon__run_sql', { projectId: 'free-river-99999999' }))).deny).toContain('Neon free-river-99999999')
  const before = w.writes[CONFIG_PATH]
  await ui.input({ key: 'add-neon', text: NEON_ID.toUpperCase() })
  await ui.input({ key: 'add-neon', text: 'With Space' })
  await ui.input({ key: 'add-supabase', text: REF })
  await ui.input({ key: 'add-supabase', text: 'short' })
  expect(w.writes[CONFIG_PATH]).toBe(before)
  // Pass from the card, and removal with confirmation.
  await ui.press({ key: 'neon-1-pass' })
  expect((await $.tool.call(mcp('mcp__Neon__run_sql', { projectId: 'free-river-99999999' }))).deny).toBeUndefined()
  await ui.press({ key: 'neon-1-more' })
  await ui.press({ key: 'neon-1-remove' })
  expect(saved(w).neonProjects).toEqual([NEON_ID, 'free-river-99999999'])
  await ui.press({ key: 'neon-1-remove' })
  expect(saved(w).neonProjects).toEqual([NEON_ID])
  await ui.press({ key: 'supabase-1-more' })
  await ui.press({ key: 'supabase-1-remove' })
  await ui.press({ key: 'supabase-1-remove' })
  expect(saved(w).supabaseProjects).toEqual([REF])
  await ui.unmount()
})

test('a list that breaks later keeps protecting what it protected (the last list read whole)', async ($, on) => {
  const w = world(on, { cwd: '/w/fleet', config: listText() })
  expect((await $.tool.call(bash('git commit -m a'))).deny).toBeDefined()
  w.setConfig('{ broken')
  expect((await $.tool.call(bash('git commit -m b'))).deny).toBeDefined()
  expect(w.toasts.join('\n')).toContain('still protecting the last list')
})
