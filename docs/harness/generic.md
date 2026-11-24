# pstack in Generic Agent Harnesses (T3 Code / Antigravity / OpenCode / `.agents/skills`)

pstack skills use Cursor names. In any harness that supports the open `.agents/skills/` standard and `AGENTS.md` (such as T3 Code, Antigravity, OpenCode, or multi-provider orchestrators), read this file once per session and map Cursor names with the tables below. `<pstack>` means the folder that holds `skills/` and `docs/`. Never pass a field or value your host tool schema rejects.

## Tools

| Cursor | Generic / Orchestrator Host |
| --- | --- |
| `Task` | Use your host's subagent / delegation tool (e.g. `delegate_task`, `invoke_subagent`, or `task`). |
| `AskQuestion` | Use your host's structured question tool (`ask_question`) or ask in concise plain text. |
| Open a todolist, or copy steps into the todolist tool | Use your host's todo/plan tool if available; otherwise keep a concise checklist in your reply and update it per phase. |
| Run another pstack skill (`/name` or "the **name** skill") | Read `<pstack>/skills/<name>/SKILL.md` directly and follow it. |
| `Grep`, `Glob` | Use your host's search/find tools or `rg` via shell. |
| `watch-pr` (`scripts/watch-pr/watch-pr`) | Prefer your host's native PR watch tool (e.g. MCP `watch_pull_request`) when available; otherwise run `node <pstack>/skills/poteto-mode/scripts/watch-pr/watch-pr.ts` (Node 22.6+ zero-dependency) or `bun` if installed. |

## Subagent fields

| Cursor | Generic / Orchestrator Host |
| --- | --- |
| `subagent_type: generalPurpose` | Default worker subagent. |
| `poteto-agent`, `comment-sicko` | Spawn a worker subagent and put `Read <pstack>/skills/poteto-mode/worker.md before anything else.` plus the absolute path to `skills/poteto-mode/SKILL.md` (or `agents/comment-sicko.md`) at the top of its prompt. |
| `readonly: true` | Use a read-only/research/review subagent role, state `"do not edit any files"` in its prompt, and check `git status` afterward. |
| `environment: "cloud"` | Use isolated worktree mode (`isolation: "worktree"` or `git worktree add`). |
| `run_in_background: true` | Use async delegation (`mode: "async"`); do not poll in a loop. |
| `resume` | Spawn a fresh subagent with the prior result, branch, and worktree path. |

## Models

| Cursor | Generic / Orchestrator Host |
| --- | --- |
| Cursor model slugs (`claude-opus-5-5-xhigh-fast`, `gemini-4-neon-xhigh`, etc.) | Query your host's available models (e.g. `orchestrator_capabilities`) and map to real supported model IDs + effort options; if unavailable, omit model to inherit the parent session model. |
| `arena` / `interrogate` panels | Pick models from distinct vendors/families supported by your host; ensure `arena` cross-judge is a different vendor/family from the parent when possible. |
| `~/.cursor/rules/pstack-models.mdc` | `~/.agents/pstack-models.md` (referenced from global or project `AGENTS.md`). |

## Paths

| Cursor | Generic / Orchestrator Host |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.agents/skills/`, `~/.agents/skills/` |
| `.cursor/rules/*.mdc` | `AGENTS.md` |
| `~/.cursor/projects/<slug>/agent-transcripts/` | Your host's local session logs or thread-read tools (if none exist, rely on `git` + PR/issue history and note that chat transcripts are unavailable). |

## Cursor-only features

When a step requires Cursor Automations, Bugbot, Cursor cloud agents, or `cursor-team-kit`, write `Skipped in <host>: <step>. <reason>.` and continue. Use `gh` CLI or your host's native PR tools instead of Cursor's built-in PR tool.
