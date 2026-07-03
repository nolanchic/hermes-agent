import {
  SiFigma,
  SiGithub,
  SiGitlab,
  SiLinear,
  SiNotion,
  SiPostgresql,
  SiSentry,
  SiStripe,
  SiSupabase,
  SiVercel
} from '@icons-pack/react-simple-icons'
import { useStore } from '@nanostores/react'
import { type ComponentType, type SVGProps, useEffect, useMemo, useRef, useState } from 'react'

import { CodeCardBody } from '@/components/chat/code-card'
import { type CodeEditorApi } from '@/components/chat/code-editor'
import { JsonDocumentEditor } from '@/components/chat/json-document-editor'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { ErrorBanner } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { TextTab } from '@/components/ui/text-tab'
import {
  authMcpServer,
  getHermesConfigRecord,
  getLogs,
  getMcpCatalog,
  type HermesGateway,
  type McpCatalogEntry,
  type McpTestResult,
  saveHermesConfig,
  testMcpServer
} from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import { $activeSessionId } from '@/store/session'
import type { HermesConfigRecord } from '@/types/hermes'

import { DetailPane, MASTER_DETAIL_WIDE_COLS } from '../master-detail'
import { PanelAddButton, PanelEmpty } from '../overlays/panel'
import { prettyName } from '../settings/helpers'
import { useDeepLinkHighlight } from '../settings/use-deep-link-highlight'

type McpServers = Record<string, Record<string, unknown>>

// The editor always speaks the ecosystem's mcp.json document format — names
// are the JSON keys, transport is inferred from `command` vs `url` — so any
// README's "add this to your mcp.json" snippet pastes verbatim. Storage stays
// the config.yaml `mcp_servers` map (CLI/TUI untouched).
const STARTER_ENTRY = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'] }

const pretty = (value: unknown) => JSON.stringify(value, null, 2)
const wrapDoc = (entries: McpServers) => pretty({ mcpServers: entries })

const isServerShape = (value: Record<string, unknown>) =>
  typeof value.command === 'string' || typeof value.url === 'string'

// Cursor/Claude write `type`; Hermes reads `transport`. Normalize on the way
// in so pasted configs behave identically under the CLI/TUI loader.
function normalizeEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (typeof entry.type === 'string' && entry.transport === undefined) {
    const { type, ...rest } = entry

    return { ...rest, transport: type }
  }

  return entry
}

/** Accepts `{"mcpServers": {...}}` (ecosystem), a bare name→config map, or throws. */
function parseServersDoc(raw: string): McpServers {
  const parsed = JSON.parse(raw) as unknown

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object')
  }

  const doc = parsed as Record<string, unknown>

  if (isServerShape(doc)) {
    throw new Error('Wrap the server in {"mcpServers": {"name": …}} so it has a name')
  }

  const wrapper = doc.mcpServers ?? doc.mcp_servers

  const map =
    wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper) ? (wrapper as McpServers) : (doc as McpServers)

  return Object.fromEntries(Object.entries(map).map(([name, entry]) => [name, normalizeEntry(entry)]))
}

function getServers(config: HermesConfigRecord | null): McpServers {
  const raw = config?.mcp_servers

  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as McpServers) : {}
}

// The runtime gate is `enabled: false` — the same flag `hermes mcp` and the
// agent's MCP loader read.
const serverEnabled = (server: Record<string, unknown>) => server.enabled !== false

const NEEDS_AUTH_RE = /\b(401|unauthorized|forbidden|invalid[_ ]?token|authentication|oauth)\b/i

// Probe results outlive the component: each probe is a REAL connect/disconnect
// (stdio servers get spawned!), so re-entering the page must not re-probe the
// fleet. Manual refresh / auth / toggle-on bypass the cache.
const PROBE_TTL_MS = 5 * 60_000
const probeCache = new Map<string, { at: number; result: McpTestResult }>()

type Probe = McpTestResult | 'probing'

type ServerStatus = 'off' | 'probing' | 'ok' | 'needs-auth' | 'error' | 'unknown'

function statusOf(server: Record<string, unknown>, probe: Probe | undefined): ServerStatus {
  if (!serverEnabled(server)) {
    return 'off'
  }

  if (probe === 'probing') {
    return 'probing'
  }

  if (!probe) {
    return 'unknown'
  }

  if (probe.ok) {
    return 'ok'
  }

  return NEEDS_AUTH_RE.test(probe.error ?? '') ? 'needs-auth' : 'error'
}

