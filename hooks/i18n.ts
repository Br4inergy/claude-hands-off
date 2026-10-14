/**
 * Hands Off's words in English and Spanish, picked by Claude Code's `language` setting, then the locale (nothing to
 * configure). Every user-facing string lives here; the rules and the wiring only call these.
 */
export type Lang = 'en' | 'es'

const EN = {
  brand: 'Hands Off',
  /** The command a person types to give a one-time pass (used in hints and in the reason the model sees). */
  passCmd: '/handsoff pass',
  commandDescription:
    'Keep your agent off what is not yours: read yes, write no · /handsoff opens the panel · /handsoff status · /handsoff pass [owner/repo]',
  argumentHint: '[status | pass [owner/repo]]',

  // ── rules ─────────────────────────────────────────────────────────────────
  /** The reason the model sees when a call is denied. `also` = the other protected things in the same command. */
  deny: (label: string, also: string, detail: string) =>
    `Hands Off: ${label} is protected — read yes, write no${also ? ` (also: ${also})` : ''}. ` +
    'If it needs a change, ask its owner. For a one-time exception a person must type /handsoff pass. ' +
    `Do not work around this with another command. [blocked: ${detail}]`,
  redirectTo: (name: string) => `redirect to ${name}`,
  editOf: (name: string) => `edit of ${name}`,
  ago: {
    now: 'just now',
    min: (n: number) => `${n} min ago`,
    hours: (n: number) => `${n} h ago`,
    days: (n: number) => `${n} d ago`,
  },

  // editConfig
  invalidJson: 'the file is not valid JSON; fix it by hand before editing from the panel',
  badShape: 'the file has an unexpected shape; fix it by hand before editing from the panel',
  notRepo: (input: string) => `"${input}" doesn't look like a repo (owner/repo)`,
  notRailway: (input: string) => `"${input}" is not a valid Railway project name`,
  notVercel: (input: string) => `"${input}" is not a valid Vercel project name or id`,
  notNeon: (input: string) => `"${input}" is not a valid Neon project id (lowercase letters, numbers and dashes, e.g. proud-cloud-12345678)`,
  notSupabase: (input: string) => `"${input}" is not a valid Supabase project ref (20 lowercase letters)`,
  added: (what: string) => `${what} added`,
  removed: (what: string) => `${what} removed`,
  already: (what: string) => `${what} is already in the list`,
  absent: (what: string) => `${what} is not in the list`,

  // ── toasts ────────────────────────────────────────────────────────────────
  configUnreadable: 'Hands Off: ~/.claude/hands-off.json could not be read; still protecting the last list it read whole. Fix the file to change it',
  legacyUnreadable: 'Hands Off: ~/.claude/intocables.json could not be read, so it was not imported; starting with an empty list',
  ruleFailed: (why: string) => `Hands Off: the rule failed and the call was let through (${why})`,
  tookTooLong: 'the analysis took too long',
  passUsed: (labels: string) => `Hands Off: pass used on ${labels}`,
  blockedToast: (detail: string, labels: string) => `Hands Off blocked ${detail} on ${labels}. To allow it once: /handsoff pass`,

  // ── command replies ───────────────────────────────────────────────────────
  statusIntro: 'Hands Off: read yes, write no.',
  statusNothing: 'Nothing is protected yet. Add repos and projects in the panel (/handsoff) or in ~/.claude/hands-off.json.',
  statusRepos: (n: number, list: string) => `Protected repos (${n}): ${list}.`,
  statusProjects: (kind: string, list: string) => `${kind} projects: ${list}.`,
  statusPasses: (list: string) => `Active passes (one-time, 10 min): ${list}.`,
  statusMinutes: (label: string, min: number) => `${label} (${min} min)`,
  statusNoPasses: 'No active passes.',
  statusFooter: 'For an exception: /handsoff pass [owner/repo | neon:id | supabase:ref]. Editable list in ~/.claude/hands-off.json or in the panel.',
  onlyHuman: 'Hands Off: Only a person can give a pass, typing it at the prompt.',
  none: 'none',
  notProtected: (slug: string, all: string) => `Hands Off: "${slug}" is not in the protected list (${all}).`,
  passGranted: (label: string) => `Hands Off: one-time pass for ${label} (10 min). The next blocked call on it goes through.`,
  noRecentBlock: 'Hands Off: there is no recent block (10 min). To grant a pass in advance: /handsoff pass owner/repo.',
  passGrantedLast: (labels: string) => `Hands Off: one-time pass for ${labels} (10 min). Retry the blocked action.`,

  // ── panel ─────────────────────────────────────────────────────────────────
  tagline: 'read yes, write no',
  kind: { github: 'GitHub', railway: 'Railway', vercel: 'Vercel', neon: 'Neon', supabase: 'Supabase' },
  protectedTag: 'protected',
  passTag: (min: number) => `pass · ${min} min`,
  noBlocksYet: 'No blocks in this session',
  blockSummary: (n: number, ago: string, detail: string) => `${n} ${n === 1 ? 'block' : 'blocks'} · last ${ago}: ${detail}`,
  revoke: 'Revoke pass',
  onePass: 'One-time pass (10 min)',
  less: 'Less ▴',
  manage: 'Manage ▾',
  confirmRemove: (label: string) => `Yes, remove ${label}`,
  removeFromList: 'Remove from list…',
  removeWarning: 'It will no longer be protected: Claude will be able to write there without a pass.',
  summary: (c: { repos: number; railway: number; vercel: number; neon: number; supabase: number; live: number; denied: number }) =>
    `${c.repos} ${c.repos === 1 ? 'repo' : 'repos'} · ${c.railway} Railway · ${c.vercel} Vercel · ${c.neon} Neon · ${c.supabase} Supabase · ` +
    `${c.live} ${c.live === 1 ? 'active pass' : 'active passes'} · ${c.denied} ${c.denied === 1 ? 'block' : 'blocks'} in this session`,
  defaultListWarning: 'Using an empty list (~/.claude/hands-off.json could not be read).',
  recentBlock: (labels: string, ago: string) => `Recent block on ${labels} (${ago})`,
  givePass: 'Give pass and retry',
  passGivenNote: (labels: string) => `Pass given for ${labels}. Ask Claude to retry.`,
  headingProtected: 'Protected',
  emptyList: 'The list is empty: nothing is protected.',
  headingAdd: 'Add',
  inputRepo: 'Repo ',
  inputRailway: 'Railway ',
  inputVercel: 'Vercel ',
  inputNeon: 'Neon ',
  inputSupabase: 'Supabase ',
  placeholderRepo: 'owner/repo or GitHub URL',
  placeholderRailway: 'project name',
  placeholderVercel: 'project name or id (prj_…)',
  placeholderNeon: 'project id (e.g. proud-cloud-12345678)',
  placeholderSupabase: 'project ref (20 letters)',
  submit: 'add',
  mobileNote: 'To add entries, use the panel in the terminal or the desktop app (or edit ~/.claude/hands-off.json).',
  headingActivity: 'Activity this session',
  nothingBlocked: 'Nothing blocked yet.',
  activityPass: '↷ pass ',
  activityBlock: '✕ block',
  reload: '↻ Reload list',
  reloaded: 'List reloaded.',
  clearActivity: 'Clear activity',
  footer: 'The list lives in ~/.claude/hands-off.json (kept when the mod updates). Only a person can press the buttons in this panel.',

  // ── adding from the panel ─────────────────────────────────────────────────
  noHome: "Hands Off: I don't know where your HOME is; edit the list by hand.",
  nothingChanged: (error: string) => `Nothing changed: ${error}.`,
  writeFailed: (why: string) => `Could not write the list (${why}).`,
  notRepoInput: (input: string) => `"${input}" doesn't look like a repo (owner/repo or GitHub URL).`,
  verified: ' (verified on GitHub)',
  unverified: ' — could not confirm it on GitHub: check that the name is exact',
}

