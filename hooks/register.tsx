import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentView, Live, Part, Row, Snapshot, Tab } from '../types'

const PANE = 'context-x'
const tab = atom({ plugin: 'context-x', key: 'tab' } as const, 'overview')
const snap = atom({ plugin: 'context-x', key: 'snap' } as const, null)
const busy = atom({ plugin: 'context-x', key: 'busy' } as const, false)
const open = atom({ plugin: 'context-x', key: 'open' } as const, null)
const live = atom({ plugin: 'context-x', key: 'live' } as const, null)
const agent = atom({ plugin: 'context-x', key: 'agent' } as const, null)

const TABS: Tab[] = ['overview', 'messages', 'agents', 'tools', 'skills', 'memory']
// ponytail: chars/4 estimate for messages; the engine only itemizes categories, not individual messages
const est = (s: string) => Math.ceil(s.length / 4)
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const byTokens = (a: { tokens: number }, b: { tokens: number }) => b.tokens - a.tokens
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const PREVIEW = 400
const base = (p: string) => p.split(/[\\/]/).pop() || p
const fileUrl = (p: string) => encodeURI('file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''))
// The file a tool call names, when its input names one.
const inputPath = (input: any): string | undefined =>
  [input?.file_path, input?.notebook_path, input?.path].find(v => typeof v === 'string')

// The band's figures: the status line's free numbers, no breakdown.
async function track($: any) {
  const { context } = await $.session.usage()
  const l: Live = { percent: context.percent ?? 0, tokens: context.tokens ?? 0, window: context.window }
  await update($, live, () => l)
}

async function openPane($: any, name: Tab) {
  await update($, tab, () => name)
  await update($, open, () => null)
  await $.ui.open({ id: PANE, title: 'Context', focus: true, closeOnEscape: true })
  void refresh($)
}

function messageRows(msgs: any[]): Row[] {
  const toolName: Record<string, string> = {}
  for (const m of msgs) for (const t of m.toolUses) toolName[t.tool_use_id] = t.tool

  // A tool's output lives in the user message carrying its tool_result, so it is counted there only.
  return msgs.map((m: any, i: number) => {
    const parts: Part[] = []
    if (m.text) parts.push({ label: 'text', tokens: est(m.text), preview: clip(m.text, PREVIEW) })
    for (const t of m.toolUses) {
      const input = JSON.stringify(t.input)
      parts.push({ label: `call ${t.tool}`, tokens: est(input), preview: clip(input, PREVIEW), path: inputPath(t.input) })
    }
    for (const r of m.toolResults ?? []) {
      parts.push({
        label: `result ${toolName[r.tool_use_id] ?? r.tool_use_id}`,
        tokens: est(r.text ?? ''),
        preview: clip(r.text ?? '', PREVIEW),
        isError: r.isError || undefined,
      })
    }
    const tools = m.toolUses.map((t: any) => t.tool)
    const results = (m.toolResults ?? []).map((r: any) => toolName[r.tool_use_id] ?? '?')
    const what = results.length
      ? `result: ${results.join(', ')}`
      : tools.length
        ? `calls ${tools.join(', ')}`
        : flat(m.text).slice(0, 60)
    return {
      label: `#${i + 1} ${m.role}`,
      detail: what,
      tokens: parts.reduce((n, p) => n + p.tokens, 0),
      parts: parts.sort(byTokens),
    }
  })
}

async function openAgent($: any, id: string, label: string) {
  const found = await $.session.messages({ agentId: id })
  const view: AgentView = { id, label, rows: Array.isArray(found) ? messageRows(found).sort(byTokens) : [] }
  await update($, agent, () => view)
  await update($, open, () => null)
}

async function refresh($: any, exact = false) {
  await update($, busy, () => true)
  try {
    const usage = await $.session.usage({ breakdown: exact ? 'full' : 'summary' })
    const b = usage.context.breakdown
    const msgs = await $.session.messages()

    const messages = messageRows(msgs)

    // Each subagent's conversation, sized the same way; a finished one with no saved transcript is skipped.
    const agents: Row[] = []
    for (const a of await $.agent.list()) {
      const found = await $.session.messages({ agentId: a.id })
      if (!Array.isArray(found)) continue
      agents.push({
        label: `${a.type}: ${a.description}`,
        detail: a.status,
        tokens: messageRows(found).reduce((n, r) => n + r.tokens, 0),
        id: a.id,
      })
    }

    const s: Snapshot = {
      at: await $.clock.now(),
      exact,
      model: b?.model ?? (await $.session.model()),
      total: b?.totalTokens ?? usage.context.tokens ?? 0,
      max: b?.maxTokens ?? 0,
      percent: b?.percentage ?? usage.context.percent ?? 0,
      rows: {
        overview: (b?.categories ?? []).map((c: any) => ({
          label: c.name,
          detail: c.kind,
          tokens: c.tokens,
          dim: c.kind !== 'used',
        })),
        messages: messages.sort(byTokens),
        agents: agents.sort(byTokens),
        tools: [
          ...(b?.mcpTools ?? []).map((t: any) => ({
            label: t.name,
            detail: `${t.serverName}${t.isLoaded ? '' : ' (deferred)'}`,
            tokens: t.tokens,
            dim: !t.isLoaded,
          })),
          ...(b?.agents ?? []).map((a: any) => ({ label: `agent: ${a.agentType}`, detail: a.source, tokens: a.tokens })),
        ].sort(byTokens),
        skills: (b?.skills?.skillFrontmatter ?? [])
          .map((sk: any) => ({ label: sk.name, detail: sk.pluginName ?? sk.source, tokens: sk.tokens }))
          .sort(byTokens),
        memory: (b?.memoryFiles ?? [])
          .map((f: any) => ({ label: base(f.path), detail: f.type, tokens: f.tokens, path: f.path }))
          .sort(byTokens),
      },
    }
    await update($, snap, () => s)
    await update($, open, () => null)
    const shown = await read($, agent)
    if (shown) await openAgent($, shown.id, shown.label)
  } finally {
    await update($, busy, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'context-x', description: 'Detailed, drill-down context breakdown' })
    void track($)
    return next(e)
  })

  on('command.run', { command: 'context-x' }, async $ => {
    await openPane($, await read($, tab))
    return { text: 'Context breakdown opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) void track($)
    if (e.agentId === undefined && (await read($, snap)) !== null) void refresh($)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const l = await read($, live)

    return (
      <Box>
        <Text dimColor>
          {l ? `Context ${Math.round(l.percent)}% ${k(l.tokens)}/${k(l.window)} ` : 'Context '}
        </Text>
        {TABS.map(name => (
          <Button key={`b-${name}`} label={name} onPress={() => openPane($, name)} />
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    const s = await read($, snap)
    const t = await read($, tab)
    const isBusy = await read($, busy)
    const opened = await read($, open)
    const ag = t === 'agents' ? await read($, agent) : null
    const cols = e.viewport?.columns ?? 80
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 7)
    const shown = t === 'memory' ? Math.max(2, Math.floor(room / 2)) : room
    const barW = Math.max(6, Math.min(20, cols - 50))

    // Inside a subagent the list is its messages; otherwise the tab's own rows.
    const rows = ag ? ag.rows : (s?.rows[t] ?? [])
    const isMessages = t === 'messages' || ag !== null
    const top = Math.max(1, ...rows.map(r => r.tokens))
    const sum = rows.reduce((n, r) => n + r.tokens, 0)
    const bar = (n: number, of: number) => {
      const fill = Math.round((n / Math.max(1, of)) * barW)
      return '█'.repeat(fill) + '░'.repeat(barW - fill)
    }
    const line = (r: { tokens: number; label: string }, of: number, rest: string) =>
      clip(`${k(r.tokens).padStart(6)} ${bar(r.tokens, of)} ${r.label} ${rest}`, cols - 2)

    // The full path, wrapped, as a link the surface opens itself.
    const pathLink = (key: string, path: string) => (
      <Markdown key={key} dimColor text={`       [${path.replace(/[[\]]/g, '\\$&')}](${fileUrl(path)})`} />
    )

    const credit = (
      <Text dimColor>
        Created at <Link href="https://donsbookshelf.com/" label="Don's Bookshelf" />
      </Text>
    )

    const header = (
      <Box>
        <Text dimColor>
          {s
            ? `${s.model}  ${k(s.total)}/${k(s.max)} (${Math.round(s.percent)}%)  ${s.exact ? 'exact' : 'estimated'}  `
            : 'Loading...  '}
          {isBusy ? 'refreshing... ' : ''}
        </Text>
        <Button key="r" label="Refresh" onPress={() => refresh($)} />
        <Button key="x" label="Exact count" onPress={() => refresh($, true)} />
      </Box>
    )

    const msg = isMessages && opened !== null ? rows[opened] : undefined
    if (msg) {
      const parts = msg.parts ?? []
      // Split the pane's height between the parts: a label line plus a wrapped preview each.
      const previewLines = Math.max(1, Math.floor((room - 2) / Math.max(1, parts.length)) - 1)
      return (
        <Box flexDirection="column">
          {credit}
          <Box>
            <Button key="back" label="← Back" autoFocus onPress={() => update($, open, () => null)} />
            <Text>
              {' '}
              {msg.label}, ~{k(msg.tokens)} tokens, {parts.length} part{parts.length === 1 ? '' : 's'}
            </Text>
          </Box>
          {header}
          {parts.map((p, i) => (
            <Box key={`p${i}`} flexDirection="column">
              <Text>{line(p, msg.tokens, p.isError ? '(error)' : '')}</Text>
              {p.path && pathLink(`pl${i}`, p.path)}
              <Text dimColor>{clip(flat(p.preview), Math.max(20, (cols - 4) * previewLines))}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {credit}
        <Box>
          {TABS.map(name => (
            <Button
              key={name}
              label={name}
              variant={name === t ? 'primary' : undefined}
              onPress={() => update($, tab, () => name)}
            />
          ))}
        </Box>
        {header}
        {ag && (
          <Box>
            <Button key="agback" label="← Agents" autoFocus onPress={() => update($, agent, () => null)} />
            <Text> {clip(ag.label, cols - 14)}</Text>
          </Box>
        )}
        <Text dimColor>
          {rows.length} items, {k(sum)} tokens{rows.length > shown ? `, top ${shown} shown` : ''}
          {isMessages ? '  (select a message to drill in)' : t === 'agents' ? '  (select an agent to see its messages)' : ''}
        </Text>
        {rows.slice(0, shown).map((r, i) =>
          isMessages ? (
            <Button key={`m${i}`} plain label={line(r, top, r.detail)} onPress={() => update($, open, () => i)} />
          ) : t === 'agents' && r.id ? (
            <Button key={`a${i}`} plain label={line(r, top, r.detail)} onPress={() => openAgent($, r.id!, r.label)} />
          ) : r.path ? (
            <Box key={`${t}-${i}`} flexDirection="column">
              <Text dimColor={r.dim}>{line(r, top, r.detail)}</Text>
              {pathLink(`${t}-l${i}`, r.path)}
            </Box>
          ) : (
            <Text key={`${t}-${i}`} dimColor={r.dim}>
              {line(r, top, r.detail)}
            </Text>
          ),
        )}
      </Box>
    )
  })
}
