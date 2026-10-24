// Pure rules of Hands Off: a blocked / allowed matrix without touching git or the disk.
import { expect, test } from 'claude-code/testing'

import { words } from '../hooks/i18n'
import {
  DEFAULT_CONFIG,
  ago,
  cleanRailway,
  cleanVercel,
  cleanNeon,
  cleanSupabase,
  cleanSlug,
  editConfig,
  checkBash,
  checkMcp,
  checkPath,
  defaultConfigText,
  denyText,
  gitWrites,
  lex,
  matchSlug,
  migrateConfig,
  parseConfig,
  resolveCommand,
  slugFromUrl,
  spendPasses,
  type Config,
  type Deps,
} from '../hooks/rules'

const EN = words('en')
const ES = words('es')

const HOME = '/home/user'
/** The default list is empty, so the matrix runs against this one. */
const CFG: Config = {
  repos: ['acme/api', 'acme/web', 'acme/server', 'acme/platform', 'acme/crm'],
  railwayProjects: ['shop-api'],
  vercelProjects: [],
  neonProjects: [],
  supabaseProjects: [],
}
const ORIGINS: Record<string, string> = {
  '/w/fleet': 'https://github.com/acme/api.git',
  '/w/portal': 'git@github.com:acme/web.git',
  '/w/server': 'ssh://git@github.com/acme/server',
  '/w/platform': 'https://x-access-token:abc@github.com/acme/platform.git',
  '/w/crm': 'git@github.com:acme/crm.git',
  '/w/crm-deck': 'git@github.com:acme/crm-sales-deck.git',
  '/w/mine': 'https://github.com/acme/own-app.git',
  '/w/fork': 'https://github.com/someone/api.git',
  '/w/nogit': '',
  '/w/forkup': 'https://github.com/someone/fork.git',
  '/w/forknp': 'git@github.com:someone/fork.git',
}
/** Every remote URL of a repo (what `remotesOf` returns); folders not listed here have none. */
const ALL_REMOTES: Record<string, string[]> = {
  '/w/forkup': ['https://github.com/someone/fork.git', 'git@github.com:acme/api.git'],
  '/w/forknp': ['git@github.com:someone/fork.git'],
}
const REMOTES: Record<string, Record<string, string>> = {
  '/w/fork': { upstream: 'https://github.com/acme/api.git', origin: 'https://github.com/someone/api.git' },
}
const RAILWAY: Record<string, string> = { '/w/fleet': 'shop-api', '/w/mine': 'bob', '/w/other': 'shop-api' }

const VERCEL: Record<string, { name: string; id: string }> = {
  '/w/vprot': { name: 'locked-app', id: 'prj_abc123' },
  '/w/vfree': { name: 'free-app', id: 'prj_zzz999' },
}

// Neon context (`.neon` → projectId) per folder, or per explicit file (--context-file).
const NEON_DIRS: Record<string, string> = { '/w/nprot': 'proud-cloud-12345678', '/w/nfree': 'free-river-99999999' }
const NEON_FILES: Record<string, string> = { '/w/other/alt.json': 'proud-cloud-12345678', '/w/nfree/alt.json': 'free-river-99999999' }
// Linked Supabase (`supabase/.temp/project-ref`) per project root.
const REF = 'abcdefghijklmnopqrst'
const SUPA: Record<string, string> = { '/w/sprot': REF, '/w/sfree': 'zzzzzzzzzzzzzzzzzzzz' }

const rootOf = (path: string, table: Record<string, unknown>) =>
  Object.keys(table)
    .filter(r => path === r || path.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0]

function deps(cwd: string, over: Partial<Deps> = {}): Deps {
  return {
    cwd,
    home: HOME,
    config: CFG,
    words: EN,
    originOf: async path => ORIGINS[rootOf(path, ORIGINS) ?? ''] ?? '',
    remoteUrl: async (dir, name) => REMOTES[rootOf(dir, REMOTES) ?? '']?.[name] ?? '',
    remotesOf: async dir => ALL_REMOTES[rootOf(dir, ALL_REMOTES) ?? ''] ?? [],
    parentOf: async () => null,
    warn: () => undefined,
    railwayLinked: async dir => RAILWAY[rootOf(dir, RAILWAY) ?? ''] ?? '',
    vercelLinked: async dir => VERCEL[rootOf(dir, VERCEL) ?? ''] ?? { name: '', id: '' },
    neonContext: async (dir, file) => (file ? NEON_FILES[file] : NEON_DIRS[rootOf(dir, NEON_DIRS) ?? '']) ?? '',
    supabaseLinked: async (dir, exact) => SUPA[exact ? dir : (rootOf(dir, SUPA) ?? '')] ?? '',
    ...over,
  }
}

const labels = async (cmd: string, cwd = '/w/fleet', over: Partial<Deps> = {}) => (await checkBash(cmd, deps(cwd, over))).map(h => h.label)
const blocked = async (cmd: string, cwd = '/w/fleet') => (await labels(cmd, cwd)).length > 0

// ── blocked ───────────────────────────────────────────────────────────────

test('git that writes inside a protected repo is blocked', async () => {
  const cmds = [
    'git commit -m x',
    'git commit -am "arreglo"',
    'git push',
    'git push origin main',
    'git add -A',
    'git add .',
    'git rm file.ts',
    'git mv a b',
    'git reset --hard HEAD~1',
    'git rebase main',
    'git merge feature',
    'git tag v1.0.0',
    'git tag -a v1 -m "x"',
    'git branch feature',
    'git branch -D old',
    'git checkout -b feature',
    'git switch -c feature',
    'git stash',
    'git stash pop',
    'git clean -fd',
    'git cherry-pick abc123',
    'git revert abc123',
    'git am fix.patch',
    'git restore .',
    'git checkout -- src/a.ts',
    'git remote set-url origin https://example.com/x.git',
    'git config user.email a@b.c',
    'git worktree add ../x main',
    'git --no-pager commit -m x',
    'git -c user.name=x commit -m y',
    'git add . && git commit -m x && git push',
  ]
  for (const cmd of cmds) expect([cmd, await blocked(cmd)]).toEqual([cmd, true])
})

test('the five repos of the list are recognised by their remote', async () => {
  for (const [dir, slug] of [
    ['/w/fleet', 'acme/api'],
    ['/w/portal', 'acme/web'],
    ['/w/server', 'acme/server'],
    ['/w/platform', 'acme/platform'],
    ['/w/crm', 'acme/crm'],
  ] as const) {
    expect(await labels('git commit -m x', dir)).toEqual([slug])
    expect(await labels('git commit -m x', `${dir}/src/deep/dir`)).toEqual([slug])
  }
})

test('the effective directory comes from cd, git -C, --cwd, subshells and -c shells', async () => {
  // From an own repo, pointing at the protected one blocks.
  for (const cmd of [
    'cd /w/fleet && git commit -m x',
    'cd /w/fleet; git commit -m x',
    'git -C /w/fleet commit -m x',
    'git -C /w/fleet -c user.name=x push',
    '(cd /w/fleet && git commit -m x)',
    'bash -c "cd /w/fleet && git commit -m x"',
    "sh -c 'git -C /w/fleet push'",
    'sudo git -C /w/fleet commit -m x',
    'env GIT_PAGER=cat git -C /w/fleet commit -m x',
    'echo "$(git -C /w/fleet commit -m x)"',
    'cd ~/../../w/fleet && git commit -m x',
    'cd /w && cd fleet && git commit -m x',
    'cd /w/fleet/src && git commit -m x',
    'vercel --cwd /w/fleet --prod',
  ]) expect([cmd, await blocked(cmd, '/w/mine')]).toEqual([cmd, true])
  // And the other way round: the cd leaves the zone and no longer matches.
  for (const cmd of [
    'cd /w/mine && git commit -m x',
    'cd /w/fleet && cd ../mine && git commit -m x',
    '(cd /w/fleet && ls); git commit -m x',
    "echo '$(git -C /w/fleet commit -m x)'",
    'git -C /w/mine commit -m x',
  ]) expect([cmd, await blocked(cmd, '/w/mine')]).toEqual([cmd, false])
})

test('a directory that cannot be known ($VAR, $(...)) leaves the command where it was', async () => {
  // I am in the protected repo: cd "$(git rev-parse --show-toplevel)" is still the protected repo.
  expect(await blocked('cd "$(git rev-parse --show-toplevel)" && git commit -m x', '/w/fleet')).toBe(true)
  expect(await blocked('git -C "$REPO" commit -m x', '/w/fleet')).toBe(true)
  expect(await blocked('cd $OTRO && git push', '/w/fleet')).toBe(true)
  // I am in an own one: the unknown does not invent a block.
  expect(await blocked('cd "$(git rev-parse --show-toplevel)" && git commit -m x', '/w/mine')).toBe(false)
  expect(await blocked('git -C "$REPO" commit -m x', '/w/mine')).toBe(false)
  // File paths that depend on a variable cannot be judged: they pass.
  expect(await blocked('rm -rf "$TMP/x"', '/w/mine')).toBe(false)
})

