# BreakPilot Agent Guidance

BreakPilot is the Agent Runtime Debugger for this workspace.

Agent-facing artifacts live in:

- `agents/breakpilot-debugger.md`
- `skills/breakpilot-debugger/SKILL.md`

Use MCP first when available: `breakpilot mcp serve`.

Use the local daemon for CLI/IDE collaboration: `breakpilot serve --http-port 27890 --ide-bridge-port 27891`.

Internal tool definitions live in `src/control/`, not `src/mcp/`; MCP, HTTP, and CLI all share that control plane.

## Project-local Git Commit Rules

These rules apply only to this BreakPilot repository.

When Codex creates commits for this project, use Conventional Commits:

```text
<type>(<scope>): <summary>
```

- Write commit messages in English.
- Keep the summary imperative, specific, and 72 characters or fewer.
- Use lowercase `type` and `scope`.
- Prefer one focused logical change per commit.
- Do not stage or commit unrelated user changes.
- Before committing, inspect `git status --short` and `git diff --cached --stat`.
- If the worktree already contains unrelated changes, leave them unstaged unless the user explicitly asks to include them.
- Add a body when the change is non-trivial, changes behavior, or needs migration notes.
- Mention important verification in the body when useful, for example `Tests: npm test`.

Allowed commit types:

- `feat`: new user-facing behavior or capability
- `fix`: bug fix
- `docs`: documentation-only changes
- `test`: tests only
- `refactor`: restructuring without intended behavior change
- `perf`: performance improvement
- `build`: package, dependency, or build-system changes
- `ci`: CI or automation changes
- `chore`: maintenance that does not fit another type

Preferred scopes:

- `cli`
- `control`
- `mcp`
- `http`
- `ide`
- `dap`
- `inspection`
- `runtime`
- `sessions`
- `security`
- `docs`
- `test`
- `deps`
- `config`

Examples:

```text
feat(control): add shared tool router
fix(ide): handle missing bridge client
docs(mcp): document stdio server usage
refactor(inspection): split snapshot serialization helpers
```