const STATUS_DOT: Record<ServerStatus, string> = {
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  'needs-auth': 'bg-amber-500',
  probing: 'animate-pulse bg-foreground/40',
  off: 'bg-foreground/20',
  unknown: 'bg-foreground/20'
}

// "12 tools enabled" / "25 tools, 1 prompts, 103 resources enabled" — only
// the capabilities the server actually has.
// TODO(i18n): literals until the UX settles.
function capabilitySummary(probe: McpTestResult): string {
  const parts = [
    `${probe.tools.length} tools`,
    ...(probe.prompts ? [`${probe.prompts} prompts`] : []),
    ...(probe.resources ? [`${probe.resources} resources`] : [])
  ]

  return `${parts.join(', ')} enabled`
}

// TODO(i18n): literals until the UX settles.
function statusLine(status: ServerStatus, probe: Probe | undefined): string {
  switch (status) {
    case 'ok':
      return capabilitySummary(probe as McpTestResult)

    case 'probing':
      return 'Connecting…'

    case 'needs-auth':
      return 'Needs authentication'

    case 'error':
      return 'Error'

    case 'off':
      return 'Off'

    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// Cursor → server-block mapping. A tolerant character walker (not JSON.parse —
// it must work mid-edit) that finds each server's key+object range inside the
// mcpServers container, so the editor cursor selects a server and the block
// can be highlighted.
// ---------------------------------------------------------------------------

interface ServerBlock {
  from: number
  name: string
  to: number
}

function scanServerBlocks(text: string): ServerBlock[] {
  const skipString = (index: number): number => {
    let i = index + 1

    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
      } else if (text[i] === '"') {
        return i + 1
      } else {
        i++
      }
    }

    return i
  }

  // Container: the object after "mcpServers"/"mcp_servers", else the doc root.
  let start = -1
  const wrapper = /"mcpServers"|"mcp_servers"/.exec(text)

  if (wrapper) {
    let i = wrapper.index + wrapper[0].length

    while (i < text.length && text[i] !== '{') {
      i++
    }

    start = i
  } else {
    start = text.indexOf('{')
  }

  if (start < 0 || text[start] !== '{') {
    return []
  }

  const blocks: ServerBlock[] = []
  let i = start + 1

  while (i < text.length) {
    const ch = text[i]

    if (ch === '}') {
      break
    }

    if (ch !== '"') {
      i++

      continue
    }

    const keyStart = i
    const keyEnd = skipString(i)
    const name = text.slice(keyStart + 1, keyEnd - 1)
    i = keyEnd

    while (i < text.length && text[i] !== ':') {
      i++
    }

    i++

    while (i < text.length && /\s/.test(text[i])) {
      i++
    }

    if (text[i] === '{') {
      let depth = 0
      let j = i

      while (j < text.length) {
        const c = text[j]

        if (c === '"') {
          j = skipString(j)

          continue
        }

        if (c === '{') {
          depth++
        } else if (c === '}') {
          depth--

          if (depth === 0) {
            j++

            break
          }
        }

        j++
      }

      blocks.push({ from: keyStart, name, to: j })
      i = j
    } else {
      // Non-object value — skip to the next sibling.
      while (i < text.length && text[i] !== ',' && text[i] !== '}') {
        if (text[i] === '"') {
          i = skipString(i)

          continue
        }

        i++
      }
    }
  }

  return blocks
}

