import { atom, computed } from 'nanostores'

import { arraysEqual, readKey, writeKey } from '@/lib/storage'
import { $activeConnectionId, $connectionsRegistry } from '@/store/connections'

// Desktop presentation only. Never filter the registry, routing roster, or
// startup preferences: a hidden gateway can still own work and become active.
// Unshipped ID-only/array keys are deliberately ignored, not migrated or deleted.
// Without native identity metadata a source stays visible (older mains/recovery).
const KEY = 'hermes.desktop.sessions.hiddenConnectionIncarnations'
const PREFIX = `${KEY}.`
export const $hiddenSessionConnectionIds = atom<string[]>([])

// URI encoding preserves existing keys; %u cannot occur in its output. The
// fallback encodes every UTF-16 code unit, preserving even lone surrogates.
export function encodeConnectionPresentationId(id: string): string {
  try {
    return encodeURIComponent(id)
  } catch {
    return `%u${id.split('').map(unit => unit.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`
  }
}

const preferenceKey = (id: string, incarnation: string) =>
  `${PREFIX}${encodeConnectionPresentationId(id)}.${encodeConnectionPresentationId(incarnation)}`

function refreshHiddenPreferences(): void {
  const entries = $connectionsRegistry.get()?.connections ?? []
  const hidden = entries
    .filter(
      connection => connection.incarnation && readKey(preferenceKey(connection.id, connection.incarnation)) === 'true'
    )
    .map(connection => connection.id)

  if (!arraysEqual(hidden, $hiddenSessionConnectionIds.get())) {
    $hiddenSessionConnectionIds.set(hidden)
  }
}

// Observers are read-only: delayed snapshots can never erase shared user intent.
// Retired incarnation keys are inert and never reused by a new registration.
$connectionsRegistry.listen(refreshHiddenPreferences)
refreshHiddenPreferences()

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== KEY && event.key !== null && !event.key.startsWith(PREFIX)) {
      return
    }

    refreshHiddenPreferences()
  })
}

export const $sessionNavigationConnections = computed(
  [$connectionsRegistry, $activeConnectionId, $hiddenSessionConnectionIds],
  (registry, activeId, hiddenIds) => {
    const connections = registry?.connections ?? []
    const visible = connections.filter(connection => connection.id === activeId || !hiddenIds.includes(connection.id))

    if (visible.length > 0 || connections.length === 0) {
      return visible.length === connections.length ? connections : visible
    }

    // A stale preference or unresolved legacy descriptor must not blank the
    // picker. Primary is the registry fallback, not a guess at the active
    // execution source. This only paints a choice; it never activates one.
    const fallback =
      connections.find(connection => connection.id === registry?.primary) ??
      connections.find(connection => connection.kind === 'local') ??
      connections[0]

    return [fallback]
  }
)

export const $hasMultipleSessionNavigationConnections = computed(
  $sessionNavigationConnections,
  connections => connections.length > 1
)

// A sole registration is still a selectable destination unless its identity
// matches the resolved source. Never infer the execution source from the list.
export const $hasSessionNavigationChoices = computed(
  [$sessionNavigationConnections, $activeConnectionId],
  (connections, activeId) => connections.some(connection => connection.id !== activeId)
)

export function setConnectionShownInSessions(connectionId: string, shown: boolean): void {
  const hidden = $hiddenSessionConnectionIds.get()
  const connection = $connectionsRegistry.get()?.connections.find(entry => entry.id === connectionId)

  if (!connection?.incarnation) {
    return
  }

  const key = preferenceKey(connectionId, connection.incarnation)

  if (shown) {
    // Independent incarnations never share a read/modify/write snapshot.
    writeKey(key, 'false')
    $hiddenSessionConnectionIds.set(hidden.filter(id => id !== connectionId))

    return
  }

  if (
    connectionId === $activeConnectionId.get() ||
    !$connectionsRegistry.get()?.connections.some(connection => connection.id === connectionId) ||
    $sessionNavigationConnections.get().length <= 1 ||
    hidden.includes(connectionId)
  ) {
    return
  }

  writeKey(key, 'true')
  $hiddenSessionConnectionIds.set([...hidden, connectionId])
}
