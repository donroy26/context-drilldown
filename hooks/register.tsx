import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentView, Live, Part, Row, Snapshot, Tab } from '../types'

const PANE = 'context-drilldown'
const tab = atom({ plugin: 'context-drilldown', key: 'tab' } as const, 'overview')
const snap = atom({ plugin: 'context-drilldown', key: 'snap' } as const, null)
const busy = atom({ plugin: 'context-drilldown', key: 'busy' } as const, false)
const open = atom({ plugin: 'context-drilldown', key: 'open' } as const, null)
const live = atom({ plugin: 'context-drilldown', key: 'live' } as const, null)
const agent = atom({ plugin: 'context-drilldown', key: 'agent' } as const, null)
const inOrder = atom({ plugin: 'context-drilldown', key: 'inOrder' } as const, false)

const TABS: Tab[] = ['overview', 'messages', 'agents', 'tools', 'skills', 'memory']
// ponytail: chars/4 per message block, scaled in refresh to the engine's Messages total; the engine itemizes categories, not messages
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

// What a tool call acted on, in a few words: the task, command, file, pattern or query it names.
function summarize(input: any): string {
  if (!input || typeof input !== 'object') return ''
  const path = inputPath(input)
  const pick = [input.description, input.command, path && base(path), input.pattern, input.query, input.url, input.skill, input.prompt].find(
    v => typeof v === 'string' && v.trim(),
  )
  return pick ? clip(flat(pick), 70) : ''
}

