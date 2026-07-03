import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import { useDebounced } from '@/app/hooks/use-debounced'
import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  getActionStatus,
  getSkillHubSources,
  installSkillFromHub,
  previewSkillHub,
  scanSkillHub,
  searchSkillsHub,
  type SkillHubResult,
  type SkillHubScanResult,
  updateSkillsFromHub
} from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { upsertDesktopActionTask } from '@/store/activity'
import { notify, notifyError } from '@/store/notifications'

const ACTION_POLL_MS = 1200
const SOURCES_KEY = ['skill-hub-sources'] as const

function trustTone(level: string): string {
  switch (level) {
    case 'builtin':
      return 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'

    case 'trusted':
      return 'bg-emerald-500/15 text-emerald-400'

    default:
      return 'bg-amber-500/15 text-amber-400'
  }
}

function verdictTone(policy: string): string {
  switch (policy) {
    case 'allow':
      return 'text-emerald-400'

    case 'block':
      return 'text-destructive'

    default:
      return 'text-amber-400'
  }
}

interface SkillsHubProps {
  /** Called after an install/uninstall/update finishes so the parent can refresh the installed-skills list. */
  onInstalledChange?: () => void
  query: string
}

export function SkillsHub({ onInstalledChange, query }: SkillsHubProps) {
  const { t } = useI18n()
  const h = t.skills.hub
  const queryClient = useQueryClient()

  // Sources + featured + the installed map — one cached fetch, revalidated on
  // mount and re-fetched after an install/update action lands.
  const sourcesQuery = useQuery({
    queryKey: SOURCES_KEY,
    queryFn: getSkillHubSources,
    staleTime: 5 * 60_000
  })

  // Debounced hub search, keyed on the settled query so RQ dedupes/caches per
  // term and cancels stale terms for us (no hand-rolled sequence guard).
  const term = useDebounced(query.trim(), 350)

  const searchQuery = useQuery({
    queryKey: ['skill-hub-search', term],
    queryFn: () => searchSkillsHub(term),
    enabled: term.length > 0,
    staleTime: 60_000
  })

  // Live log tail for the most recent install/uninstall/update action.
  const [action, setAction] = useState<null | string>(null)
  const [actionLog, setActionLog] = useState<string[]>([])
  const [actionRunning, setActionRunning] = useState(false)

  // Preview/scan dialog. Preview is cache-worthy (keyed by identifier); scan is
  // an explicit, on-demand security pass so it stays imperative.
  const [detail, setDetail] = useState<null | SkillHubResult>(null)
  const [scan, setScan] = useState<null | SkillHubScanResult>(null)
  const [scanning, setScanning] = useState(false)

  const previewQuery = useQuery({
    queryKey: ['skill-hub-preview', detail?.identifier],
    queryFn: () => previewSkillHub(detail!.identifier),
    enabled: detail !== null,
    staleTime: 5 * 60_000
  })

  // Poll a spawned hub action's log until it exits, then refresh installed state.
  useEffect(() => {
    if (!action) {
      return
    }

    let cancelled = false
    let timer: null | number = null

    const poll = async () => {
      try {
        const status = await getActionStatus(action, 200)

        if (cancelled) {
          return
        }

        setActionLog(status.lines)
        setActionRunning(status.running)
        upsertDesktopActionTask(status)

        if (status.running) {
          timer = window.setTimeout(() => void poll(), ACTION_POLL_MS)
        } else {
          void queryClient.invalidateQueries({ queryKey: SOURCES_KEY })
          onInstalledChange?.()
        }
      } catch {
        if (!cancelled) {
          setActionRunning(false)
        }
      }
    }

    void poll()

    return () => {
      cancelled = true

      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [action, onInstalledChange, queryClient])

  const install = useCallback(
    async (identifier: string, name: string) => {
      try {
        const started = await installSkillFromHub(identifier)
        notify({ kind: 'success', title: h.installStarted(name), message: h.actionLog })
        setActionLog([])
        setActionRunning(true)
        setAction(started.name)
        setDetail(null)
      } catch (err) {
        notifyError(err, h.actionFailed)
      }
    },
    [h]
  )

  const updateAll = useCallback(async () => {
    try {
      const started = await updateSkillsFromHub()
      notify({ kind: 'success', title: h.updateStarted, message: h.actionLog })
      setActionLog([])
      setActionRunning(true)
      setAction(started.name)
    } catch (err) {
      notifyError(err, h.actionFailed)
    }
  }, [h])

  const runScan = useCallback(
    (identifier: string) => {
      setScanning(true)
      scanSkillHub(identifier)
        .then(setScan)
        .catch(err => notifyError(err, h.scanFailed))
        .finally(() => setScanning(false))
    },
    [h]
  )

  const openDetail = useCallback((skill: SkillHubResult) => {
    setDetail(skill)
    setScan(null)
  }, [])

  // Installed map: sources seeds it, search results patch it (a term can surface
  // installs the sources list didn't feature).
  const installed = { ...(sourcesQuery.data?.installed ?? {}), ...(searchQuery.data?.installed ?? {}) }
  const isInstalled = (identifier: string) => Boolean(installed[identifier])

  const sources = sourcesQuery.data?.sources ?? []
  const featured = sourcesQuery.data?.featured ?? []
  const results = searchQuery.data?.results ?? []
  const timedOut = searchQuery.data?.timed_out ?? []

  const searching = term.length > 0 && searchQuery.isFetching
  const searched = term.length > 0 && searchQuery.isSuccess
  const showLanding = term.length === 0
  const listed = showLanding ? featured : results
  const hasInstalled = Object.keys(installed).length > 0

  return (
    <div className="space-y-4 overflow-y-auto p-4 [scrollbar-gutter:stable]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {sourcesQuery.isLoading ? (
            <span>{h.connectingHubs}</span>
          ) : (
            <>
              <span>{h.connectedHubs}</span>
              {sources.map(source => {
                const degraded = source.available === false || source.rate_limited === true

                return (
                  <Badge
                    className={cn(
                      degraded ? 'bg-amber-500/15 text-amber-400' : 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
                    )}
                    key={source.id}
                  >
                    {source.label}
                  </Badge>
                )
              })}
            </>
          )}
        </div>
        {hasInstalled && (
          <Button disabled={actionRunning} onClick={() => void updateAll()} size="xs" variant="text">
            {actionRunning ? h.updating : h.updateAll}
          </Button>
        )}
      </div>

      {searched && !searching && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{h.resultCount(results.length, null)}</span>
          {timedOut.length > 0 && <span className="text-amber-400">{h.timedOut(timedOut.join(', '))}</span>}
        </div>
      )}

      {searching ? (
        <PageLoader className="min-h-40" label={h.searching} />
      ) : listed.length === 0 ? (
        <div className="grid min-h-40 place-items-center text-center">
          <div className="max-w-md text-xs text-muted-foreground">{searched ? h.noResults : h.landingHint}</div>
        </div>
      ) : (
        <div className="space-y-1">
          {showLanding && (
            <div className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {h.featured}
            </div>
          )}
          <div>
            {listed.map(skill => (
              <div
                className="grid gap-3 px-0 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                key={skill.identifier}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{skill.name}</span>
                    <Badge className={trustTone(skill.trust_level)}>
                      {h.trust[skill.trust_level] ?? skill.trust_level}
                    </Badge>
                    {isInstalled(skill.identifier) && (
                      <Badge className="bg-emerald-500/15 text-emerald-400">{h.installed}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button onClick={() => openDetail(skill)} size="xs" variant="text">
                    {h.preview}
                  </Button>
                  <Button
                    disabled={actionRunning || isInstalled(skill.identifier)}
                    onClick={() => void install(skill.identifier, skill.name)}
                    size="xs"
                    variant="textStrong"
                  >
                    {isInstalled(skill.identifier) ? h.installed : h.install}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {action && actionLog.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {h.actionLog}
            {actionRunning && <Codicon name="loading" size="0.75rem" spinning />}
          </div>
          <pre
            className="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3 font-mono text-[0.65rem] leading-relaxed text-(--ui-text-tertiary)"
            data-selectable-text="true"
          >
            {actionLog.join('\n')}
          </pre>
        </div>
      )}

      <Dialog onOpenChange={open => !open && setDetail(null)} open={detail !== null}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="truncate">{detail.name}</span>
                  <Badge className={trustTone(detail.trust_level)}>
                    {h.trust[detail.trust_level] ?? detail.trust_level}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="truncate">{detail.identifier}</DialogDescription>
              </DialogHeader>

              <div className="min-h-0 space-y-3 overflow-y-auto">
                {scan && (
                  <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3 text-xs">
                    <div className={cn('font-medium', verdictTone(scan.policy))}>
                      {scan.policy === 'allow' ? h.policyAllow : scan.policy === 'block' ? h.policyBlock : h.policyAsk}
                      {' · '}
                      {scan.verdict === 'safe'
                        ? h.verdictSafe
                        : scan.verdict === 'dangerous'
                          ? h.verdictDangerous
                          : h.verdictCaution}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {scan.findings.length === 0 ? h.noFindings : h.findings(scan.findings.length)}
                    </div>
                    {scan.findings.slice(0, 12).map((finding, index) => (
                      <div className="mt-1.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)" key={index}>
                        [{finding.severity}] {finding.file}
                        {finding.line !== null ? `:${finding.line}` : ''} — {finding.description}
                      </div>
                    ))}
                  </div>
                )}

                {previewQuery.isLoading ? (
                  <PageLoader className="min-h-32" label={h.searching} />
                ) : previewQuery.data ? (
                  <>
                    <pre
                      className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3 font-mono text-[0.68rem] leading-relaxed"
                      data-selectable-text="true"
                    >
                      {previewQuery.data.skill_md || h.noReadme}
                    </pre>
                    {previewQuery.data.files.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">{h.files}:</span> {previewQuery.data.files.join(', ')}
                      </div>
                    )}
                  </>
                ) : null}
              </div>

              <DialogFooter>
                <Button disabled={scanning} onClick={() => runScan(detail.identifier)} size="sm" variant="text">
                  {scanning ? h.scanning : h.scan}
                </Button>
                <Button
                  disabled={actionRunning || isInstalled(detail.identifier)}
                  onClick={() => void install(detail.identifier, detail.name)}
                  size="sm"
                >
                  {isInstalled(detail.identifier) ? h.installed : h.install}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
