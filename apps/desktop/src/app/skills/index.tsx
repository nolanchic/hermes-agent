import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { ArchiveSkillConfirmDialog } from '@/app/learning/archive-skill-confirm-dialog'
import { CodeEditor } from '@/components/chat/code-editor'
import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CountSkeleton } from '@/components/ui/skeleton'
import {
  editLearningNode,
  getLearningNode,
  getSkills,
  getToolsets,
  getUsageAnalytics,
  type HermesGateway,
  toggleSkill,
  toggleToolset
} from '@/hermes'
import { useI18n } from '@/i18n'
import { isDesktopToolsetVisible } from '@/lib/desktop-toolsets'
import { compactNumber } from '@/lib/format'
import { normalize } from '@/lib/text'
import { $gateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import {
  CapRow,
  DetailColumn,
  DetailPane,
  ListColumn,
  ListStrip,
  ListStripButton,
  ListStripMenu,
  type ListStripMenuToggle,
  MasterDetail
} from '../master-detail'
import { PanelEmpty, PanelPill } from '../overlays/panel'
import { PageSearchShell } from '../page-search-shell'
import { ComputerUsePanel } from '../settings/computer-use-panel'
import { asText, includesQuery, prettyName, toolNames, toolsetDisplayLabel } from '../settings/helpers'
import { ToolsetConfigPanel } from '../settings/toolset-config-panel'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { McpTab } from './mcp-tab'
import { $skillsSortDesc, $toolsetsSortDesc } from './store'

const SKILLS_MODES = ['skills', 'toolsets', 'mcp'] as const

const usageOf = (skill: SkillInfo): number => (typeof skill.usage === 'number' ? skill.usage : 0)

const categoryFor = (skill: SkillInfo): string => asText(skill.category) || 'general'

// TODO(i18n): literals until the UX settles.
const PROVENANCE_LABEL: Record<NonNullable<SkillInfo['provenance']>, string> = {
  agent: 'Learned',
  bundled: 'Built-in',
  hub: 'Hub'
}

// Row subtitle: category, with non-default origins badged.
function skillSubtitle(skill: SkillInfo): React.ReactNode {
  const category = prettyName(categoryFor(skill))
  const provenance = skill.provenance

  return (
    <>
      <span className="truncate">{category}</span>
      {provenance === 'agent' && (
        <Badge className="shrink-0 normal-case" variant="default">
          learned
        </Badge>
      )}
      {provenance === 'hub' && (
        <Badge className="shrink-0 normal-case" variant="muted">
          hub
        </Badge>
      )}
    </>
  )
}

function filteredSkills(skills: SkillInfo[], query: string, desc: boolean): SkillInfo[] {
  const q = normalize(query)
  const sign = desc ? 1 : -1

  return skills
    .filter(
      skill =>
        !q || includesQuery(skill.name, q) || includesQuery(skill.description, q) || includesQuery(skill.category, q)
    )
    .sort((a, b) => sign * (usageOf(b) - usageOf(a)) || asText(a.name).localeCompare(asText(b.name)))
}

const toolsetCalls = (toolset: ToolsetInfo, toolCalls: Record<string, number>): number =>
  toolNames(toolset).reduce((sum, name) => sum + (toolCalls[name] ?? 0), 0)

function filteredToolsets(
  toolsets: ToolsetInfo[],
  query: string,
  toolCalls: Record<string, number>,
  desc: boolean
): ToolsetInfo[] {
  const q = normalize(query)
  const sign = desc ? 1 : -1

  return toolsets
    .filter(toolset => {
      if (!isDesktopToolsetVisible(toolset.name)) {
        return false
      }

      if (!q) {
        return true
      }

      return (
        includesQuery(toolset.name, q) ||
        includesQuery(toolsetDisplayLabel(toolset), q) ||
        includesQuery(toolset.description, q) ||
        toolNames(toolset).some(name => includesQuery(name, q))
      )
    })
    .sort(
      (a, b) =>
        sign * (toolsetCalls(b, toolCalls) - toolsetCalls(a, toolCalls)) ||
        toolsetDisplayLabel(a).localeCompare(toolsetDisplayLabel(b))
    )
}

const visibleToolsetCount = (toolsets: ToolsetInfo[]) => toolsets.filter(ts => isDesktopToolsetVisible(ts.name)).length

interface SkillsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function SkillsView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: SkillsViewProps) {
  const { t } = useI18n()
  const gateway = useStore($gateway) as HermesGateway | null
  const [mode, setMode] = useRouteEnumParam('tab', SKILLS_MODES, 'skills')