test('shell structures: for, if, while, || and environment variables do not hide the write', async () => {
  for (const cmd of [
    'for f in a b; do git add $f; done',
    'if git diff --quiet; then git commit -am x; fi',
    'git commit -m x || true',
    'FOO=bar git push',
    'git status && { git add .; git commit -m x; }',
    'git fetch\\\n  && git rebase origin/main',
    'echo ok # nota\ngit push',
  ]) expect([cmd, await blocked(cmd)]).toEqual([cmd, true])
  expect(await blocked('git status # git commit\ngit log')).toBe(false)
})

test('a huge heredoc is read in linear time', async () => {
  const body = 'x git push acme/api\n'.repeat(5000)
  expect(await blocked(`cat > /tmp/big.txt <<'EOF'\n${body}EOF\necho listo`, '/w/mine')).toBe(false)
})

test('vercel: deploy, link and env are blocked; reads pass', async () => {
  for (const cmd of ['vercel', 'vercel --prod', 'vercel deploy --prod', 'vercel link', 'vercel env add FOO', 'vercel env rm FOO', 'vercel env pull', 'vercel pull', 'npx vercel --prod', 'pnpm dlx vercel deploy', 'pnpm vercel --prod', 'vercel promote x', 'vercel --prod --yes --token abc']) {
    expect([cmd, await blocked(cmd)]).toEqual([cmd, true])
  }
  for (const cmd of ['vercel ls', 'vercel inspect x', 'vercel logs x', 'vercel whoami', 'vercel env ls', 'vercel project ls', 'vercel --version', 'vercel dev']) {
    expect([cmd, await blocked(cmd)]).toEqual([cmd, false])
  }
  expect(await blocked('vercel --prod', '/w/mine')).toBe(false)
})

test('sed -i, rm, mv, cp, tee, touch and publish are blocked when they land inside', async () => {
  for (const cmd of [
    "sed -i 's/a/b/' src/a.ts",
    "sed -i '' 's/a/b/' src/a.ts",
    "sed -i.bak -e 's/a/b/' src/a.ts",
    "sed -ni 's/a/b/p' f",
    "perl -pi -e 's/a/b/' f",
    'rm -rf dist',
    'rm file.txt',
    'mv a.txt b.txt',
    'cp /tmp/x.txt notes.txt',
    'touch new.txt',
    'mkdir -p docs/x',
    'echo hi | tee out.txt',
    'ln -s /tmp/x link',
    'find . -name "*.log" -delete',
    'find src -exec rm {} ;',
    'npm publish',
    'pnpm publish --access public',
    'yarn npm publish',
    'npx changeset publish',
  ]) expect([cmd, await blocked(cmd)]).toEqual([cmd, true])

  // From an own repo, with paths into the protected one.
  for (const cmd of [
    "sed -i 's/a/b/' /w/fleet/src/a.ts",
    'rm /w/fleet/a.txt',
    'rm -rf /w/fleet/dist /w/mine/dist',
    'mv /w/mine/a.txt /w/fleet/a.txt',
    'mv /w/fleet/a.txt /tmp/a.txt',
    'cp /w/mine/a.txt /w/fleet/a.txt',
    'cp -t /w/fleet /w/mine/a.txt',
    'touch /w/fleet/x',
    'echo hi > /w/fleet/x.txt',
    'echo hi >> /w/fleet/README.md',
    'cat a b > /w/fleet/out',
    'printf x &> /w/fleet/out',
    'npm publish /w/fleet',
    'npm --prefix /w/fleet publish',
    'dd if=/dev/zero of=/w/fleet/blob bs=1 count=1',
  ]) expect([cmd, await blocked(cmd, '/w/mine')]).toEqual([cmd, true])
})

test('redirections: > and >> into a file of the repo; to /dev/null, 2>&1 and to another repo do not', async () => {
  expect(await blocked('echo hi > out.txt')).toBe(true)
  expect(await blocked('echo hi >> out.txt')).toBe(true)
  expect(await blocked('echo hi>out.txt')).toBe(true)
  expect(await blocked('ls 2> err.log')).toBe(true)
  expect(await blocked('ls > /dev/null 2>&1')).toBe(false)
  expect(await blocked('ls &> /dev/null')).toBe(false)
  expect(await blocked('echo hi > /tmp/out.txt')).toBe(false)
  expect(await blocked('echo hi > /w/mine/out.txt')).toBe(false)
  expect(await blocked('cat a b > /tmp/ab', '/w/fleet')).toBe(false)
  expect(await blocked('cat < in.txt')).toBe(false)
  // A heredoc that writes to a file of the repo: blocked by the redirection, not by the text.
  expect(await blocked("cat > notes.md <<'EOF'\nhola\nEOF")).toBe(true)
  expect(await blocked("cat > /tmp/notes.md <<'EOF'\nacme/api\ngit push\nEOF")).toBe(false)
})

test('gh: writes with -R, with the URL, or running inside the repo are blocked', async () => {
  for (const cmd of [
    'gh pr create --title x --body y',
    'gh pr merge 12 --squash',
    'gh pr edit 3 --add-label x',
    'gh pr close 3',
    'gh pr comment 3 --body hola',
    'gh pr review 3 --approve',
    'gh issue edit 4 --title y',
    'gh issue close 4',
    'gh release create v1 --notes x',
    'gh release delete v1',
    'gh repo edit --description x',
    'gh repo archive',
    'gh repo rename nuevo',
    'gh workflow run ci.yml',
    'gh workflow disable ci.yml',
    'gh api --method DELETE /repos/acme/api/git/refs/heads/x',
    'gh api -X PATCH repos/{owner}/{repo}/pulls/3 -f state=closed',
  ]) expect([cmd, await blocked(cmd)]).toEqual([cmd, true])

  for (const cmd of [
    'gh pr create --repo acme/api --title x',
    'gh pr merge 12 -R acme/web',
    'gh pr merge https://github.com/acme/server/pull/12',
    'gh release create v1 -R acme/platform',
    'gh repo edit acme/api --visibility private',
    'gh repo delete acme/crm --yes',
    'gh workflow run ci.yml -R acme/api',
    'GH_REPO=acme/api gh pr create --fill',
    'gh api -X PUT /repos/acme/api/topics',
    'gh api graphql -f query=\'mutation { addStar(input:{starrableId:"x"}) { clientMutationId } }\' -f note=acme/api',
  ]) expect([cmd, await blocked(cmd, '/w/mine')]).toEqual([cmd, true])
})

test('railway: mutating commands, with the project linked or named', async () => {
  // /w/other is not a protected repo but its folder is linked to the shop-api project.
  for (const cmd of ['railway up', 'railway redeploy', 'railway down', 'railway variables --set FOO=1', 'railway variable set FOO=1', 'railway variable delete FOO', 'railway service', 'railway add', 'railway environment new x', 'railway domain add x.com', 'railway delete']) {
    expect([cmd, (await labels(cmd, '/w/other')).join()]).toEqual([cmd, 'Railway shop-api'])
  }
  expect(await labels('railway up -p shop-api', '/w/mine')).toEqual(['Railway shop-api'])
  expect(await labels('railway link -p shop-api', '/w/mine')).toEqual(['Railway shop-api'])
  expect(await labels('railway link shop-api', '/w/mine')).toEqual(['Railway shop-api'])
  expect(await labels('railway up --project SHOP-API', '/w/mine')).toEqual(['Railway shop-api'])
  // Reads, other projects and own projects.
  for (const cmd of ['railway status', 'railway logs', 'railway whoami', 'railway variables', 'railway variable list', 'railway variables --kv', 'railway list', 'railway service status', 'railway run echo hi']) {
    expect([cmd, (await labels(cmd, '/w/other')).length]).toEqual([cmd, 0])
  }
  expect(await labels('railway up', '/w/nogit')).toEqual([])
  expect(await labels('railway up -p bob', '/w/other')).toEqual([])
  expect(await labels('railway link -p bob', '/w/other')).toEqual([])
  // Inside a protected repo a mutating railway command also counts (by the origin).
  expect(await labels('railway up', '/w/crm')).toEqual(['acme/crm'])
})

// ── allowed ───────────────────────────────────────────────────────────────

