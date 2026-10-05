# context-x

A Claude Code mod that gives you a detailed, drill-down view of your context window.

- **Band above the prompt**: live `Context 42% 85k/1M` with one-click buttons for each view.
- **overview**: the categories `/context` shows, with bars.
- **messages**: every message ranked by size; select one to see its text, tool calls and tool results, largest first, with previews and clickable file paths.
- **agents**: every subagent this session ran, by total size; select one to rank its messages and drill into each.
- **tools**: every MCP tool (loaded or deferred) and custom agent, by size.
- **skills**: each skill listing and its token cost.
- **memory**: every CLAUDE.md / rules / memory file, with full clickable paths.

`/context-x` opens the pane too. **Refresh** re-estimates for free; **Exact count** uses the token-count API like `/context`.

Message sizes are estimates (characters / 4); category, tool, skill and memory figures come from Claude Code itself.

## Install

Requires a Claude Code build with function-hook plugins (2.1.286+).

```bash
git clone https://github.com/donroy26/context-x ~/.claude/skills/context-x
```

Start a new session (or run `/reload-plugins`).

---

Created at [Don's Bookshelf](https://donsbookshelf.com/)