  const [query, setQuery] = useState('')
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [toolsets, setToolsets] = useState<ToolsetInfo[] | null>(null)
  // tool name -> call count over the analytics window. null = still loading
  // (badges show skeletons); {} = loaded empty / unavailable backend.
  const [toolCalls, setToolCalls] = useState<Record<string, number> | null>(null)
  const skillsSortDesc = useStore($skillsSortDesc)
  const toolsetsSortDesc = useStore($toolsetsSortDesc)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [selectedToolset, setSelectedToolset] = useState<string | null>(null)

  const refreshCapabilities = useCallback(async () => {
    try {
      const [nextSkills, nextToolsets] = await Promise.all([getSkills(), getToolsets()])
      setSkills(nextSkills)
      setToolsets(nextToolsets)
    } catch (err) {
      notifyError(err, t.skills.skillsLoadFailed)
    }

    // Silent enrichment — the message-scan behind this is slow and optional.
    // A year-wide window, not the analytics default 30d: skill usage badges
    // are all-time, and "do I use this capability" is a habit question, not
    // a billing-period one. (Rarely-called tools like `memory` mostly work
    // through ambient pipelines; their explicit calls are sparse.)
    getUsageAnalytics(365)
      .then(analytics =>
        setToolCalls(Object.fromEntries((analytics.tools ?? []).map(entry => [entry.tool, entry.count])))
      )
      .catch(() => setToolCalls({}))
  }, [t])

  const refreshToolsets = useCallback(() => {
    getToolsets()
      .then(setToolsets)
      .catch(err => notifyError(err, t.skills.toolsetsRefreshFailed))
  }, [t])

  useRefreshHotkey(refreshCapabilities)

  useEffect(() => {
    void refreshCapabilities()
  }, [refreshCapabilities])

  const visibleSkills = useMemo(
    () => (skills ? filteredSkills(skills, query, skillsSortDesc) : []),
    [query, skills, skillsSortDesc]
  )

  const visibleToolsets = useMemo(
    () => (toolsets ? filteredToolsets(toolsets, query, toolCalls ?? {}, toolsetsSortDesc) : []),
    [query, toolCalls, toolsets, toolsetsSortDesc]
  )

  // Rotating placeholder nudges from the user's own data — teach that search
  // understands categories and tool names, not just titles.
  // TODO(i18n): literals until the UX settles.
  const searchHints = useMemo(() => {
    if (mode === 'skills' && skills?.length) {
      const counts = new Map<string, number>()

      for (const skill of skills) {
        const key = categoryFor(skill)
        counts.set(key, (counts.get(key) || 0) + 1)
      }

      return [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([category]) => `Try “${category.toLowerCase()}”`)
    }

    if (mode === 'toolsets' && toolsets?.length) {
      return toolsets
        .filter(ts => isDesktopToolsetVisible(ts.name) && toolNames(ts).length > 0)
        .slice(0, 5)
        .map(ts => `Try “${toolNames(ts)[0]}”`)
    }

    return undefined
  }, [mode, skills, toolsets])

  // Keep a valid selection: fall back to the first visible row when the
  // current selection is filtered out (or nothing is selected yet).
  const activeSkill = useMemo(
    () => visibleSkills.find(s => s.name === selectedSkill) ?? visibleSkills[0] ?? null,
    [selectedSkill, visibleSkills]
  )

  const activeToolset = useMemo(
    () => visibleToolsets.find(ts => ts.name === selectedToolset) ?? visibleToolsets[0] ?? null,
    [selectedToolset, visibleToolsets]
  )

  // Single toggles are optimistic and silent on success (the row repaints
  // immediately — a toast per flip would spam rapid customization). Errors
  // revert and notify.
  async function handleToggleSkill(skill: SkillInfo, enabled: boolean) {
    setSkills(current => current?.map(row => (row.name === skill.name ? { ...row, enabled } : row)) ?? current)

    try {
      await toggleSkill(skill.name, enabled)
    } catch (err) {
      setSkills(
        current => current?.map(row => (row.name === skill.name ? { ...row, enabled: !enabled } : row)) ?? current
      )
      notifyError(err, t.skills.failedToUpdate(skill.name))
    }
  }