// A reminder's first meaningful line, its tags and markdown stripped: what kind of reminder it is.
function reminderTitle(text: string): string {
  const line = text
    .replace(/<\/?[\w-]+>/g, '\n')
    .split('\n')
    .map(l => l.replace(/^[#>*\s-]+/, '').trim())
    .find(l => l.length > 0)
  return line ? clip(line, 60) : '(empty)'
}

// ponytail: a flat 1600 tokens per image or document; scaling to the engine's total absorbs the error
const MEDIA = 1600
const resultText = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x?.type === 'text' ? x.text : '')).join('\n') : ''
const resultMedia = (c: any): number =>
  Array.isArray(c) ? c.filter(x => x?.type === 'image' || x?.type === 'document').length : 0

// One row per message, from the Messages API form: every block the model is sent, thinking and reminders included.
function messageRows(msgs: any[], scale = 1): Row[] {
  const calls: Record<string, string> = {}
  for (const m of msgs)
    for (const b of Array.isArray(m.content) ? m.content : [])
      if (b.type === 'tool_use') {
        const what = summarize(b.input)
        calls[b.id] = what ? `${b.name}: ${what}` : b.name
      }
  const n = (t: number) => Math.round(t * scale)

  return msgs.map((m: any, i: number) => {
    const parts: Part[] = []
    const gist: string[] = []
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
    for (const b of blocks) {
      if (b.type === 'text') {
        const isReminder = /^\s*<(system-reminder|local-command|command-)/.test(b.text)
        parts.push({
          label: isReminder ? `reminder: ${reminderTitle(b.text)}` : 'text',
          tokens: n(est(b.text)),
          preview: clip(b.text, PREVIEW),
        })
        if (!isReminder) gist.push(`"${flat(b.text)}"`)
      } else if (b.type === 'thinking') {
        parts.push({ label: 'thinking', tokens: n(est(b.thinking ?? '')), preview: clip(b.thinking ?? '', PREVIEW) })
      } else if (b.type === 'tool_use') {
        const input = JSON.stringify(b.input)
        parts.push({ label: `call ${calls[b.id]}`, tokens: n(est(input)), preview: clip(input, PREVIEW), path: inputPath(b.input) })
        gist.push(`call ${calls[b.id]}`)
      } else if (b.type === 'tool_result') {
        const text = resultText(b.content)
        const media = resultMedia(b.content)
        const of = calls[b.tool_use_id] ?? 'unknown call'
        parts.push({
          label: `result of ${of}${media ? ` (+${media} image)` : ''}`,
          tokens: n(est(text) + media * MEDIA),
          preview: clip(text, PREVIEW),
          isError: b.is_error || undefined,
        })
        gist.push(`result of ${of}`)
      } else if (b.type === 'image' || b.type === 'document') {
        parts.push({ label: b.type, tokens: n(MEDIA), preview: '' })
        gist.push(`[${b.type}]`)
      } else {
        const raw = JSON.stringify(b)
        parts.push({ label: b.type, tokens: n(est(raw)), preview: clip(raw, PREVIEW) })
      }
    }
    return {
      label: `#${i + 1} ${m.role}`,
      seq: i,
      detail: clip(gist.join(' · ') || (parts[0]?.label ?? ''), 160),
      tokens: parts.reduce((t, p) => t + p.tokens, 0),
      parts: parts.sort(byTokens),
    }
  })
}

async function openAgent($: any, id: string, label: string) {
  const found = await $.session.messages({ agentId: id, as: 'api' })
  const scale = (await read($, snap))?.scale ?? 1
  const view: AgentView = { id, label, rows: Array.isArray(found) ? messageRows(found, scale).sort(byTokens) : [] }
  await update($, agent, () => view)
  await update($, open, () => null)
}

async function refresh($: any, exact = false) {
  await update($, busy, () => true)
  try {
    const usage = await $.session.usage({ breakdown: exact ? 'full' : 'summary' })
    const b = usage.context.breakdown
    const msgs = await $.session.messages({ as: 'api' })

    // Scale the per-message estimates so they add up to the engine's own Messages figure.
    // The breakdown names its categories only by label; Messages is the row holding the conversation.
    const raw = messageRows(msgs).reduce((t, r) => t + r.tokens, 0)
    const engine = (b?.categories ?? []).find((c: any) => c.kind === 'used' && /^messages$/i.test(c.name))?.tokens
    const scale = engine && raw ? engine / raw : 1
    const messages = messageRows(msgs, scale)

    // Each subagent's conversation, sized the same way. One whose transcript is gone keeps its last-seen size.
    const before = new Map(((await read($, snap))?.rows.agents ?? []).map(r => [r.id, r]))
    const agents: Row[] = []
    for (const a of await $.agent.list()) {
      const found = await $.session.messages({ agentId: a.id, as: 'api' })
      const label = `${a.type}: ${a.description}`
      if (Array.isArray(found)) {
        agents.push({ label, detail: a.status, tokens: messageRows(found, scale).reduce((t, r) => t + r.tokens, 0), id: a.id })
      } else {
        agents.push({ label, detail: `${a.status}, transcript gone`, tokens: before.get(a.id)?.tokens ?? 0, id: a.id, dim: true })
      }
    }

    const s: Snapshot = {
      at: await $.clock.now(),
      exact,
      scale,
      model: b?.model ?? (await $.session.model()),
      total: b?.totalTokens ?? usage.context.tokens ?? 0,
      max: b?.maxTokens ?? 0,
      percent: b?.percentage ?? usage.context.percent ?? 0,
      rows: {
        overview: (b?.categories ?? [])
          .map((c: any) => ({
            label: c.name,
            detail: c.kind === 'deferred' ? '(loaded on demand, not in window)' : '',
            tokens: c.tokens,
            dim: c.kind !== 'used',
          }))
          .sort(byTokens),
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
    await $.command.register({ name: 'context-drilldown', description: 'Detailed, drill-down context breakdown' })
    void track($)
    return next(e)
  })

  on('command.run', { command: 'context-drilldown' }, async $ => {
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
    const below = await next(e)

    return (
      <Box flexDirection="column">
      <Box>
        <Text dimColor>
          {l ? `Context ${Math.round(l.percent)}% ${k(l.tokens)}/${k(l.window)} ` : 'Context '}
        </Text>
        {TABS.map(name => (
          <Button key={`b-${name}`} label={name} onPress={() => openPane($, name)} />
        ))}
      </Box>
      {below}
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
    // The pane scrolls itself (wheel, scroll keys), so every row is drawn.
    // ponytail: capped at 400 rows to keep the drawn tree bounded; page it if sessions outgrow that
    const shown = 400
    const barW = Math.max(6, Math.min(20, cols - 50))

    // Inside a subagent the list is its messages; otherwise the tab's own rows.
    const all = ag ? ag.rows : (s?.rows[t] ?? [])
    const isMessages = t === 'messages' || ag !== null
    const isInOrder = isMessages && (await read($, inOrder))
    // In order: the newest messages that fit, oldest first. By size: the tab's own order, largest first.
    const rows = isInOrder ? [...all].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).slice(-shown) : all
    const top = Math.max(1, ...all.map(r => r.tokens))
    // Dim rows (free space, the compaction buffer, deferred tools) are not in the window, so they are not summed.
    const sum = all.filter(r => !r.dim).reduce((n, r) => n + r.tokens, 0)
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
        context-drilldown plugin created at <Link href="https://donsbookshelf.com/" label="Don's Bookshelf" />
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
        {isMessages && (
          <Button
            key="order"
            label={isInOrder ? 'By size' : 'In order'}
            onPress={async () => {
              await update($, open, () => null)
              await update($, inOrder, v => !v)
            }}
          />
        )}
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
          {all.length} items, {k(sum)} tokens{t === 'agents' && !ag ? ' across subagents (their own windows, not yours)' : ' in context'}
          {all.length > shown ? (isInOrder ? `, latest ${shown} shown` : `, top ${shown} shown`) : ''}
          {all.length > room ? '  (scroll for more)' : ''}
          {isMessages ? '  (select a message to drill in)' : t === 'agents' ? '  (select an agent to see its messages)' : ''}
        </Text>
        {rows.slice(0, shown).map((r, i) =>
          isMessages ? (
            <Button key={`m${i}`} plain label={line(r, top, r.detail)} onPress={() => update($, open, () => i)} />
          ) : t === 'agents' && r.id && !r.dim ? (
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