export function McpTab({ gateway }: { gateway: HermesGateway | null }) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const activeSessionId = useStore($activeSessionId)
  const [config, setConfig] = useState<HermesConfigRecord | null>(null)
  const [saving, setSaving] = useState(false)
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const probesRef = useRef(probes)
  probesRef.current = probes

  // Master document draft. `docVersion` remounts the editor when the draft is
  // regenerated programmatically (list-side mutations); `dirty` guards user
  // edits from being clobbered by those regenerations.
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [docVersion, setDocVersion] = useState(0)
  const [logSource, setLogSource] = useState<'stdio' | 'agent'>('stdio')

  // Selection IS the editor cursor: whichever server block contains it is the
  // configured server on the left. Cursor outside every block → the list.
  const editorApi = useRef<CodeEditorApi | null>(null)
  const [cursor, setCursor] = useState(0)
  const blocks = useMemo(() => scanServerBlocks(draft), [draft])

  const activeBlock = useMemo(
    () => blocks.find(block => cursor >= block.from && cursor <= block.to) ?? null,
    [blocks, cursor]
  )

  const selected = activeBlock?.name ?? null

  const focusServer = (name: string) => {
    const block = blocks.find(b => b.name === name)

    if (block) {
      // Land just inside the key so the block claims the cursor.
      editorApi.current?.setCursor(block.from + 1)
      setCursor(block.from + 1)
    }
  }

  const servers = useMemo(() => getServers(config), [config])

  // Config/document order, not alphabetical — the list mirrors mcp.json.
  const names = useMemo(() => Object.keys(servers), [servers])

  // Catalog enrichment: descriptions for known servers (matched by name, then
  // by url/command). Best-effort — absent for hand-rolled servers.
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([])

  useEffect(() => {
    getMcpCatalog()
      .then(response => setCatalog(response.entries ?? []))
      .catch(() => undefined)
  }, [])

  const descriptionFor = (serverName: string, server: Record<string, unknown>): null | string => {
    const lower = serverName.toLowerCase()

    const match = catalog.find(
      entry =>
        entry.name.toLowerCase() === lower ||
        (entry.url && entry.url === server.url) ||
        (entry.command && entry.command === server.command)
    )

    return match?.description ?? null
  }

  const resetDraft = (entries: McpServers) => {
    setDraft(wrapDoc(entries))
    setDirty(false)
    setDocVersion(version => version + 1)
  }

  // Mirror a list-side mutation into a dirty draft without losing the user's
  // other edits. Unparseable drafts are left alone — save resolves the race.
  const patchDraft = (mutate: (doc: McpServers) => McpServers) => {
    try {
      setDraft(wrapDoc(mutate(parseServersDoc(draft))))
      setDocVersion(version => version + 1)
    } catch {
      // Draft is mid-edit / invalid JSON; the user's text wins until save.
    }
  }

  useEffect(() => {
    let cancelled = false

    getHermesConfigRecord()
      .then(next => {
        if (cancelled) {
          return
        }

        setConfig(next)
        resetDraft(getServers(next))
      })
      .catch(err => notifyError(err, m.failedLoad))

    return () => void (cancelled = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount; copy is stable
  }, [])

  useDeepLinkHighlight({
    block: 'nearest',
    elementId: serverName => `mcp-server-${serverName}`,
    onResolve: focusServer,
    param: 'server',
    ready: serverName => blocks.some(block => block.name === serverName)
  })

  const runProbe = async (serverName: string) => {
    setProbes(current => ({ ...current, [serverName]: 'probing' }))

    try {
      const result = await testMcpServer(serverName)
      probeCache.set(serverName, { at: Date.now(), result })
      setProbes(current => ({ ...current, [serverName]: result }))
    } catch (err) {
      const result = { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }
      probeCache.set(serverName, { at: Date.now(), result })
      setProbes(current => ({ ...current, [serverName]: result }))
    }
  }

  // First-class OAuth: opens the system browser, blocks until the flow lands a
  // token (verified on disk — a friendly tools/list is not proof), then the
  // auth result doubles as the probe (it carries the tool list).
  const [authing, setAuthing] = useState<null | string>(null)

  const authenticate = async (serverName: string) => {
    setAuthing(serverName)
    setProbes(current => ({ ...current, [serverName]: 'probing' }))

    try {
      const result = await authMcpServer(serverName)
      setProbes(current => ({ ...current, [serverName]: result }))
      probeCache.set(serverName, { at: Date.now(), result })

      if (result.ok) {
        // The endpoint persisted `auth: oauth` — mirror it locally.
        const nextServers = { ...servers, [serverName]: { ...servers[serverName], auth: 'oauth' } }
        setConfig(current => (current ? { ...current, mcp_servers: nextServers } : current))

        if (!dirty) {
          resetDraft(nextServers)
        }

        // TODO(i18n): literal until the UX settles.
        notify({ kind: 'success', title: 'Authenticated', message: `${serverName}: ${result.tools.length} tools` })
        void silentReload()
      } else if (result.error) {
        notifyError(new Error(result.error), serverName)
      }
    } catch (err) {
      setProbes(current => ({
        ...current,
        [serverName]: { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }
      }))
      notifyError(err, serverName)
    } finally {
      setAuthing(null)
    }
  }

  // It should just know: probe enabled servers as config arrives — but through
  // the cache, so revisiting the page doesn't respawn/reconnect the fleet.
  useEffect(() => {
    for (const [serverName, server] of Object.entries(servers)) {
      if (!serverEnabled(server) || probesRef.current[serverName] !== undefined) {
        continue
      }

      const cached = probeCache.get(serverName)

      if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
        setProbes(current => ({ ...current, [serverName]: cached.result }))
      } else {
        void runProbe(serverName)
      }
    }
  }, [servers])

  // Config writes reach live sessions immediately — no manual "Reload MCP".
  const silentReload = async () => {
    if (!gateway) {
      return
    }

    try {
      await gateway.request('reload.mcp', { confirm: true, session_id: activeSessionId ?? undefined })
    } catch (err) {
      notifyError(err, m.reloadFailed)
    }
  }

  const persist = async (nextServers: McpServers) => {
    const nextConfig = { ...config, mcp_servers: nextServers }
    await saveHermesConfig(nextConfig)
    setConfig(nextConfig)
    void silentReload()
  }

  const withEnabled = (server: Record<string, unknown>, enabled: boolean) => {
    const next = { ...server }

    if (enabled) {
      delete next.enabled
    } else {
      next.enabled = false
    }

    return next
  }

  const toggleServer = async (serverName: string, enabled: boolean) => {
    try {
      await persist({ ...servers, [serverName]: withEnabled(servers[serverName], enabled) })

      if (dirty) {
        patchDraft(doc => (doc[serverName] ? { ...doc, [serverName]: withEnabled(doc[serverName], enabled) } : doc))
      } else {
        resetDraft({ ...servers, [serverName]: withEnabled(servers[serverName], enabled) })
      }

      if (enabled) {
        void runProbe(serverName)
      }
    } catch (err) {
      notifyError(err, m.saveFailed)
    }
  }

  const removeServer = async (serverName: string) => {
    setSaving(true)

    try {
      const next = { ...servers }
      delete next[serverName]

      await persist(next)

      if (dirty) {
        patchDraft(doc => {
          const patched = { ...doc }
          delete patched[serverName]

          return patched
        })
      } else {
        resetDraft(next)
      }

      setCursor(0)
    } catch (err) {
      notifyError(err, m.removeFailed)
    } finally {
      setSaving(false)
    }
  }

  // "+" seeds a starter entry into the document (unique key) and marks it
  // dirty — naming happens in the editor, like every other mcp.json.
  const addServer = () => {
    let base: McpServers

    try {
      base = parseServersDoc(draft)
    } catch {
      base = { ...servers }
    }

    let key = 'my-server'

    for (let i = 2; key in base; i++) {
      key = `my-server-${i}`
    }

    const nextDraft = wrapDoc({ ...base, [key]: STARTER_ENTRY })
    setDraft(nextDraft)
    setDirty(true)
    setDocVersion(version => version + 1)

    // Focus the fresh block once the editor remounts with the new doc.
    const from = nextDraft.indexOf(`"${key}"`)

    if (from >= 0) {
      requestAnimationFrame(() => {
        editorApi.current?.setCursor(from + 1)
        setCursor(from + 1)
      })
    }
  }

  const saveDoc = async () => {
    let entries: McpServers

    try {
      entries = parseServersDoc(draft)
    } catch (err) {
      notifyError(err, m.invalidJson)

      return
    }

    setSaving(true)

    try {
      await persist(entries)
      resetDraft(entries)
      // Entries that changed shape get fresh probes.
      setProbes(current => Object.fromEntries(Object.entries(current).filter(([name]) => name in entries)))
      notify({ kind: 'success', title: m.savedTitle, message: m.savedMessage('mcp.json') })
    } catch (err) {
      notifyError(err, m.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  if (!config) {
    return null
  }

  // Zero servers and a pristine doc: one centered invitation.
  if (Object.keys(servers).length === 0 && !dirty) {
    return (
      <div className="flex h-full min-h-0 flex-1">
        <PanelEmpty
          action={
            <Button onClick={addServer} size="sm">
              {m.newServer}
            </Button>
          }
          description={m.emptyDesc}
          icon="plug"
          title={m.emptyTitle}
        />
      </div>
    )
  }

  // Selection may reference an unsaved block (freshly pasted) — fall back to
  // the draft's parsed entry so the config pane can still describe it.
  const savedEntry = selected ? servers[selected] : undefined

  const draftEntry = (() => {
    if (!selected || savedEntry) {
      return undefined
    }

    try {
      return parseServersDoc(draft)[selected]
    } catch {
      return undefined
    }
  })()

  const activeEntry = savedEntry ?? draftEntry

  return (
    <div className={cn('grid h-full min-h-0 grid-cols-1', MASTER_DETAIL_WIDE_COLS)}>
      {/* LEFT: config — the focused block's server, or the fleet list. */}
      <aside className="flex min-h-0 flex-col overflow-hidden border-r border-(--ui-stroke-quaternary)">
        {selected && activeEntry ? (
          <ServerConfig
            authing={authing === selected}
            description={descriptionFor(selected, activeEntry)}
            entry={activeEntry}
            name={selected}
            onAuthenticate={() => void authenticate(selected)}
            onBack={() => setCursor(0)}
            onProbe={() => void runProbe(selected)}
            onRemove={() => void removeServer(selected)}
            onToggle={checked => void toggleServer(selected, checked)}
            probe={probes[selected]}
            saved={savedEntry !== undefined}
            saving={saving}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-2">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
              {names.map(serverName => {
                const server = servers[serverName]
                const status = statusOf(server, probes[serverName])

                return (
                  <McpRow
                    active={false}
                    busy={saving}
                    enabled={serverEnabled(server)}
                    key={serverName}
                    name={serverName}
                    onProbe={() => void runProbe(serverName)}
                    onRemove={() => void removeServer(serverName)}
                    onSelect={() => focusServer(serverName)}
                    onToggle={checked => void toggleServer(serverName, checked)}
                    status={status}
                    statusText={statusLine(status, probes[serverName])}
                    url={server.url}
                  />
                )
              })}
              <PanelAddButton label={m.newServer} onClick={addServer} />
            </div>
          </div>
        )}
      </aside>

      {/* RIGHT: the mcp.json editor, logs hard-pinned below. */}
      <main className="flex min-h-0 flex-col overflow-hidden">
        <JsonDocumentEditor
          apiRef={editorApi}
          disabled={saving}
          filePath="mcp.json"
          header={
            <>
              mcp.json
              {dirty && <span aria-hidden className="size-1.5 rounded-full bg-current/60" />}
            </>
          }
          highlight={activeBlock ? { from: activeBlock.from, to: activeBlock.to } : null}
          initialValue={draft}
          onChange={next => {
            setDraft(next)
            setDirty(true)
          }}
          onCursorChange={setCursor}
          onFormatJsonError={error => notifyError(new Error(error), m.invalidJson)}
          onSave={() => void saveDoc()}
          remountKey={docVersion}
          trailing={
            <Button disabled={saving || !dirty} onClick={() => void saveDoc()} size="xs">
              {/* TODO(i18n): literal until the UX settles. */}
              {saving ? t.common.saving : 'Save'}
            </Button>
          }
        />
        <DetailPane
          actions={
            <span className="flex items-center gap-1.5">
              {(['stdio', 'agent'] as const).map(kind => (
                <TextTab
                  active={logSource === kind}
                  className="h-5 px-0.5 text-[0.65rem]"
                  key={kind}
                  onClick={() => setLogSource(kind)}
                >
                  {kind}
                </TextTab>
              ))}
            </span>
          }
          defaultHeight={176}
          id="mcp-logs"
          title={
            // TODO(i18n): literal until the UX settles.
            <span className="text-[0.68rem] font-normal text-muted-foreground/60">
              {selected && savedEntry ? selected : 'All servers'}
            </span>
          }
        >
          <McpLogs server={selected && savedEntry ? selected : null} source={logSource} />
        </DetailPane>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Left column: one server's config (mirrors the block under the cursor).
// ---------------------------------------------------------------------------

function ServerConfig({
  authing,
  description,
  entry,
  name,
  onAuthenticate,
  onBack,
  onProbe,
  onRemove,
  onToggle,
  probe,
  saved,
  saving
}: {
  authing: boolean
  description: null | string
  entry: Record<string, unknown>
  name: string
  onAuthenticate: () => void
  onBack: () => void
  onProbe: () => void
  onRemove: () => void
  onToggle: (checked: boolean) => void
  probe: Probe | undefined
  saved: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const status = statusOf(entry, probe)

  const canAuth =
    typeof entry.url === 'string' && (status === 'needs-auth' || (entry.auth === 'oauth' && status === 'error'))

  const summary = probe && probe !== 'probing' && probe.ok ? capabilitySummary(probe) : null

  return (
    // p-2 matches the list view's container so flipping list ⇄ config keeps
    // content anchored at the same origin.
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 [scrollbar-gutter:stable]">
      {/* Geometry cloned from McpRow so nothing jumps when flipping list ⇄
          config: items-start with per-element top margins that reproduce the
          row's h-11 centering exactly (h-5 controls → mt-3, size-6 avatar →
          mt-2.5, h-4 switch → mt-3.5) no matter how tall the text column gets. */}
      <div className="flex items-start gap-2 pr-1.5">
        <Button
          // TODO(i18n): literal until the UX settles.
          aria-label="All servers"
          className={cn('mt-3', ACTION_ICON_BUTTON)}
          onClick={onBack}
          size="icon"
          title="All servers"
          variant="ghost"
        >
          <Codicon name="chevron-left" size="0.8125rem" />
        </Button>
        <McpAvatar className="mt-2.5" name={name} status={status} url={entry.url} />
        <div className="min-w-0 flex-1 pt-1">
          <h3 className="min-w-0 truncate text-[0.9375rem] font-semibold tracking-tight">{prettyName(name)}</h3>
          <p className="mt-0.5 truncate text-[0.68rem] text-(--ui-text-tertiary)">
            {typeof entry.url === 'string' ? entry.url : [entry.command, ...((entry.args as string[]) ?? [])].join(' ')}
          </p>
          {summary && <p className="mt-0.5 text-[0.68rem] text-(--ui-text-tertiary)">{summary}</p>}
        </div>
        {saved && (
          // Direct row children (no wrapper): the icons↔switch gap must be the
          // row's own gap-2, byte-identical to McpRow.
          <>
            <ServerIconActions
              className="mt-3"
              onProbe={onProbe}
              onRemove={onRemove}
              probing={probe === 'probing'}
              saving={saving}
            />
            <Switch
              aria-label={name}
              checked={serverEnabled(entry)}
              className={cn(
                'mt-3.5 shrink-0 cursor-pointer',
                !serverEnabled(entry) && 'opacity-60',
                serverEnabled(entry) && status !== 'ok' && 'opacity-70 saturate-0'
              )}
              disabled={saving}
              onCheckedChange={onToggle}
              size="xs"
            />
          </>
        )}
      </div>

      {description && (
        <p className="mt-2 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {description}
        </p>
      )}

      {canAuth && saved && (
        <div className="mt-3 flex justify-end">
          <Button disabled={authing} onClick={onAuthenticate} size="xs">
            {/* TODO(i18n): literals until the UX settles. */}
            {authing ? 'Waiting for browser…' : 'Authenticate'}
          </Button>
        </div>
      )}
      {!saved && (
        // TODO(i18n): literal until the UX settles.
        <p className="mt-3 text-[0.68rem] text-muted-foreground/60">Unsaved — save mcp.json to connect.</p>
      )}

      {status === 'probing' && <PageLoader className="min-h-24" label={t.skills.loading} />}

      {probe && probe !== 'probing' && !probe.ok && status !== 'off' && (
        <ErrorBanner className="mt-3">{probe.error}</ErrorBanner>
      )}

      {probe && probe !== 'probing' && probe.ok && probe.tools.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {probe.tools.map(tool => (
            <span
              className="rounded-md bg-(--ui-bg-quinary) px-1.5 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)"
              key={tool.name}
              title={tool.description}
            >
              {tool.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const ACTION_ICON_BUTTON =
  'size-5 cursor-pointer rounded-[4px] text-muted-foreground/70 hover:bg-(--ui-control-active-background) hover:text-foreground'

// Refresh + delete, identical beside every toggle (rows and config header).
function ServerIconActions({
  className,
  onProbe,
  onRemove,
  probing,
  saving
}: {
  className?: string
  onProbe: () => void
  onRemove: () => void
  probing: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp

  return (
    <span className={cn('flex items-center gap-0.5', className)}>
      <Button
        aria-label={m.reload}
        className={ACTION_ICON_BUTTON}
        disabled={probing}
        onClick={onProbe}
        size="icon"
        title={m.reload}
        variant="ghost"
      >
        <Codicon name="refresh" size="0.8125rem" spinning={probing} />
      </Button>
      <Button
        aria-label={m.remove}
        className={cn(ACTION_ICON_BUTTON, 'hover:text-destructive')}
        disabled={saving}
        onClick={onRemove}
        size="icon"
        title={m.remove}
        variant="ghost"
      >
        <Codicon name="trash" size="0.8125rem" />
      </Button>
    </span>
  )
}

const LOG_POLL_MS = 2000

const STDIO_MARKER_RE = /^===== \[.*\] starting MCP server '(.+)' =====$/

// Keep only the stdio-log sections belonging to one server. The shared file
// has no per-line tags — sections start at that server's session marker and
// run until the next marker (any server's).
function filterStdioSections(lines: string[], server: string): string[] {
  const out: string[] = []
  let inSection = false

  for (const line of lines) {
    const marker = STDIO_MARKER_RE.exec(line.trim())

    if (marker) {
      inSection = marker[1] === server
    }

    if (inSection) {
      out.push(line)
    }
  }

  return out
}

// The MCP output channel — Cursor's "MCP Logs" equivalent, pinned under the
// editor. Scope follows the cursor-selected server (all servers otherwise);
// source controls live in the pane header. Body is the app's tool-output
// surface: CodeCardBody typography + the floating hover-reveal copy button.
function McpLogs({ server, source }: { server: null | string; source: 'stdio' | 'agent' }) {
  const [lines, setLines] = useState<null | string[]>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const response =
          source === 'stdio'
            ? await getLogs({ file: 'mcp', lines: 500 })
            : await getLogs({ file: 'agent', lines: 300, search: server ?? 'mcp' })

        if (!cancelled) {
          setLines(source === 'stdio' && server ? filterStdioSections(response.lines, server) : response.lines)
        }
      } catch {
        // Backend momentarily unavailable — keep the last tail.
      }
    }

    setLines(null)
    void poll()
    const timer = window.setInterval(() => void poll(), LOG_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [server, source])

  // Follow the tail unless the user scrolled up (terminal convention).
  useEffect(() => {
    const el = scrollRef.current

    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [lines])

  return (
    <div className="group/logs relative h-full min-h-0">
      <CopyButton
        appearance="inline"
        className="absolute right-2.5 top-1.5 z-10 h-5 gap-0 rounded-md px-1 opacity-5 transition-opacity group-hover/logs:opacity-100 hover:opacity-100 focus-visible:opacity-100"
        iconClassName="size-3"
        showLabel={false}
        text={() => (lines ?? []).join('\n')}
      />
      <div
        className="h-full min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
        data-selectable-text="true"
        onScroll={event => {
          const el = event.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        ref={scrollRef}
      >
        {lines === null || lines.length === 0 ? (
          // TODO(i18n): literal until the UX settles.
          <p className="px-2 py-1.5 font-mono text-[0.7rem] leading-relaxed text-muted-foreground/50">
            {lines === null ? '…' : 'No output yet.'}
          </p>
        ) : (
          <CodeCardBody>
            <pre className="whitespace-pre-wrap break-words">
              {lines.map((line, index) => (
                <span className={cn('block', line.startsWith('=====') && 'mt-1 text-(--ui-text-tertiary)')} key={index}>
                  {line}
                </span>
              ))}
            </pre>
          </CodeCardBody>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Avatars + list rows
// ---------------------------------------------------------------------------

// Brand glyphs for well-known MCP providers, exactly the Messaging avatar
// treatment (simpleicons on a 16% brand tint). Unknown servers fall back to
// the same letter monogram Messaging uses.
const MCP_BRAND_ICONS: Record<string, { Icon: ComponentType<SVGProps<SVGSVGElement>>; color: string }> = {
  figma: { Icon: SiFigma, color: '#F24E1E' },
  github: { Icon: SiGithub, color: '#181717' },
  gitlab: { Icon: SiGitlab, color: '#FC6D26' },
  linear: { Icon: SiLinear, color: '#5E6AD2' },
  notion: { Icon: SiNotion, color: '#000000' },
  postgres: { Icon: SiPostgresql, color: '#4169E1' },
  postgresql: { Icon: SiPostgresql, color: '#4169E1' },
  sentry: { Icon: SiSentry, color: '#362D59' },
  stripe: { Icon: SiStripe, color: '#635BFF' },
  supabase: { Icon: SiSupabase, color: '#3FCF8E' },
  vercel: { Icon: SiVercel, color: '#000000' }
}

const brandFor = (name: string) => {
  const lower = name.toLowerCase()

  return MCP_BRAND_ICONS[lower] ?? Object.entries(MCP_BRAND_ICONS).find(([key]) => lower.includes(key))?.[1] ?? null
}

// Registrable root, not the mcp subdomain — mcp.figma.com has no favicon and
// Google's service answers with its useless default globe; figma.com has the
// real mark.
const faviconDomain = (url: unknown): null | string => {
  if (typeof url !== 'string') {
    return null
  }

  try {
    return new URL(url).hostname.split('.').slice(-2).join('.')
  } catch {
    return null
  }
}

// PlatformAvatar (messaging), copied 1:1 — same size, radius, type scale, and
// brand-tint treatment — plus a status dot overlay. Identity ladder: curated
// brand glyph → root-domain favicon → letter monogram.
function McpAvatar({
  className,
  name,
  status,
  url
}: {
  className?: string
  name: string
  status: ServerStatus
  url?: unknown
}) {
  const brand = brandFor(name)
  const domain = faviconDomain(url)
  const [faviconFailed, setFaviconFailed] = useState(false)
  const showFavicon = !brand && domain !== null && !faviconFailed

  return (
    <span
      className={cn(
        'relative inline-grid size-6 shrink-0 place-items-center rounded-md text-[length:var(--conversation-caption-font-size)] font-medium',
        !brand && 'bg-(--ui-bg-tertiary) text-(--ui-text-tertiary)',
        className
      )}
      style={brand ? { backgroundColor: `color-mix(in srgb, ${brand.color} 16%, transparent)` } : undefined}
    >
      {brand ? (
        <brand.Icon aria-hidden className="size-3.5" style={{ color: brand.color }} />
      ) : showFavicon ? (
        <img
          alt=""
          className="size-3.5 rounded-[2px] object-contain"
          onError={() => setFaviconFailed(true)}
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
        />
      ) : (
        name.charAt(0).toUpperCase()
      )}
      <span
        aria-hidden
        className={cn(
          'absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-(--ui-chat-surface-background)',
          STATUS_DOT[status]
        )}
      />
    </span>
  )
}

function McpRow({
  active,
  busy,
  enabled,
  name,
  onProbe,
  onRemove,
  onSelect,
  onToggle,
  status,
  statusText,
  url
}: {
  active: boolean
  busy: boolean
  enabled: boolean
  name: string
  onProbe: () => void
  onRemove: () => void
  onSelect: () => void
  onToggle: (checked: boolean) => void
  status: ServerStatus
  statusText: string
  url?: unknown
}) {
  return (
    <div
      className={cn(
        'group/row row-hover flex h-11 w-full shrink-0 items-center gap-2 rounded-md pl-2 pr-1.5 hover:text-foreground',
        active ? 'bg-(--ui-row-active-background) text-foreground' : 'text-(--ui-text-secondary)'
      )}
      id={`mcp-server-${name}`}
    >
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        onClick={onSelect}
        type="button"
      >
        <McpAvatar name={name} status={status} url={url} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-[0.78rem]',
              enabled ? 'font-medium text-foreground/85' : 'font-normal text-muted-foreground/60'
            )}
          >
            {prettyName(name)}
          </span>
          <span className="block truncate text-[0.62rem] text-muted-foreground/50">{statusText}</span>
        </span>
      </button>
      <ServerIconActions
        className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100"
        onProbe={onProbe}
        onRemove={onRemove}
        probing={status === 'probing'}
        saving={busy}
      />
      <Switch
        aria-label={name}
        checked={enabled}
        className={cn(
          'shrink-0 cursor-pointer',
          !enabled && 'opacity-60',
          // Enabled ≠ working: the switch only earns its accent color once the
          // server actually connects. Connecting/error/needs-auth read as a
          // desaturated "on" — intent without success.
          enabled && status !== 'ok' && 'opacity-70 saturate-0'
        )}
        disabled={busy}
        onCheckedChange={onToggle}
        size="xs"
        title={name}
      />
    </div>
  )
}