  async function handleToggleToolset(toolset: ToolsetInfo, enabled: boolean) {
    setToolsets(
      current =>
        current?.map(row => (row.name === toolset.name ? { ...row, enabled, available: enabled } : row)) ?? current
    )

    try {
      await toggleToolset(toolset.name, enabled)
    } catch (err) {
      setToolsets(
        current =>
          current?.map(row => (row.name === toolset.name ? { ...row, enabled: !enabled, available: !enabled } : row)) ??
          current
      )
      notifyError(err, t.skills.failedToUpdate(toolsetDisplayLabel(toolset)))
    }
  }

  // Sequential on purpose: each toggle is a config read-modify-write on the
  // backend; parallel calls would race the disabled-list save.
  async function bulkApply(skillTargets: SkillInfo[], toolsetTargets: ToolsetInfo[], enabled: boolean) {
    if (bulkBusy || skillTargets.length + toolsetTargets.length === 0) {
      return
    }

    setBulkBusy(true)

    let done = 0

    try {
      for (const row of skillTargets) {
        await toggleSkill(row.name, enabled)
        setSkills(cur => cur?.map(r => (r.name === row.name ? { ...r, enabled } : r)) ?? cur)
        done += 1
      }

      for (const row of toolsetTargets) {
        await toggleToolset(row.name, enabled)
        setToolsets(cur => cur?.map(r => (r.name === row.name ? { ...r, enabled, available: enabled } : r)) ?? cur)
        done += 1
      }

      notify({ kind: 'success', title: t.skills.bulkUpdated(done), message: '' })
    } catch (err) {
      notifyError(err, t.skills.failedToUpdate(mode === 'skills' ? t.skills.tabSkills : t.skills.tabToolsets))
    } finally {
      setBulkBusy(false)
    }
  }

  const bulkToggle = (enabled: boolean) =>
    mode === 'skills'
      ? bulkApply(
          visibleSkills.filter(row => row.enabled !== enabled),
          [],
          enabled
        )
      : bulkApply(
          [],
          visibleToolsets.filter(row => row.enabled !== enabled),
          enabled
        )

  // "Never used" = zero recorded activity. The pruning move for a 100+ skill
  // install: keep the workhorses, shed the noise.
  const disableUnused = () =>
    bulkApply(
      visibleSkills.filter(skill => skill.enabled && usageOf(skill) === 0),
      [],
      false
    )

  // One switch line covering enable-all/disable-all.
  // TODO(i18n): literals until the UX settles.
  const bulkSwitch = (allEnabled: boolean): ListStripMenuToggle => ({
    checked: allEnabled,
    disabled: bulkBusy,
    label: 'All',
    onToggle: checked => void bulkToggle(checked)
  })

  const allSkillsEnabled = visibleSkills.length > 0 && visibleSkills.every(s => s.enabled)
  const allToolsetsEnabled = visibleToolsets.length > 0 && visibleToolsets.every(ts => ts.enabled)

  // TODO(i18n): literals until the UX settles.
  const sortButton = (desc: boolean, flip: () => void) => (
    <ListStripButton onClick={flip}>{desc ? '↓ Most used' : '↑ Least used'}</ListStripButton>
  )