test('reads: git log/diff/status/show/fetch/clone, cat, ls, grep, gh view/list and api GET pass', async () => {
  for (const cmd of [
    'git log --oneline -20',
    'git diff HEAD~1',
    'git status',
    'git show HEAD',
    'git fetch origin',
    'git pull',
    'git blame src/a.ts',
    'git ls-files',
    'git rev-parse HEAD',
    'git branch',
    'git branch -a',
    'git branch --list "feat*"',
    'git branch --show-current',
    'git tag',
    'git tag -l "v*"',
    'git stash list',
    'git stash show -p',
    'git remote -v',
    'git remote get-url origin',
    'git config --get remote.origin.url',
    'git config user.name',
    'git config --global user.name "Sam"',
    'git worktree list',
    'git push --dry-run',
    'git add -n .',
    'git clean -n',
    'git apply --check x.patch',
    'git clone https://github.com/acme/api.git /tmp/fleet-copy',
    'git -C /tmp/fleet-copy log',
    'cat README.md',
    'ls -la',
    'grep -rn "git commit" .',
    'rg "gh pr create" src',
    'sed -n 1,20p src/a.ts',
    'sed "s/a/b/" src/a.ts',
    'find . -name "*.ts"',
    'cp src/a.ts /tmp/a.ts',
    'cp -r . /tmp/copy',
    'rm /tmp/x',
    'mv /tmp/a /tmp/b',
    'echo hola',
    'gh pr view 1',
    'gh pr list',
    'gh pr list -R acme/api',
    'gh pr diff 3',
    'gh pr checkout 3',
    'gh pr checks 3',
    'gh issue list',
    'gh issue view 4 --repo acme/api',
    'gh release list',
    'gh repo view acme/api',
    'gh repo clone acme/api /tmp/x',
    'gh run list',
    'gh api repos/acme/api/pulls',
    'gh api -X GET repos/acme/api/issues -f per_page=100',
    'gh api graphql -f query="query { viewer { login } }"',
    'npm publish --dry-run',
    'npm test',
    'pnpm install',
    'vercel ls',
    'railway status',
  ]) expect([cmd, await labels(cmd)]).toEqual([cmd, []])
})

test('false positives: the slug or the command inside a message, heredoc or quoted text does not block', async () => {
  const cwd = '/w/mine'
  for (const cmd of [
    'git commit -m "ya no tocamos acme/api; git push no"',
    "git commit -m 'gh pr create -R acme/api'",
    'git commit -m "$(cat <<\'EOF\'\nver acme/api y acme/crm\ngit push origin main\nEOF\n)"',
    'gh pr create --title x --body "$(cat <<\'EOF\'\n## Resumen\nNo tocar acme/api (gh pr merge, git commit, vercel --prod)\nEOF\n)"',
    "cat > /tmp/notes.md <<'EOF'\nacme/api\ngit push\nrailway up\nEOF",
    "cat <<EOF | grep fleet\nacme/api\nEOF",
    'echo "git commit -m x" > /tmp/a.sh',
    'echo "rm -rf /w/fleet" && ls',
    'grep -rn "acme/api" .',
    "echo 'gh api -X POST repos/acme/api/issues'",
    'git log --grep="acme/api"',
    'gh issue list --search "acme/api in:body"',
    'curl -s https://api.github.com/repos/acme/api',
    'echo hola # git -C /w/fleet commit',
  ]) expect([cmd, await labels(cmd, cwd)]).toEqual([cmd, []])
})

test('an own repo, my fork, look-alike repos and folders without git are not blocked', async () => {
  for (const cwd of ['/w/mine', '/w/fork', '/w/crm-deck', '/w/nogit', '/w/desconocido']) {
    for (const cmd of ['git commit -m x', 'git push', 'git add -A', 'vercel --prod', 'gh pr create --fill', 'rm -rf dist', "sed -i 's/a/b/' f", 'echo hi > out.txt', 'npm publish', 'railway up']) {
      expect([cwd, cmd, await labels(cmd, cwd)]).toEqual([cwd, cmd, []])
    }
  }
  expect(await labels('gh pr create -R acme/own-app --fill', '/w/fleet')).toEqual([])
  expect(await labels('git -C /w/mine commit -m x', '/w/fleet')).toEqual([])
  expect(await labels('gh api -X POST repos/acme/own-app/issues -f title=x', '/w/fleet')).toEqual([])
  expect(await labels('gh pr merge 1 -R acme/crm-sales-deck', '/w/mine')).toEqual([])
  expect(CFG.repos.map(r => r.toLowerCase())).not.toContain('acme/own-app')
})

test('git push to a protected remote from my fork is blocked; to my own is not', async () => {
  expect(await labels('git push upstream main', '/w/fork')).toEqual(['acme/api'])
  expect(await labels('git push https://github.com/acme/api.git HEAD:main', '/w/mine')).toEqual(['acme/api'])
  expect(await labels('git push --repo=git@github.com:acme/crm.git', '/w/mine')).toEqual(['acme/crm'])
  expect(await labels('git push origin main', '/w/fork')).toEqual([])
  expect(await labels('git push', '/w/fork')).toEqual([])
})

test('several protected repos in one command are all reported', async () => {
  expect(await labels('git -C /w/fleet commit -m x && git -C /w/crm commit -m y', '/w/mine')).toEqual(['acme/api', 'acme/crm'])
  expect(await labels('git commit -m a && git push', '/w/fleet')).toEqual(['acme/api'])
})

// ── Edit / Write ────────────────────────────────────────────────────────────

test('Edit/Write: files inside a protected repo are blocked (even if the folder does not exist yet); own files pass', async () => {
  const d = deps('/w/mine')
  expect((await checkPath('/w/fleet/src/a.ts', d)).map(h => h.label)).toEqual(['acme/api'])
  expect((await checkPath('/w/fleet/carpeta/nueva/a.ts', d)).map(h => h.label)).toEqual(['acme/api'])
  expect((await checkPath('/w/crm/README.md', d)).map(h => h.label)).toEqual(['acme/crm'])
  expect((await checkPath('../fleet/x.ts', d)).map(h => h.label)).toEqual(['acme/api'])
  expect(await checkPath('/w/mine/src/a.ts', d)).toEqual([])
  expect(await checkPath('/w/fork/src/a.ts', d)).toEqual([])
  expect(await checkPath('/tmp/x.ts', d)).toEqual([])
  expect((await checkPath('src/a.ts', deps('/w/fleet'))).map(h => h.label)).toEqual(['acme/api'])
})

// ── pieces ──────────────────────────────────────────────────────────────────

test('slugs: https, ssh, scp, with a token, .git and capitals', () => {
  for (const url of [
    'https://github.com/acme/api.git',
    'https://github.com/ACME/API',
    'git@github.com:acme/api.git',
    'ssh://git@github.com/acme/api/',
    'https://x:tok@github.com/acme/api.git',
    'git@github.com-work:acme/api.git',
    'acme/api',
    'github.com/acme/api',
  ]) expect([url, matchSlug(url, CFG)]).toEqual([url, 'acme/api'])
  for (const url of ['https://github.com/acme/api-old.git', 'https://github.com/someone/api.git', 'https://github.com/acme/own-app.git', '', '/Users/someone/api']) {
    expect([url, matchSlug(url, CFG)]).toEqual([url, null])
  }
  expect(slugFromUrl('git@github.com:A/b.git')).toBe('A/b')
})

