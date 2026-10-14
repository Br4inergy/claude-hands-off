# ✋ Hands Off

**Your AI agent can't push to a repo, deploy a project or drop a table that isn't yours.**

You open a client's repo to read how something works. Twenty minutes later the agent has "fixed" a bug in it,
committed, pushed and redeployed. Or it runs a migration against the production database you only meant to inspect.
It wasn't malicious: it was helpful, in the wrong place.

Today that is one of the most common ways AI-assisted work goes wrong: agents work across many repos, deploys and
databases at once, and nothing tells them which ones are **read-only for you**: a teammate's service, a client's
codebase, a vendor's starter kit, the shared production project.

Hands Off is that line. You list what isn't yours; the agent can still read everything, but every write to it stops
until **a person** says yes, once.

```
⏺ Bash(git push origin main)
  ⎿  Hands Off: acme/billing-api is protected — read yes, write no. If it needs a change, ask its owner.
     For a one-time exception a person must type /handsoff pass. Do not work around this with another command.
     [blocked: git push]

  Hands Off blocked git push on acme/billing-api. To allow it once: /handsoff pass
```

## Install

```
/plugin install hands-off --marketplace Br4inergy/claude-hands-off
```

Then type `/handsoff` to open the panel and add what you want to protect. Nothing is protected until you do.

## What it protects

| Where | What counts as a write | Still allowed |
| --- | --- | --- |
| **GitHub repos**, recognised by their `origin` remote, not the folder name (a clone under another name is still protected; your own fork is not; in a fork, `gh` commands that write go to the original by default: Hands Off checks every remote and, if needed, asks GitHub which repo it was forked from) | `git` commit, push, add, rm, reset, rebase, merge, tag, branch create/delete, stash, clean, cherry-pick…; `gh` pr/issue/release writes, `repo edit/delete`, `workflow run`, `api` POST/PUT/PATCH/DELETE; file edits (Edit, Write, `sed -i`, `rm`, `mv`, `>` redirects…) | log, diff, status, show, fetch, pull, clone, blame, `gh pr view/list`, any read |
| **Vercel** projects, by name or `prj_…` id | deploy, `link`, `env add/rm/pull`, `promote`… when the folder is linked to the project (`.vercel/project.json`) or the command names it | `ls`, `inspect`, `logs`, `whoami`, `env ls`, `dev` |
| **Railway** projects | `up`, `redeploy`, `down`, `variables --set`, `service`, `link`… when linked or named with `-p` | `status`, `logs`, `variables`, `list` |
| **Neon** projects, by id | `neon` / `neonctl` (and `npx neonctl`): branch, role, database and project changes, `set-context`… by `--project-id` or the folder's `.neon` context | `branches list/get`, `connection-string`, `projects list/get` |
| **Supabase** projects, by ref | `db push`, `db reset --linked`, `migration repair`, `functions deploy`, `secrets set`, `link`, `config push`… by `--project-ref` or the linked `supabase/.temp/project-ref` | `status`, `db pull/diff/dump`, `gen types`, `functions list`, local `db reset` |
| **MCP tools** (Neon, Supabase, any server that sends a `projectId` / `project_ref`) | `run_sql`, `execute_sql`, `apply_migration`, `deploy_edge_function`, `create_*`, `delete_*`, `update_*`… on a protected project | tools whose name starts with `get_`, `list_`, `describe_`, `search`, `fetch`, `inspect_`… |

Commands are read the way a shell reads them (quotes, heredocs, `$(...)`, `cd`, `git -C`, `bash -c`, `sudo`, `npx`), so
a repo name inside a commit message or a `grep` never triggers it. The remote is only looked up when a command has
the shape of a write.

## The pass: only a person can give it

- `/handsoff pass`: allows the **next** blocked call on what was just blocked, within 10 minutes, then it's spent.
- `/handsoff pass acme/billing-api` (or `vercel:<name>`, `neon:<id>`, `supabase:<ref>`): a pass in advance.
- Or press **One-time pass (10 min)** on a card in the panel, or **Give pass and retry** after a block.

The agent can't give itself a pass, and neither can another plugin: only a prompt a person typed, or a button a person
pressed, counts. A command that touches two protected things needs a pass for each.

## The panel

`/handsoff` opens it (terminal, desktop and phone):

- what is protected, one card per repo or project, with how many times it was blocked this session and what;
- active passes with their minutes left; **One-time pass (10 min)** and **Revoke pass**;
- fields to add a GitHub repo (`owner/repo` or its URL, checked with `gh repo view`), a Vercel, Railway, Neon or
  Supabase project; and to remove any (it asks you to confirm);
- the session's activity: every block and every pass used.

When the panel is showing, `/handsoff` leaves nothing in the conversation. `/handsoff status` prints a text summary.

## Your list

`~/.claude/hands-off.json`, created empty the first time and never overwritten by an update:

```json
{
  "repos": ["acme/billing-api", "acme/infra"],
  "vercelProjects": ["acme-web"],
  "railwayProjects": ["billing-worker"],
  "neonProjects": ["proud-cloud-12345678"],
  "supabaseProjects": ["abcdefghijklmnopqrst"]
}
```

If the file breaks, Hands Off keeps protecting the last list it read whole and tells you once.

## Designed to stay out of your way

- **Silent when nothing is protected is touched.** No tokens, no prompts, no questions; one line to the agent only
  when it blocks.
- **Fails open on its own errors.** If its own check fails or takes too long, the call goes through and you get one
  warning; it never locks you out of your machine.
- **Almost nothing over the network.** Links are read from the files the CLIs themselves write; the only commands it
  runs are `git remote get-url` and `git config --get-regexp` (to know a repo and its remotes), `gh repo view` when
  you add a repo, and one `gh repo view` per repo (cached for a week) when a `gh` command that writes runs in a repo
  you didn't protect, to learn whether it is a fork of one you did. If you protect no repo, that lookup never happens.

## Known limits

- For `git`, only the `origin` remote is checked (plus an explicit `git push` target).
- In your own fork of a protected repo, opening a PR between your fork's branches is also stopped, because `gh` aims at the original:
  use a pass or `gh pr create -R you/your-fork`. The fork check asks GitHub once per repo (cached a week) and lets the
  command through if GitHub can't be reached.
- Writes hidden inside a program (`python -c "open(...)"`, `node -e`) or an `xargs` are not seen.
- A raw `psql` (or any client) with a connection string is not seen.
- An MCP connection bound to a single project that doesn't send its project id can't be matched. GitHub's MCP tools are
  not covered.

## Language

English or Spanish, following Claude Code's language setting (then your system's locale). In Spanish it's called
**Intocables** and `/intocables` works too (`/intocables pase`, `/intocables estado`).

## Development

```
claude plugin validate <folder>
claude plugin test <folder>
```

`hooks/rules.ts` is pure (shell lexer, rules, passes, list edits) and tested in `tests/`; `hooks/register.tsx` wires
the disk, git, state and panel; `hooks/i18n.ts` holds every string in both languages.

## License

MIT. See [LICENSE](LICENSE).