  // Learned/local skills are editable + archivable, mirroring the memory
  // graph (same /api/learning/node endpoints — delete archives, restorable
  // via `hermes curator restore`).
  const [skillEditor, setSkillEditor] = useState<null | { content: string; name: string }>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillSaving, setSkillSaving] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<null | string>(null)

  const openSkillEditor = async (name: string) => {
    try {
      const node = await getLearningNode(name)
      setSkillEditor({ content: node.content, name })
      setSkillDraft(node.content)
    } catch (err) {
      notifyError(err, name)
    }
  }

  const saveSkillEdit = async () => {
    if (!skillEditor) {
      return
    }

    setSkillSaving(true)

    try {
      await editLearningNode(skillEditor.name, skillDraft)
      // TODO(i18n): literal until the UX settles.
      notify({ kind: 'success', title: 'Skill updated', message: t.skills.appliesToNewSessions(skillEditor.name) })
      setSkillEditor(null)
      void refreshCapabilities()
    } catch (err) {
      notifyError(err, skillEditor.name)
    } finally {
      setSkillSaving(false)
    }
  }

  const skillEditorPane = skillEditor && (
    <DetailPane
      actions={
        <Button disabled={skillSaving} onClick={() => void saveSkillEdit()} size="xs">
          {/* TODO(i18n): literal until the UX settles. */}
          {skillSaving ? t.common.saving : 'Save'}
        </Button>
      }
      id="skill-editor"
      onClose={() => setSkillEditor(null)}
      title={<span className="text-[0.68rem] font-normal text-muted-foreground/60">{skillEditor.name}/SKILL.md</span>}
    >
      <CodeEditor
        filePath="SKILL.md"
        initialValue={skillEditor.content}
        key={skillEditor.name}
        onCancel={() => setSkillEditor(null)}
        onChange={setSkillDraft}
        onSave={() => void saveSkillEdit()}
      />
    </DetailPane>
  )

  return (
    <PageSearchShell
      {...props}
      activeTab={mode}
      onSearchChange={setQuery}
      onTabChange={id => setMode(id as (typeof SKILLS_MODES)[number])}
      // MCP manages a handful of entries with the editor right there —
      // searching it is noise.
      searchHidden={mode === 'mcp'}
      searchHints={searchHints}
      searchPlaceholder={mode === 'skills' ? t.skills.searchSkills : t.skills.searchToolsets}
      searchValue={query}
      tabs={[
        { id: 'skills', label: t.skills.tabSkills, meta: skills?.length ?? null },
        { id: 'toolsets', label: t.skills.tabToolsets, meta: toolsets ? visibleToolsetCount(toolsets) : null },
        { id: 'mcp', label: t.skills.tabMcp }
      ]}
    >
      {mode === 'mcp' ? (
        <McpTab gateway={gateway} />
      ) : !skills || !toolsets ? (
        <PageLoader label={t.skills.loading} />
      ) : mode === 'skills' ? (
        <MasterDetail pane={skillEditorPane} split="wide">
          <ListColumn
            header={
              <ListStrip
                left={sortButton(skillsSortDesc, () => $skillsSortDesc.set(!$skillsSortDesc.get()))}
                right={
                  <ListStripMenu
                    items={[{ disabled: bulkBusy, label: 'Disable unused', onSelect: () => void disableUnused() }]}
                    label={t.skills.tabSkills}
                    toggle={bulkSwitch(allSkillsEnabled)}
                  />
                }
              />
            }
          >
            {visibleSkills.length === 0 ? (
              <PanelEmpty description={t.skills.noSkillsDesc} icon="search" title={t.skills.noSkillsTitle} />
            ) : (
              visibleSkills.map(skill => (
                <CapRow
                  active={activeSkill?.name === skill.name}
                  busy={bulkBusy}
                  enabled={skill.enabled}
                  key={skill.name}
                  meta={usageOf(skill) > 0 ? `×${compactNumber(usageOf(skill))}` : undefined}
                  onSelect={() => setSelectedSkill(skill.name)}
                  onToggle={enabled => void handleToggleSkill(skill, enabled)}
                  subtitle={skillSubtitle(skill)}
                  title={skill.name}
                  toggleLabel={skill.name}
                />
              ))
            )}
          </ListColumn>
          {/* TODO(i18n): literal until the UX settles. */}
          <DetailColumn footer="Changes apply to new sessions.">
            {activeSkill && (
              <SkillDetail
                onArchive={() => setArchiveTarget(activeSkill.name)}
                onEdit={() => void openSkillEditor(activeSkill.name)}
                skill={activeSkill}
              />
            )}
          </DetailColumn>
        </MasterDetail>
      ) : (
        <MasterDetail split="wide">
          <ListColumn
            header={
              <ListStrip
                left={sortButton(toolsetsSortDesc, () => $toolsetsSortDesc.set(!$toolsetsSortDesc.get()))}
                right={<ListStripMenu label={t.skills.tabToolsets} toggle={bulkSwitch(allToolsetsEnabled)} />}
              />
            }
          >
            {visibleToolsets.length === 0 ? (
              <PanelEmpty description={t.skills.noToolsetsDesc} icon="search" title={t.skills.noToolsetsTitle} />
            ) : (
              visibleToolsets.map(toolset => {
                const label = toolsetDisplayLabel(toolset)
                const calls = toolCalls ? toolsetCalls(toolset, toolCalls) : null

                return (
                  <CapRow
                    active={activeToolset?.name === toolset.name}
                    busy={bulkBusy}
                    enabled={toolset.enabled}
                    key={toolset.name}
                    meta={
                      calls === null ? (
                        <CountSkeleton />
                      ) : calls > 0 ? (
                        `×${compactNumber(calls)}`
                      ) : (
                        `${toolNames(toolset).length} tools`
                      )
                    }
                    onSelect={() => setSelectedToolset(toolset.name)}
                    onToggle={checked => void handleToggleToolset(toolset, checked)}
                    subtitle={asText(toolset.description)}
                    title={label}
                    toggleLabel={t.skills.toggleToolset(label)}
                  />
                )
              })
            )}
          </ListColumn>
          {/* TODO(i18n): literal until the UX settles. */}
          <DetailColumn footer="Changes apply to new sessions.">
            {activeToolset && (
              <ToolsetDetail onConfiguredChange={refreshToolsets} toolCalls={toolCalls ?? {}} toolset={activeToolset} />
            )}
          </DetailColumn>
        </MasterDetail>
      )}
      {archiveTarget && (
        <ArchiveSkillConfirmDialog
          onApply={() => {
            const name = archiveTarget
            const snapshot = skills

            setSkills(current => current?.filter(skill => skill.name !== name) ?? current)

            if (skillEditor?.name === name) {
              setSkillEditor(null)
            }

            return () => setSkills(snapshot)
          }}
          onClose={() => setArchiveTarget(null)}
          onFailure={(err, name) => notifyError(err, name)}
          open
          skillId={archiveTarget}
          skillName={archiveTarget}
        />
      )}
    </PageSearchShell>
  )
}