test('lexer: quotes, heredocs, substitutions and redirections', () => {
  const argv = (src: string) => lex(src).map(s => s.argv)
  expect(argv('git commit -m "a b" \'c d\'')).toEqual([['git', 'commit', '-m', 'a b', 'c d']])
  expect(argv('a && b || c; d | e\nf')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f']])
  expect(argv("cat <<'EOF'\ngit push\nEOF\necho listo")).toEqual([['cat'], ['echo', 'listo']])
  expect(argv('cat <<-EOF\n\tgit push\n\tEOF\necho listo')).toEqual([['cat'], ['echo', 'listo']])
  expect(argv('echo a 2>&1 >/dev/null')).toEqual([['echo', 'a']])
  expect(lex('echo hi > out.txt >> log')[0]?.redirects).toEqual([
    { op: '>', target: 'out.txt' },
    { op: '>>', target: 'log' },
  ])
  const sub = lex('echo "$(git commit -m x)" `ls`')[0]
  expect(sub?.argv[1]).toBe('$(…)')
  expect(sub?.subs.map(s => s[0]?.argv)).toEqual([['git', 'commit', '-m', 'x'], ['ls']])
  expect(argv('# git commit\necho hi')).toEqual([['echo', 'hi']])
  expect(argv('echo a\\\n b')).toEqual([['echo', 'a', 'b']])
})

test('wrappers: sudo, env, time, npx and bash -c are unwrapped', () => {
  const name = (argv: string[]) => {
    const r = resolveCommand(argv)
    return r && 'cmd' in r ? [r.cmd.name, ...r.cmd.args] : r
  }
  expect(name(['sudo', '-u', 'root', 'git', 'push'])).toEqual(['git', 'push'])
  expect(name(['FOO=1', 'env', 'BAR=2', 'git', 'push'])).toEqual(['git', 'push'])
  expect(name(['time', 'git', 'push'])).toEqual(['git', 'push'])
  expect(name(['npx', '-y', 'vercel', '--prod'])).toEqual(['vercel', '--prod'])
  expect(name(['/opt/homebrew/bin/gh', 'pr', 'create'])).toEqual(['gh', 'pr', 'create'])
  expect(name(['timeout', '30', 'git', 'fetch'])).toEqual(['git', 'fetch'])
  expect(resolveCommand(['bash', '-lc', 'git commit'])).toEqual({ inner: 'git commit' })
  expect(resolveCommand(['eval', 'git', 'commit'])).toEqual({ inner: 'git commit' })
})

test('vercel: protected project by name or by id, linked or named', async () => {
  const byName = { config: { ...CFG, vercelProjects: ['locked-app'] } }
  const byId = { config: { ...CFG, vercelProjects: ['prj_abc123'] } }
  // /w/vprot is not a protected repo, but its folder is linked to the project (.vercel/project.json).
  for (const cmd of ['vercel deploy --prod', 'vercel', 'vercel env add X', 'vercel --prod', 'vercel pull', 'npx vercel --prod', 'vercel --cwd /w/vprot --prod']) {
    expect([cmd, await labels(cmd, '/w/vprot', byName)]).toEqual([cmd, ['Vercel locked-app']])
    expect([cmd, await labels(cmd, '/w/vprot', byId)]).toEqual([cmd, ['Vercel prj_abc123']])
  }
  expect(await labels('vercel deploy --prod', '/w/vprot/sub/dir', byName)).toEqual(['Vercel locked-app'])
  expect(await labels('cd /w/vprot && vercel --prod', '/w/mine', byName)).toEqual(['Vercel locked-app'])
  expect(await labels('vercel --cwd /w/vprot --prod', '/w/mine', byName)).toEqual(['Vercel locked-app'])
  // Named without being linked.
  expect(await labels('vercel link --project locked-app', '/w/other', byName)).toEqual(['Vercel locked-app'])
  expect(await labels('vercel link --project prj_abc123', '/w/other', byId)).toEqual(['Vercel prj_abc123'])
  expect(await labels('vercel link --project LOCKED-APP --yes', '/w/other', byName)).toEqual(['Vercel locked-app'])
  expect(await labels('vercel link locked-app', '/w/other', byName)).toEqual(['Vercel locked-app'])
  expect(await labels('vercel link --project=locked-app', '/w/other', byName)).toEqual(['Vercel locked-app'])
  // Detail and key of the block.
  const hits = await checkBash('vercel deploy --prod', deps('/w/vprot', byName))
  expect(hits).toEqual([{ key: 'vercel:locked-app', label: 'Vercel locked-app', detail: 'vercel deploy' }])
  // Reads stay allowed, protected or not.
  for (const cmd of ['vercel ls', 'vercel logs x', 'vercel inspect x', 'vercel whoami', 'vercel env ls', 'vercel project ls']) {
    expect([cmd, (await labels(cmd, '/w/vprot', byName)).length]).toEqual([cmd, 0])
  }
  // A linked project that is not in the list, or someone else's name.
  expect(await labels('vercel --prod', '/w/vfree', byName)).toEqual([])
  expect(await labels('vercel --prod', '/w/vprot', { config: { ...CFG, vercelProjects: ['otro'] } })).toEqual([])
  expect(await labels('vercel link --project free-app', '/w/other', byName)).toEqual([])
  expect(await labels('vercel --prod', '/w/nogit', byName)).toEqual([])
  // With no list (the default) nothing changes, the link is not even looked up.
  expect(await labels('vercel --prod', '/w/vprot')).toEqual([])
  let asked = 0
  await labels('vercel --prod', '/w/vprot', { vercelLinked: async () => (asked++, { name: 'locked-app', id: '' }) })
  expect(asked).toBe(0)
  // If reading the link fails, it does not blow up: the repo rule remains.
  expect(await labels('vercel --prod', '/w/crm', { ...byName, vercelLinked: async () => { throw new Error('x') } })).toEqual(['acme/crm'])
  // Linked to a protected project AND inside a protected repo: both count.
  expect(await labels('vercel --prod', '/w/crm', { ...byName, vercelLinked: async () => ({ name: 'locked-app', id: '' }) })).toEqual(['Vercel locked-app', 'acme/crm'])
})

test('gitWrites: subcommand matrix', () => {
  const w = (sub: string, ...rest: string[]) => gitWrites(sub, rest)
  expect([w('commit'), w('push'), w('add', '.'), w('tag', 'v1'), w('branch', 'x'), w('checkout', '-b', 'x'), w('stash')]).toEqual([true, true, true, true, true, true, true])
  expect([w('log'), w('diff'), w('status'), w('show'), w('fetch'), w('clone'), w('pull'), w('tag'), w('branch'), w('checkout', 'main'), w('switch', 'main'), w('stash', 'list')]).toEqual(Array(12).fill(false))
})

test('config: empty defaults, created file, errors and missing keys', () => {
  for (const list of Object.values(DEFAULT_CONFIG)) expect(list).toEqual([])
  expect(parseConfig(defaultConfigText())).toEqual(DEFAULT_CONFIG)
  expect(JSON.parse(defaultConfigText())).toHaveProperty('_note')
  expect(JSON.parse(defaultConfigText())).not.toHaveProperty('_nota')
  expect(parseConfig('{"repos":["A/b"]}')).toEqual({ repos: ['A/b'], railwayProjects: [], vercelProjects: [], neonProjects: [], supabaseProjects: [] })
  expect(parseConfig('no es json')).toBe(null)
  expect(parseConfig('{"repos":"A/b"}')).toBe(null)
  expect(parseConfig('[]')).toBe(null)
  expect(parseConfig('{"vercelProjects":["Prj","prj_1"]}')?.vercelProjects).toEqual(['Prj', 'prj_1'])
  expect(parseConfig('{"vercelProjects":"x"}')).toBe(null)
  expect(JSON.parse(defaultConfigText())).toHaveProperty('vercelProjects', [])
  expect(JSON.parse(defaultConfigText())).toHaveProperty('neonProjects', [])
  expect(JSON.parse(defaultConfigText())).toHaveProperty('supabaseProjects', [])
  expect(parseConfig('{"neonProjects":["a-b-1"],"supabaseProjects":["abcdefghijklmnopqrst"]}')).toMatchObject({ neonProjects: ['a-b-1'], supabaseProjects: ['abcdefghijklmnopqrst'] })
  expect(parseConfig('{"neonProjects":"x"}')).toBe(null)
  expect(parseConfig('{"supabaseProjects":[1]}')).toBe(null)
})

test('config: a key from an older version is ignored without failing', () => {
  // The old key is assembled from pieces so this file stays free of the old concept's name.
  const oldKey = ['ter', 'ceros'].join('')
  const parsed = parseConfig(JSON.stringify({ repos: ['A/b'], [oldKey]: ['A/b'], someKeyOfMine: 1 }))
  expect(parsed).toEqual({ repos: ['A/b'], railwayProjects: [], vercelProjects: [], neonProjects: [], supabaseProjects: [] })
  expect(parsed).not.toHaveProperty(oldKey)
  // Even a value of the wrong type under that key is just ignored.
  expect(parseConfig(JSON.stringify({ [oldKey]: 'x' }))).toEqual(DEFAULT_CONFIG)
})

test('config: migrating the previous version\'s file keeps its lists and extra keys, and swaps the note', () => {
  const oldKey = ['ter', 'ceros'].join('')
  const old = JSON.stringify({ _nota: 'old note', repos: ['A/b', 'C/d'], [oldKey]: ['C/d'], railwayProjects: ['r'], vercelProjects: [], mine: { a: 1 } })
  const migrated = migrateConfig(old)
  if (!migrated) throw new Error('migration failed')
  expect(migrated.config).toEqual({ repos: ['A/b', 'C/d'], railwayProjects: ['r'], vercelProjects: [], neonProjects: [], supabaseProjects: [] })
  const out = JSON.parse(migrated.text) as Record<string, unknown>
  expect(out).not.toHaveProperty('_nota')
  expect(typeof out._note).toBe('string')
  expect(out.repos).toEqual(['A/b', 'C/d'])
  expect(out.railwayProjects).toEqual(['r'])
  expect(out.mine).toEqual({ a: 1 })
  expect(migrateConfig('{ broken')).toBe(null)
  expect(migrateConfig('{"repos":"x"}')).toBe(null)
})

test('deny text: English and Spanish, generic, with the pass command and the detail', async () => {
  const api = await checkBash('git commit -m x', deps('/w/fleet'))
  expect(denyText(api, EN)).toBe(
    'Hands Off: acme/api is protected — read yes, write no. If it needs a change, ask its owner. ' +
      'For a one-time exception a person must type /handsoff pass. Do not work around this with another command. [blocked: git commit]',
  )
  const es = denyText(api, ES)
  expect(es).toContain('Intocables: acme/api está protegido — leer sí, escribir no.')
  expect(es).toContain('pídeselo a su dueño')
  expect(es).toContain('/intocables pase')
  expect(es).toContain('[bloqueado: git commit]')
  // More than one target.
  const two = await checkBash('git -C /w/fleet commit -m x && git -C /w/crm commit -m y', deps('/w/mine'))
  expect(denyText(two, EN)).toContain('acme/api is protected — read yes, write no (also: acme/crm).')
  expect(denyText(two, ES)).toContain('(también: acme/crm)')
  // The detail of a redirect or an edit follows the language too.
  const redirect = await checkBash('echo hi > out.txt', deps('/w/fleet'))
  expect(redirect[0]?.detail).toBe('redirect to out.txt')
  const redirectEs = await checkBash('echo hi > out.txt', deps('/w/fleet', { words: ES }))
  expect(redirectEs[0]?.detail).toBe('redirección a out.txt')
  expect((await checkPath('src/a.ts', deps('/w/fleet')))[0]?.detail).toBe('edit of a.ts')
  expect((await checkPath('src/a.ts', deps('/w/fleet', { words: ES })))[0]?.detail).toBe('edición de a.ts')
})

test('words: no user-facing string names a person or a company, in either language', () => {
  const dump = (w: object): string[] => Object.values(w).flatMap(v => (typeof v === 'string' ? [v] : typeof v === 'object' && v !== null ? dump(v) : []))
  // The words are assembled from pieces so this file does not contain them itself.
  const personal = new RegExp(['jos[eé]', 'edmon' + 'd', 'timeka' + 'st', 'fact' + 'ory', 'aditi' + 'vo', 'ter' + 'cero'].join('|'), 'i')
  for (const w of [EN, ES]) for (const text of dump(w)) expect(text).not.toMatch(personal)
  // Both languages have the same shape.
  expect(Object.keys(ES).sort()).toEqual(Object.keys(EN).sort())
})

test('passes: cover every key, are spent together and expire after 10 minutes', () => {
  const T = 1_000_000
  const p = (key: string, at = T) => ({ key, at })
  expect(spendPasses([p('a')], ['a'], T + 1000)).toEqual({ ok: true, left: [] })
  expect(spendPasses([p('a'), p('b')], ['a'], T + 1000)).toEqual({ ok: true, left: [p('b')] })
  expect(spendPasses([p('a')], ['a', 'b'], T + 1000)).toEqual({ ok: false, left: [p('a')] })
  expect(spendPasses([p('a')], ['b'], T).ok).toBe(false)
  expect(spendPasses([p('a')], ['a'], T + 10 * 60_000).ok).toBe(true)
  expect(spendPasses([p('a')], ['a'], T + 10 * 60_000 + 1)).toEqual({ ok: false, left: [] })
  expect(spendPasses([], [], T).ok).toBe(false)
})

test('editConfig: adds and removes keeping the person\'s own keys; never overwrites an unreadable file', () => {
  const base = JSON.stringify({ _note: 'x', extra: 1, repos: ['A/b'], railwayProjects: [], vercelProjects: [] })
  const added = editConfig(base, { op: 'addRepo', slug: 'git@github.com:C/d.git' }, EN)
  if ('error' in added) throw new Error(added.error)
  expect(JSON.parse(added.text)).toEqual({ _note: 'x', extra: 1, repos: ['A/b', 'C/d'], railwayProjects: [], vercelProjects: [], neonProjects: [], supabaseProjects: [] })
  expect(added.changed).toBe('C/d added')
  const removed = editConfig(added.text, { op: 'removeRepo', slug: 'C/D' }, EN)
  if ('error' in removed) throw new Error(removed.error)
  expect(removed.config).toEqual({ repos: ['A/b'], railwayProjects: [], vercelProjects: [], neonProjects: [], supabaseProjects: [] })
  expect(removed.changed).toBe('C/d removed')
  expect('error' in editConfig(base, { op: 'addRepo', slug: 'a/B' }, EN)).toBe(true)
  expect('error' in editConfig(base, { op: 'addRepo', slug: 'nothing' }, EN)).toBe(true)
  expect('error' in editConfig('{ broken', { op: 'addRailway', name: 'x' }, EN)).toBe(true)
  const fresh = editConfig(null, { op: 'addRailway', name: 'bob' }, EN)
  if ('error' in fresh) throw new Error(fresh.error)
  expect(fresh.config.railwayProjects).toEqual(['bob'])
  expect(cleanSlug('https://github.com/acme/api')).toBe('acme/api')
  expect(cleanSlug('-q/x')).toBeNull()
  expect(cleanSlug('a/--jq')).toBeNull()
  expect(cleanRailway('a/b')).toBeNull()
  expect(cleanVercel('a/b')).toBeNull()
  expect(cleanVercel('with space')).toBeNull()
  expect(cleanVercel('   ')).toBeNull()
  expect(cleanVercel(' prj_abc123 ')).toBe('prj_abc123')
  expect(ago(0, EN)).toBe('just now')
  expect(ago(3 * 60_000, EN)).toBe('3 min ago')
  expect(ago(2 * 3_600_000, EN)).toBe('2 h ago')
  expect(ago(3 * 86_400_000, EN)).toBe('3 d ago')
  expect(ago(0, ES)).toBe('ahora')
  expect(ago(3 * 60_000, ES)).toBe('hace 3 min')
  expect(ago(2 * 3_600_000, ES)).toBe('hace 2 h')
  // The same edit in Spanish speaks Spanish.
  const es = editConfig(base, { op: 'addRepo', slug: 'git@github.com:C/d.git' }, ES)
  if ('error' in es) throw new Error(es.error)
  expect(es.changed).toBe('C/d agregado')
  const dupEs = editConfig(base, { op: 'addRepo', slug: 'a/B' }, ES)
  expect('error' in dupEs && dupEs.error).toBe('a/B ya está en la lista')
  const badEs = editConfig('{ broken', { op: 'addRailway', name: 'x' }, ES)
  expect('error' in badEs && badEs.error).toContain('JSON válido')
})

test('editConfig: adds and removes Vercel projects (name or prj_), keeps the rest and rejects duplicates and invalid ones', () => {
  const base = JSON.stringify({ _note: 'x', extra: 1, repos: ['A/b'], railwayProjects: ['r'] })
  const added = editConfig(base, { op: 'addVercel', name: ' mi-app ' }, EN)
  if ('error' in added) throw new Error(added.error)
  expect(added.changed).toBe('Vercel mi-app added')
  expect(JSON.parse(added.text)).toEqual({ _note: 'x', extra: 1, repos: ['A/b'], railwayProjects: ['r'], vercelProjects: ['mi-app'], neonProjects: [], supabaseProjects: [] })
  const withId = editConfig(added.text, { op: 'addVercel', name: 'prj_AbC123' }, EN)
  if ('error' in withId) throw new Error(withId.error)
  expect(withId.config.vercelProjects).toEqual(['mi-app', 'prj_AbC123'])
  // Duplicate (case-insensitive) and invalid: error, and nothing changes.
  for (const name of ['MI-APP', 'prj_abc123', '', '   ', 'a/b', 'two words', 'x'.repeat(101)]) {
    expect([name, 'error' in editConfig(withId.text, { op: 'addVercel', name }, EN)]).toEqual([name, true])
  }
  const dup = editConfig(withId.text, { op: 'addVercel', name: 'MI-APP' }, EN)
  expect('error' in dup && dup.error).toContain('is already in the list')
  const removed = editConfig(withId.text, { op: 'removeVercel', name: 'PRJ_ABC123' }, EN)
  if ('error' in removed) throw new Error(removed.error)
  expect(removed.config.vercelProjects).toEqual(['mi-app'])
  expect(removed.config.railwayProjects).toEqual(['r'])
  expect(removed.changed).toBe('Vercel prj_AbC123 removed')
  const missing = editConfig(removed.text, { op: 'removeVercel', name: 'nothing' }, EN)
  expect('error' in missing && missing.error).toContain('is not in the list')
  // A file without the key starts from [] and loses nothing; an unreadable one is not overwritten.
  const fresh = editConfig(null, { op: 'addVercel', name: 'bob' }, EN)
  if ('error' in fresh) throw new Error(fresh.error)
  expect(fresh.config.vercelProjects).toEqual(['bob'])
  expect(fresh.config.railwayProjects).toEqual([])
  expect('error' in editConfig('{ broken', { op: 'addVercel', name: 'x' }, EN)).toBe(true)
})

// ── Neon ────────────────────────────────────────────────────────────────────

const NEON_ID = 'proud-cloud-12345678'
const neonCfg = { config: { ...CFG, neonProjects: [NEON_ID] } }

test('neon: nx, neon, neonctl and runners; by --project-id, by .neon context and by --context-file', async () => {
  const writes = [
    'nx branches create --name x',
    'neon projects delete',
    'neonctl branches reset dev --parent',
    'neonctl databases create --name d',
    'neonctl roles reset-password bob',
    'neonctl roles create --name r',
    'nx ip-allow add 1.2.3.4',
    'nx set-context --project-id other-id-1',
    'npx neonctl branches delete dev',
    'npx -y neonctl projects update',
    'pnpm dlx neonctl branches set-default x',
    'pnpm neonctl branches restore x',
    'sudo nx branches rename a b',
    'nx branches add-compute',
  ]
  // By the folder's context (.neon).
  for (const cmd of writes.filter(c => !c.includes('--project-id'))) {
    expect([cmd, await labels(cmd, '/w/nprot', neonCfg)]).toEqual([cmd, [`Neon ${NEON_ID}`]])
    expect([cmd, await labels(cmd, '/w/nprot/sub/dir', neonCfg)]).toEqual([cmd, [`Neon ${NEON_ID}`]])
  }
  // By --project-id (also with =, in any order, any case), even if the folder is nobody's.
  expect(await labels(`nx branches create --project-id ${NEON_ID}`, '/w/other', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels(`nx branches create --project-id=${NEON_ID.toUpperCase()}`, '/w/other', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels(`nx --project-id ${NEON_ID} projects delete`, '/w/other', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels(`npx neonctl@latest branches delete --project-id ${NEON_ID} dev`, '/w/other', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels(`pnpm dlx neonctl@2.1.0 branches delete --project-id ${NEON_ID} dev`, '/w/other', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels(`nx set-context --project-id ${NEON_ID}`, '/w/other', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  // --project-id wins over the context: another project in a protected folder does not block.
  expect(await labels('nx branches create --project-id free-river-99999999', '/w/nprot', neonCfg)).toEqual([])
  // --context-file points at another file (relative to the command's directory).
  expect(await labels('nx branches create --context-file alt.json', '/w/other', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels('nx branches create --context-file=/w/other/alt.json', '/w/nfree', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels('nx branches create --context-file alt.json', '/w/nfree', neonCfg)).toEqual([])
  // And an unprotected --context-file wins over the folder's protected .neon.
  expect(await labels('nx branches create --context-file /w/nfree/alt.json', '/w/nprot', neonCfg)).toEqual([])
  // Detail and key.
  expect(await checkBash('nx branches create', deps('/w/nprot', neonCfg))).toEqual([{ key: `neon:${NEON_ID}`, label: `Neon ${NEON_ID}`, detail: 'neon branches create' }])
})

test('neon: reads, --help and unprotected projects pass; with no list no file is read', async () => {
  const reads = [
    'nx branches list',
    'nx branches get main',
    'nx branches schema-diff main dev',
    'nx connection-string',
    'nx connection-string main --psql',
    'nx projects list',
    'nx projects get',
    'nx databases list',
    'nx roles list',
    'nx ip-allow list',
    'nx operations list',
    'nx me',
    'nx orgs list',
    'neonctl branches create --help',
    'neonctl projects delete -h',
    'neonctl --version',
    'nx',
    'nx build my-app',
    'nx run-many -t test',
    'nx affected --target=build',
  ]
  for (const cmd of reads) expect([cmd, await labels(cmd, '/w/nprot', neonCfg)]).toEqual([cmd, []])
  // Unprotected project (free context, no context, or someone else's --project-id).
  expect(await labels('nx branches create', '/w/nfree', neonCfg)).toEqual([])
  expect(await labels('nx branches create', '/w/other', neonCfg)).toEqual([])
  expect(await labels('nx branches create --project-id otro-id-12345678', '/w/other', neonCfg)).toEqual([])
  // Empty list (the default): the context is not even looked up.
  let asked = 0
  const spy = { neonContext: async () => (asked++, NEON_ID) }
  expect(await labels('nx branches create', '/w/nprot', spy)).toEqual([])
  expect(asked).toBe(0)
  // If reading the context fails, it does not blow up: the repo rule remains.
  expect(await labels('nx branches create', '/w/crm', { ...neonCfg, neonContext: async () => { throw new Error('x') } })).toEqual(['acme/crm'])
  // Protected repo AND protected Neon project: both count.
  expect(await labels('nx branches create', '/w/crm', { ...neonCfg, neonContext: async () => NEON_ID })).toEqual([`Neon ${NEON_ID}`, 'acme/crm'])
})

test('neon: works through cd, bash -c and substitutions', async () => {
  expect(await labels('cd /w/nprot && nx branches delete dev', '/w/other', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels("bash -c 'nx projects delete'", '/w/nprot', neonCfg)).toEqual([`Neon ${NEON_ID}`])
  expect(await labels('echo "nx branches delete dev"', '/w/nprot', neonCfg)).toEqual([])
})

// ── Supabase ────────────────────────────────────────────────────────────────

const supaCfg = { config: { ...CFG, supabaseProjects: [REF] } }

test('supabase: writes by --project-ref, by the linked ref and by --workdir', async () => {
  const writes = [
    'supabase db push',
    'supabase db push --linked',
    'supabase db reset --linked',
    'supabase db reset --db-url postgresql://u:p@host:5432/postgres',
    'supabase migration repair --status applied 2024',
    'supabase migration up --linked',
    'supabase functions deploy hello',
    'supabase functions delete hello',
    'supabase secrets set A=1',
    'supabase secrets unset A',
    'supabase unlink',
    'supabase link',
    'supabase projects delete',
    'supabase config push',
    'supabase storage rm ss:///bucket/a.txt',
    'supabase storage cp ./a.txt ss:///bucket/a.txt',
    'supabase storage mv ss:///b/a ss:///b/b',
    'supabase branches create x',
    'supabase branches delete x',
    'supabase branches update x',
    'supabase branches disable',
    'supabase postgres-config update --config a=1',
    'supabase postgres-config delete --config a',
    'supabase domains create --custom-hostname x.com',
    'supabase domains activate',
    'supabase domains delete',
    'supabase domains reverify',
    'supabase vanity-subdomains activate --desired-subdomain x',
    'supabase vanity-subdomains delete',
    'supabase network-restrictions update --db-allow-cidr 1.2.3.4/32',
    'supabase ssl-enforcement update --enable-db-ssl-enforcement',
    'supabase sso add --type saml',
    'supabase sso update id',
    'supabase sso remove id',
    'supabase backups restore --timestamp 1',
    'npx supabase db push',
    'pnpm dlx supabase db push',
    'pnpm supabase functions deploy',
    'npx supabase@latest db push',
  ]
  // Linked by supabase/.temp/project-ref.
  for (const cmd of writes) {
    expect([cmd, await labels(cmd, '/w/sprot', supaCfg)]).toEqual([cmd, [`Supabase ${REF}`]])
    expect([cmd, await labels(cmd, '/w/sprot/app/src', supaCfg)]).toEqual([cmd, [`Supabase ${REF}`]])
  }
  // By --project-ref (and =), whatever the folder.
  expect(await labels(`supabase db push --project-ref ${REF}`, '/w/other', supaCfg)).toEqual([`Supabase ${REF}`])
  expect(await labels(`supabase link --project-ref=${REF.toUpperCase()}`, '/w/other', supaCfg)).toEqual([`Supabase ${REF}`])
  expect(await labels(`supabase projects delete ${REF}`, '/w/other', supaCfg)).toEqual([`Supabase ${REF}`])
  expect(await labels(`supabase db reset --db-url postgresql://postgres.${REF}:pw@aws-0.pooler.supabase.com:6543/postgres`, '/w/other', supaCfg)).toEqual([`Supabase ${REF}`])
  // Someone else's --project-ref wins over the link.
  expect(await labels('supabase db push --project-ref zzzzzzzzzzzzzzzzzzzz', '/w/sprot', supaCfg)).toEqual([])
  expect(await labels('supabase db reset --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres', '/w/sprot', supaCfg)).toEqual([])
  expect(await labels('supabase db reset --db-url postgresql://u:p@other.example.com/db', '/w/sprot', supaCfg)).toEqual([`Supabase ${REF}`])
  // --workdir is used as it is, without searching upwards.
  expect(await labels('supabase db push --workdir /w/sprot', '/w/other', supaCfg)).toEqual([`Supabase ${REF}`])
  expect(await labels('supabase --workdir=/w/sprot functions deploy x', '/w/other', supaCfg)).toEqual([`Supabase ${REF}`])
  expect(await labels('supabase db push --workdir /w/sprot/app', '/w/other', supaCfg)).toEqual([])
  expect(await labels('supabase db push --workdir /w/sfree', '/w/sprot', supaCfg)).toEqual([])
  expect(await labels('cd /w/sprot && supabase db push', '/w/other', supaCfg)).toEqual([`Supabase ${REF}`])
  // Detail and key.
  expect(await checkBash('supabase db push', deps('/w/sprot', supaCfg))).toEqual([{ key: `supabase:${REF}`, label: `Supabase ${REF}`, detail: 'supabase db push' }])
})

test('supabase: reads, local reset and unprotected projects pass; with no list the link is not read', async () => {
  const reads = [
    'supabase status',
    'supabase projects list',
    'supabase functions list',
    'supabase functions download hello',
    'supabase secrets list',
    'supabase db pull',
    'supabase db diff',
    'supabase db dump -f out.sql',
    'supabase db lint',
    'supabase db reset',
    'supabase db reset --local',
    'supabase db push --dry-run',
    'supabase db push --local',
    'supabase inspect db bloat',
    'supabase gen types typescript --linked',
    'supabase migration list',
    'supabase migration up',
    'supabase migration repair --local --status applied 1',
    'supabase storage ls ss:///bucket',
    'supabase storage cp ss:///bucket/a.txt ./a.txt',
    'supabase storage cp ./a ./b',
    'supabase branches list',
    'supabase branches get x',
    'supabase db push --help',
    'supabase --version',
    'supabase start',
    'supabase',
  ]
  for (const cmd of reads) expect([cmd, await labels(cmd, '/w/sprot', supaCfg)]).toEqual([cmd, []])
  // Linked to another project, or not linked.
  expect(await labels('supabase db push', '/w/sfree', supaCfg)).toEqual([])
  expect(await labels('supabase db push', '/w/other', supaCfg)).toEqual([])
  let asked = 0
  expect(await labels('supabase db push', '/w/sprot', { supabaseLinked: async () => (asked++, REF) })).toEqual([])
  expect(asked).toBe(0)
  expect(await labels('supabase db push', '/w/crm', { ...supaCfg, supabaseLinked: async () => { throw new Error('x') } })).toEqual(['acme/crm'])
  expect(await labels('supabase db push', '/w/crm', { ...supaCfg, supabaseLinked: async () => REF })).toEqual([`Supabase ${REF}`, 'acme/crm'])
})

// ── MCP ─────────────────────────────────────────────────────────────────────

const mcpCfg = { ...CFG, neonProjects: [NEON_ID], supabaseProjects: [REF] }

test('checkMcp: writes on a protected project are blocked; reads are not', () => {
  const hit = (tool: string, input: Record<string, unknown>) => checkMcp(tool, input, mcpCfg).map(h => h.label)
  // Neon
  for (const tool of ['run_sql', 'run_sql_transaction', 'create_branch', 'delete_branch', 'prepare_database_migration', 'complete_database_migration', 'reset_from_parent', 'delete_project', 'update_project', 'create_postgres_role', 'finalize_branch_restore', 'restore_snapshot', 'set_default_branch', 'provision_neon_auth']) {
    expect([tool, hit(`mcp__Neon__${tool}`, { projectId: NEON_ID, sql: 'drop table x' })]).toEqual([tool, [`Neon ${NEON_ID}`]])
  }
  for (const tool of ['get_project', 'list_branches', 'describe_project', 'describe_table_schema', 'get_database_tables', 'get_connection_string', 'list_projects', 'search', 'fetch', 'explain_sql_statement', 'compare_database_schema', 'list_slow_queries', 'query_logs', 'get_operation']) {
    expect([tool, hit(`mcp__Neon__${tool}`, { projectId: NEON_ID })]).toEqual([tool, []])
  }
  // Supabase
  for (const tool of ['execute_sql', 'apply_migration', 'deploy_edge_function', 'create_branch', 'delete_branch', 'merge_branch', 'rebase_branch', 'reset_branch', 'pause_project', 'restore_project', 'create_project']) {
    expect([tool, hit(`mcp__supabase__${tool}`, { project_id: REF })]).toEqual([tool, [`Supabase ${REF}`]])
  }
  for (const tool of ['list_tables', 'list_extensions', 'list_migrations', 'get_logs', 'get_advisors', 'get_project_url', 'get_publishable_keys', 'generate_typescript_types', 'list_edge_functions', 'get_edge_function', 'search_docs']) {
    expect([tool, hit(`mcp__supabase__${tool}`, { project_id: REF })]).toEqual([tool, []])
  }
  // The other keys, whatever the case of the value; an id can be in both lists.
  expect(hit('mcp__x__run_sql', { project_ref: REF.toUpperCase() })).toEqual([`Supabase ${REF}`])
  expect(hit('mcp__x__run_sql', { projectRef: REF })).toEqual([`Supabase ${REF}`])
  expect(hit('mcp__x__run_sql', { projectId: NEON_ID.toUpperCase() })).toEqual([`Neon ${NEON_ID}`])
  const both = { ...mcpCfg, supabaseProjects: [NEON_ID] }
  expect(checkMcp('mcp__x__run_sql', { project_id: NEON_ID }, both).map(h => h.label)).toEqual([`Neon ${NEON_ID}`, `Supabase ${NEON_ID}`])
  // Detail and key.
  expect(checkMcp('mcp__Neon__run_sql', { projectId: NEON_ID }, mcpCfg)).toEqual([{ key: `neon:${NEON_ID}`, label: `Neon ${NEON_ID}`, detail: 'mcp run_sql' }])
  // Unprotected project, no id, an id that is not text, or empty lists: passes.
  expect(hit('mcp__Neon__run_sql', { projectId: 'otro-id-12345678' })).toEqual([])
  expect(hit('mcp__Neon__run_sql', { sql: 'select 1' })).toEqual([])
  expect(hit('mcp__Neon__run_sql', { projectId: 42, project_id: null })).toEqual([])
  expect(checkMcp('mcp__Neon__run_sql', { projectId: NEON_ID }, DEFAULT_CONFIG)).toEqual([])
  // Each id is compared with its own list: a Supabase ref in a Neon tool is still the Supabase project.
  expect(hit('mcp__Neon__run_sql', { projectId: REF })).toEqual([`Supabase ${REF}`])
})

// ── editConfig: Neon and Supabase ─────────────────────────────────────────────

test('editConfig: adds and removes Neon projects, keeps the rest and rejects duplicates and invalid ones', () => {
  const base = JSON.stringify({ _note: 'x', extra: 1, repos: ['A/b'], railwayProjects: ['r'] })
  const added = editConfig(base, { op: 'addNeon', id: ' proud-cloud-12345678 ' }, EN)
  if ('error' in added) throw new Error(added.error)
  expect(added.changed).toBe('Neon proud-cloud-12345678 added')
  expect(JSON.parse(added.text)).toEqual({ _note: 'x', extra: 1, repos: ['A/b'], railwayProjects: ['r'], vercelProjects: [], neonProjects: ['proud-cloud-12345678'], supabaseProjects: [] })
  const second = editConfig(added.text, { op: 'addNeon', id: 'abc' }, EN)
  if ('error' in second) throw new Error(second.error)
  expect(second.config.neonProjects).toEqual(['proud-cloud-12345678', 'abc'])
  for (const id of ['PROUD-CLOUD-12345678', 'proud-cloud-12345678', '', '   ', 'ab', 'with space', 'a/b', 'a_b_c', 'x'.repeat(101)]) {
    expect([id, 'error' in editConfig(second.text, { op: 'addNeon', id }, EN)]).toEqual([id, true])
  }
  const dup = editConfig(second.text, { op: 'addNeon', id: 'abc' }, EN)
  expect('error' in dup && dup.error).toContain('is already in the list')
  const removed = editConfig(second.text, { op: 'removeNeon', id: 'ABC' }, EN)
  if ('error' in removed) throw new Error(removed.error)
  expect(removed.config.neonProjects).toEqual(['proud-cloud-12345678'])
  expect(removed.changed).toBe('Neon abc removed')
  const missing = editConfig(removed.text, { op: 'removeNeon', id: 'nothing' }, EN)
  expect('error' in missing && missing.error).toContain('is not in the list')
  expect('error' in editConfig('{ broken', { op: 'addNeon', id: 'abc' }, EN)).toBe(true)
  expect(cleanNeon('ab')).toBeNull()
  expect(cleanNeon('Abc')).toBeNull()
  expect(cleanNeon(' a-1 ')).toBe('a-1')
})

test('editConfig: adds and removes Supabase projects (20 letters), keeps the rest and rejects duplicates and invalid ones', () => {
  const base = JSON.stringify({ _note: 'x', extra: 1, repos: ['A/b'], railwayProjects: ['r'], neonProjects: ['n-1-2'] })
  const added = editConfig(base, { op: 'addSupabase', ref: ` ${REF} ` }, EN)
  if ('error' in added) throw new Error(added.error)
  expect(added.changed).toBe(`Supabase ${REF} added`)
  expect(JSON.parse(added.text)).toEqual({ _note: 'x', extra: 1, repos: ['A/b'], railwayProjects: ['r'], vercelProjects: [], neonProjects: ['n-1-2'], supabaseProjects: [REF] })
  for (const ref of [REF, REF.toUpperCase(), '', 'abc', `${REF}a`, 'abcdefghijklmnopqrs1', 'abcdefghijklmnopqrs-', 'abcdefghij klmnopqrst']) {
    expect([ref, 'error' in editConfig(added.text, { op: 'addSupabase', ref }, EN)]).toEqual([ref, true])
  }
  const dup = editConfig(added.text, { op: 'addSupabase', ref: REF }, EN)
  expect('error' in dup && dup.error).toContain('is already in the list')
  const removed = editConfig(added.text, { op: 'removeSupabase', ref: REF.toUpperCase() }, EN)
  if ('error' in removed) throw new Error(removed.error)
  expect(removed.config.supabaseProjects).toEqual([])
  expect(removed.config.neonProjects).toEqual(['n-1-2'])
  expect(removed.changed).toBe(`Supabase ${REF} removed`)
  const missing = editConfig(removed.text, { op: 'removeSupabase', ref: REF }, EN)
  expect('error' in missing && missing.error).toContain('is not in the list')
  expect('error' in editConfig('{ broken', { op: 'addSupabase', ref: REF }, EN)).toBe(true)
  expect(cleanSupabase(REF)).toBe(REF)
  expect(cleanSupabase('short')).toBeNull()
})

test('checkMcp: explain with analyze runs the query, so it counts as a write', () => {
  const config = { ...CFG, neonProjects: ['proud-cloud-12345678'] }
  expect(checkMcp('mcp__Neon__explain_sql_statement', { projectId: 'proud-cloud-12345678', sql: 'delete from t', analyze: true }, config).length).toBe(1)
  expect(checkMcp('mcp__Neon__explain_sql_statement', { projectId: 'proud-cloud-12345678', sql: 'select 1' }, config)).toEqual([])
})

// ── forks: gh writes go to the PARENT of a fork ────────────────────────────

test('in a fork with an upstream remote, gh writes reach the protected original and are blocked', async () => {
  expect(await labels('gh pr create --fill', '/w/forkup')).toEqual(['acme/api'])
  expect(await labels('gh issue create --title x', '/w/forkup')).toEqual([], 'filing a ticket is allowed')
  expect(await labels('gh pr merge 12 --squash', '/w/forkup')).toEqual(['acme/api'])
  const hit = await checkBash('gh pr comment 3 --body hi', deps('/w/forkup'))
  expect(hit.map(h => h.detail)).toEqual(['gh pr comment'])
  expect(await labels('gh api -X POST repos/{owner}/{repo}/issues -f title=x', '/w/forkup')).toEqual([])
  expect(await labels('gh api -X PATCH repos/{owner}/{repo}/issues/3 -f state=closed', '/w/forkup')).toEqual(['acme/api'])
  expect(await labels('gh api graphql -f query=\'mutation { addStar(input:{starrableId:"x"}) { clientMutationId } }\'', '/w/forkup')).toEqual(['acme/api'])
})

test('in that fork, reads, git and a command that names its own repo are not blocked', async () => {
  expect(await labels('gh pr view 1', '/w/forkup')).toEqual([])
  expect(await labels('gh pr list', '/w/forkup')).toEqual([])
  expect(await labels('gh api repos/{owner}/{repo}/issues', '/w/forkup')).toEqual([])
  expect(await labels('git push', '/w/forkup')).toEqual([])
  expect(await labels('git commit -m x', '/w/forkup')).toEqual([])
  // the named repo decides: the layers do not apply
  expect(await labels('gh pr create -R someone/fork --fill', '/w/forkup')).toEqual([])
  expect(await labels('GH_REPO=someone/fork gh pr create --fill', '/w/forkup')).toEqual([])
  expect(await labels('gh pr merge https://github.com/someone/fork/pull/3', '/w/forkup')).toEqual([])
  expect(await labels('gh pr create -R acme/api --fill', '/w/forkup')).toEqual(['acme/api'])
})

test('a fork with no upstream remote: the parent that GitHub names decides', async () => {
  const asked: string[] = []
  const parentIs = (parent: string | null | undefined) => async (slug: string) => {
    asked.push(slug)
    return parent
  }
  expect(await labels('gh pr create --fill', '/w/forknp', { parentOf: parentIs('acme/api') })).toEqual(['acme/api'])
  expect(await labels('gh api -X PATCH repos/{owner}/{repo}/issues/3 -f state=closed', '/w/forknp', { parentOf: parentIs('ACME/API') })).toEqual(['acme/api'])
  expect(asked).toEqual(['someone/fork', 'someone/fork'])
  expect(await labels('gh pr create --fill', '/w/forknp', { parentOf: parentIs('other/lib') })).toEqual([])
  expect(await labels('gh pr create --fill', '/w/forknp', { parentOf: parentIs(null) })).toEqual([])
})

test('when GitHub cannot be asked the command goes through and one warning is raised', async () => {
  const warned: string[] = []
  const over = { parentOf: async () => undefined, warn: (key: string) => void warned.push(key) }
  expect(await labels('gh pr create --fill', '/w/forknp', over)).toEqual([])
  expect(warned).toEqual(['forkUnchecked'])
  // the same command (several gh in one line) asks only once
  warned.length = 0
  expect(await labels('gh pr create --fill && gh issue create --title x', '/w/forknp', over)).toEqual([])
  expect(warned).toEqual(['forkUnchecked'])
  // a protected remote found locally never needs GitHub
  warned.length = 0
  expect(await labels('gh pr create --fill', '/w/forkup', over)).toEqual(['acme/api'])
  expect(warned).toEqual([])
})

test('GitHub is not asked for reads, git, named repos, non-GitHub origins, or when nothing is protected', async () => {
  let asked = 0
  const over = { parentOf: async () => (asked++, 'acme/api' as string | null) }
  for (const cmd of ['gh pr view 1', 'git push', 'gh pr create -R someone/fork', 'gh api repos/{owner}/{repo}/issues', 'gh pr merge https://github.com/someone/fork/pull/3']) {
    expect([cmd, await labels(cmd, '/w/forknp', over)]).toEqual([cmd, []])
  }
  expect(asked).toBe(0)
  // an own repo that is not on GitHub: nothing to ask
  expect(await labels('gh pr create --fill', '/w/nogit', over)).toEqual([])
  expect(asked).toBe(0)
  // nothing protected: no network
  const none: Config = { ...CFG, repos: [] }
  expect(await labels('gh pr create --fill', '/w/forknp', { ...over, config: none })).toEqual([])
  expect(asked).toBe(0)
  // a protected origin is already a hit and does not need the parent either
  expect(await labels('gh pr create --fill', '/w/fleet', over)).toEqual(['acme/api'])
  expect(asked).toBe(0)
})

test('gh api with {owner}/{repo}: gh fills it from -R / GH_REPO, so that repo decides', async () => {
  const protectedRepo = CFG.repos[0]!
  expect(await labels(`gh api -R ${protectedRepo} -X PATCH repos/{owner}/{repo}/issues/3 -f state=closed`, '/w/mine')).toEqual([protectedRepo])
  expect(await labels(`GH_REPO=${protectedRepo} gh api -X PATCH repos/{owner}/{repo}/issues/3 -f state=closed`, '/w/mine')).toEqual([protectedRepo])
  expect(await labels('gh api -R someone/other -X PATCH repos/{owner}/{repo}/issues/3 -f state=closed', '/w/mine')).toEqual([])
})


test('tickets: filing an issue or commenting on one is allowed in a protected repo; changing issues is not', async () => {
  for (const cmd of [
    'gh issue create --title x',
    'gh issue create -R acme/api --title x --body-file t.md',
    'gh issue comment 4 -b hola',
    'gh issue comment 1 -R acme/crm -b hola',
    'gh api -X POST repos/acme/api/issues -f title=x',
    'gh api repos/acme/api/issues -f title=x',
    'gh api -X POST /repos/acme/server/issues/12/comments -f body=x',
  ]) expect([cmd, await blocked(cmd)]).toEqual([cmd, false])
  for (const cmd of [
    'gh issue edit 4 --title y',
    'gh issue close 4',
    'gh issue delete 4 --yes',
    'gh issue transfer 4 acme/other',
    'gh api -X PATCH repos/acme/api/issues/4 -f state=closed',
    'gh api -X DELETE repos/acme/api/issues/comments/9',
    'gh api -X POST repos/acme/api/issues/4/labels -f labels[]=x',
    'gh api -X POST repos/acme/api/pulls -f title=x',
  ]) expect([cmd, await blocked(cmd)]).toEqual([cmd, true])
})