export type Words = typeof EN

const ES: Words = {
  brand: 'Intocables',
  passCmd: '/intocables pase',
  commandDescription:
    'Que tu agente no toque lo que no es tuyo: leer sí, escribir no · /intocables abre el panel · /intocables estado · /intocables pase [owner/repo]',
  argumentHint: '[estado | pase [owner/repo]]',

  deny: (label, also, detail) =>
    `Intocables: ${label} está protegido — leer sí, escribir no${also ? ` (también: ${also})` : ''}. ` +
    'Si hay que cambiarlo, pídeselo a su dueño. Para una excepción puntual una persona debe teclear /intocables pase. ' +
    `No lo rodees con otro comando. [bloqueado: ${detail}]`,
  redirectTo: name => `redirección a ${name}`,
  editOf: name => `edición de ${name}`,
  ago: {
    now: 'ahora',
    min: n => `hace ${n} min`,
    hours: n => `hace ${n} h`,
    days: n => `hace ${n} d`,
  },

  invalidJson: 'el archivo no es JSON válido; arréglalo a mano antes de editar desde el panel',
  badShape: 'el archivo tiene una forma inesperada; arréglalo a mano antes de editar desde el panel',
  notRepo: input => `«${input}» no parece un repo (owner/repo)`,
  notRailway: input => `«${input}» no es un nombre de proyecto Railway válido`,
  notVercel: input => `«${input}» no es un nombre o id de proyecto Vercel válido`,
  notNeon: input => `«${input}» no es un id de proyecto Neon válido (minúsculas, números y guiones, p. ej. proud-cloud-12345678)`,
  notSupabase: input => `«${input}» no es un project ref de Supabase válido (20 letras minúsculas)`,
  added: what => `${what} agregado`,
  removed: what => `${what} quitado`,
  already: what => `${what} ya está en la lista`,
  absent: what => `${what} no está en la lista`,

  configUnreadable: 'Intocables: ~/.claude/hands-off.json no se pudo leer; sigo protegiendo la última lista que leí completa. Arregla el archivo para cambiarla',
  legacyUnreadable: 'Intocables: ~/.claude/intocables.json no se pudo leer, así que no se importó; empiezo con la lista vacía',
  ruleFailed: why => `Intocables: la regla falló y dejé pasar la llamada (${why})`,
  tookTooLong: 'el análisis tardó demasiado',
  passUsed: labels => `Intocables: pase usado en ${labels}`,
  blockedToast: (detail, labels) => `Intocables bloqueó ${detail} en ${labels}. Para permitirlo una vez: /intocables pase`,

  statusIntro: 'Intocables: leer sí, escribir no.',
  statusNothing: 'Todavía no hay nada protegido. Agrega repos y proyectos en el panel (/intocables) o en ~/.claude/hands-off.json.',
  statusRepos: (n, list) => `Repos protegidos (${n}): ${list}.`,
  statusProjects: (kind, list) => `Proyectos ${kind}: ${list}.`,
  statusPasses: list => `Pases activos (una vez, 10 min): ${list}.`,
  statusMinutes: (label, min) => `${label} (${min} min)`,
  statusNoPasses: 'Sin pases activos.',
  statusFooter: 'Para una excepción: /intocables pase [owner/repo | neon:id | supabase:ref]. Lista editable en ~/.claude/hands-off.json o en el panel.',
  onlyHuman: 'Intocables: los pases solo los da una persona, tecleándolos en el prompt.',
  none: 'ninguno',
  notProtected: (slug, all) => `Intocables: «${slug}» no está en la lista protegida (${all}).`,
  passGranted: label => `Intocables: pase de una vez para ${label} (10 min). La próxima llamada bloqueada ahí pasa.`,
  noRecentBlock: 'Intocables: no hay un bloqueo reciente (10 min). Para adelantar un pase: /intocables pase owner/repo.',
  passGrantedLast: labels => `Intocables: pase de una vez para ${labels} (10 min). Reintenta la acción bloqueada.`,

  tagline: 'leer sí, escribir no',
  kind: { github: 'GitHub', railway: 'Railway', vercel: 'Vercel', neon: 'Neon', supabase: 'Supabase' },
  protectedTag: 'protegido',
  passTag: min => `pase · ${min} min`,
  noBlocksYet: 'Sin bloqueos en esta sesión',
  blockSummary: (n, ago, detail) => `${n} ${n === 1 ? 'bloqueo' : 'bloqueos'} · último ${ago}: ${detail}`,
  revoke: 'Revocar pase',
  onePass: 'Pase de una vez (10 min)',
  less: 'Menos ▴',
  manage: 'Gestionar ▾',
  confirmRemove: label => `Sí, quitar ${label}`,
  removeFromList: 'Quitar de la lista…',
  removeWarning: 'Dejará de estar protegido: Claude podrá escribir ahí sin pase.',
  summary: c =>
    `${c.repos} repos · ${c.railway} Railway · ${c.vercel} Vercel · ${c.neon} Neon · ${c.supabase} Supabase · ` +
    `${c.live} ${c.live === 1 ? 'pase activo' : 'pases activos'} · ${c.denied} ${c.denied === 1 ? 'bloqueo' : 'bloqueos'} en esta sesión`,
  defaultListWarning: 'Usando una lista vacía (no se pudo leer ~/.claude/hands-off.json).',
  recentBlock: (labels, ago) => `Bloqueo reciente en ${labels} (${ago})`,
  givePass: 'Dar pase y reintentar',
  passGivenNote: labels => `Pase dado para ${labels}. Pídele a Claude que reintente.`,
  headingProtected: 'Protegidos',
  emptyList: 'La lista está vacía: nada está protegido.',
  headingAdd: 'Agregar',
  inputRepo: 'Repo ',
  inputRailway: 'Railway ',
  inputVercel: 'Vercel ',
  inputNeon: 'Neon ',
  inputSupabase: 'Supabase ',
  placeholderRepo: 'owner/repo o URL de GitHub',
  placeholderRailway: 'nombre del proyecto',
  placeholderVercel: 'nombre o id (prj_…) del proyecto',
  placeholderNeon: 'id del proyecto (p. ej. proud-cloud-12345678)',
  placeholderSupabase: 'project ref (20 letras)',
  submit: 'agregar',
  mobileNote: 'Para agregar, usa el panel en la terminal o el escritorio (o edita ~/.claude/hands-off.json).',
  headingActivity: 'Actividad de esta sesión',
  nothingBlocked: 'Nada bloqueado todavía.',
  activityPass: '↷ pase ',
  activityBlock: '✕ bloqueo',
  reload: '↻ Releer lista',
  reloaded: 'Lista releída.',
  clearActivity: 'Limpiar actividad',
  footer: 'La lista vive en ~/.claude/hands-off.json (no se pisa al actualizar el mod). Los botones de este panel solo los presiona una persona.',

  noHome: 'Intocables: no sé dónde está tu HOME; edita la lista a mano.',
  nothingChanged: error => `No se cambió nada: ${error}.`,
  writeFailed: why => `No pude escribir la lista (${why}).`,
  notRepoInput: input => `«${input}» no parece un repo (owner/repo o URL de GitHub).`,
  verified: ' (verificado en GitHub)',
  unverified: ' — no pude confirmarlo en GitHub: revisa que el nombre sea exacto',
}

export const words = (lang: Lang): Words => (lang === 'es' ? ES : EN)

/** Claude Code's `language` setting, then LC_ALL/LANG; English otherwise. An explicit 'en' or 'es' first wins (tests). */
export function pickLang(option: unknown, settingsLanguage: unknown, locale: string | null): Lang {
  if (option === 'en' || option === 'es') return option
  const s = typeof settingsLanguage === 'string' ? settingsLanguage.toLowerCase() : ''
  if (s) return s.startsWith('es') || s.startsWith('span') || s.startsWith('espa') ? 'es' : 'en'
  return (locale ?? '').toLowerCase().startsWith('es') ? 'es' : 'en'
}