// Shared inspector header, on the Messaging detail's type scale. No toggle —
// the selected row's switch is right there in the list; showing it twice
// invites drift. `pills` sit inline with the title, never on their own line.
function DetailHeader({ title, pills }: { title: string; pills?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="min-w-0 truncate text-[0.9375rem] font-semibold tracking-tight">{title}</h3>
      {pills}
    </div>
  )
}

function SkillDetail({ onArchive, onEdit, skill }: { onArchive: () => void; onEdit: () => void; skill: SkillInfo }) {
  const { t } = useI18n()
  // Only learned/local skills are the user's to rewrite or archive — bundled
  // and hub skills are managed by their sources.
  const editable = skill.provenance === 'agent'

  return (
    <>
      <DetailHeader
        pills={
          <>
            <PanelPill>{prettyName(categoryFor(skill))}</PanelPill>
            {skill.provenance && skill.provenance !== 'bundled' && (
              <PanelPill tone={skill.provenance === 'agent' ? 'good' : 'muted'}>
                {PROVENANCE_LABEL[skill.provenance]}
              </PanelPill>
            )}
          </>
        }
        title={skill.name}
      />
      <p className="text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {asText(skill.description) || t.skills.noDescription}
      </p>
      {editable && (
        <div className="flex items-center gap-2">
          {/* TODO(i18n): literals until the UX settles. */}
          <Button onClick={onEdit} size="xs" variant="text">
            Edit
          </Button>
          <Button className="text-destructive hover:text-destructive" onClick={onArchive} size="xs" variant="text">
            Archive
          </Button>
        </div>
      )}
    </>
  )
}

function ToolsetDetail({
  toolset,
  toolCalls,
  onConfiguredChange
}: {
  toolset: ToolsetInfo
  toolCalls: Record<string, number>
  onConfiguredChange: () => void
}) {
  const { t } = useI18n()
  const tools = toolNames(toolset)
  const label = toolsetDisplayLabel(toolset)

  return (
    <>
      {/* "Configured" as a resting state is noise — only the warn state earns a pill. */}
      <DetailHeader
        pills={!toolset.configured && <PanelPill tone="warn">{t.skills.needsKeys}</PanelPill>}
        title={label}
      />
      <p className="text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {asText(toolset.description) || t.skills.noDescription}
      </p>
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tools.map(name => (
            <span
              className="rounded-md bg-(--ui-bg-quinary) px-1.5 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)"
              key={name}
            >
              {name}
              {(toolCalls[name] ?? 0) > 0 && (
                <span className="ml-1 text-(--ui-text-quaternary)">×{compactNumber(toolCalls[name])}</span>
              )}
            </span>
          ))}
        </div>
      )}
      {toolset.name === 'computer_use' && <ComputerUsePanel onConfiguredChange={onConfiguredChange} />}
      <ToolsetConfigPanel key={toolset.name} onConfiguredChange={onConfiguredChange} toolset={toolset.name} />
    </>
  )
}
