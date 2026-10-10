import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopConnectionsRegistry, HermesConnection } from '@/global'

import type * as NavigationStore from './connection-navigation'
import type * as ConnectionsStore from './connections'
import type * as SessionStore from './session'

const LEGACY_KEY = 'hermes.desktop.sessions.hiddenConnectionIds'
const KEY = 'hermes.desktop.sessions.hiddenConnectionIncarnations'
const preferenceKey = (id: string, incarnation = registry.connections.find(c => c.id === id)!.incarnation!) =>
  `${KEY}.${encodeURIComponent(id)}.${encodeURIComponent(incarnation)}`

const registry: DesktopConnectionsRegistry = {
  version: 2,
  secureTokenStorage: true,
  primary: 'homelab',
  lastUsed: 'work',
  launchMode: 'last-used',
  connections: [
    {
      id: 'local',
      incarnation: '00000000-0000-4000-8000-000000000001',
      kind: 'local',
      label: 'This device',
      tokenSet: false,
      tokenPreview: null
    },
    {
      id: 'homelab',
      incarnation: '00000000-0000-4000-8000-000000000002',
      kind: 'remote',
      label: 'Homelab',
      tokenSet: true,
      tokenPreview: 'synthetic'
    },
    {
      id: 'work',
      incarnation: '00000000-0000-4000-8000-000000000003',
      kind: 'ssh',
      label: 'Work',
      tokenSet: false,
      tokenPreview: null
    }
  ]
}

async function recreatedRegistry(): Promise<DesktopConnectionsRegistry> {
  const { normalizeConnectionInput } = await import(String('../../electron/connection-registry'))
  const base = { version: 2, primary: 'local', lastUsed: 'local', launchMode: 'primary', connections: [] }
  const replacement = normalizeConnectionInput(
    { id: 'work', kind: 'ssh', label: 'Work', host: 'synthetic.invalid' },
    base
  )
  return {
    ...registry,
    connections: registry.connections.map(c => (c.id === 'work' ? { ...c, incarnation: replacement.incarnation } : c))
  }
}

let navigation: typeof NavigationStore
let connections: typeof ConnectionsStore
let session: typeof SessionStore
const storageListeners = new Set<EventListenerOrEventListenerObject>()

const descriptor = (connectionId?: string): HermesConnection => ({
  connectionId,
  baseUrl: 'http://synthetic.invalid',
  wsUrl: 'ws://synthetic.invalid/ws',
  token: 'synthetic-test-token',
  mode: connectionId === 'local' ? 'local' : 'remote',
  isFullscreen: false,
  logs: [],
  nativeOverlayWidth: 0,
  windowButtonPosition: null
})

async function load(hidden?: string) {
  vi.resetModules()

  if (hidden !== undefined) {
    localStorage.setItem(KEY, hidden)
    try {
      const ids = JSON.parse(hidden)
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (registry.connections.some(c => c.id === id)) {
            localStorage.setItem(preferenceKey(id), 'true')
          }
        }
      }
    } catch {
      /* Corruption must remain readable without repair. */
    }
  }

  const addListener = vi.spyOn(window, 'addEventListener')
  navigation = await import('./connection-navigation')
  connections = await import('./connections')
  session = await import('./session')

  for (const [type, listener] of addListener.mock.calls) {
    if (type === 'storage') {
      storageListeners.add(listener)
    }
  }

  addListener.mockRestore()
  session.$connection.set(descriptor('homelab'))
  connections.setConnectionsRegistry(registry)
}

beforeEach(async () => {
  localStorage.clear()
  await load()
})

afterEach(() => {
  cleanup()

  for (const listener of storageListeners) {
    window.removeEventListener('storage', listener)
  }

  storageListeners.clear()
  session.$connection.set(null)
  connections.$connectionsRegistry.set(null)
})

describe('Sessions navigation connections', () => {
  it('ignores unshipped pre-incarnation keys and leaves missing native identities visible', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['local', 'work']))
    localStorage.setItem(`${LEGACY_KEY}.work`, 'true')
    await load()
    expect(navigation.$sessionNavigationConnections.get()).toEqual(registry.connections)
    connections.setConnectionsRegistry({
      ...registry,
      connections: registry.connections.map(({ incarnation: _identity, ...c }) => c)
    })
    navigation.setConnectionShownInSessions('work', false)
    expect(navigation.$sessionNavigationConnections.get()).toEqual(connections.$connectionsRegistry.get()!.connections)
    expect(localStorage.getItem(`${LEGACY_KEY}.work`)).toBe('true')
  })

  it('registry and storage observers never persist preferences, including stale snapshots and corrupt keys', () => {
    navigation.setConnectionShownInSessions('work', false)
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const removals = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      connections.setConnectionsRegistry({
        ...registry,
        connections: registry.connections.filter(c => c.id !== 'work')
      })
      connections.setConnectionsRegistry(registry)
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
      expect(navigation.$hiddenSessionConnectionIds.get()).toContain('work')
      expect(writes).not.toHaveBeenCalled()
      expect(removals).not.toHaveBeenCalled()
    } finally {
      writes.mockRestore()
      removals.mockRestore()
    }
    localStorage.setItem(preferenceKey('work'), 'garbage')
    window.dispatchEvent(new StorageEvent('storage', { key: preferenceKey('work') }))
    expect(navigation.$hiddenSessionConnectionIds.get()).toEqual([])
    expect(localStorage.getItem(preferenceKey('work'))).toBe('garbage')
  })

  it.each(['add', 'remove/recreate'] as const)(
    'preserves a newer explicit hide before another window observes old lifecycle snapshots: %s',
    async lifecycle => {
      const absent = { ...registry, connections: registry.connections.filter(entry => entry.id !== 'work') }
      const latest = lifecycle === 'add' ? registry : await recreatedRegistry()

      if (lifecycle === 'add') {
        connections.setConnectionsRegistry(absent)
      }

      const first = navigation
      const firstConnections = connections
      await load()

      if (lifecycle === 'add') {
        connections.setConnectionsRegistry(absent)
      } else {
        firstConnections.setConnectionsRegistry(absent)
      }

      firstConnections.setConnectionsRegistry(latest)
      first.setConnectionShownInSessions('work', false)
      expect(localStorage.getItem(preferenceKey('work', latest.connections[2].incarnation!))).toBe('true')

      if (lifecycle === 'remove/recreate') {
        connections.setConnectionsRegistry(absent)
      }

      connections.setConnectionsRegistry(latest)
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
      expect(first.$hiddenSessionConnectionIds.get()).toContain('work')
      expect(navigation.$hiddenSessionConnectionIds.get()).toContain('work')
      expect(localStorage.getItem(preferenceKey('work', latest.connections[2].incarnation!))).toBe('true')
    }
  )

  it('does not let an old removed push erase a hide made after same-ID recreation', async () => {
    const latest = await recreatedRegistry()
    const { useConnectionsRegistry } = await import('@/app/gateway/hooks/use-connections-registry')
    const { $desktopBoot } = await import('@/store/boot')
    const originalBoot = $desktopBoot.get()
    const originalBridge = window.hermesDesktop
    let changed: ((payload: { connectionId: string; incarnation?: string; reason: 'removed' }) => void) | undefined
    let view: ReturnType<typeof renderHook> | undefined

    try {
      $desktopBoot.set({ ...originalBoot, running: true })
      window.hermesDesktop = {
        connections: {
          list: async () => latest,
          onChanged: callback => {
            changed = callback

            return () => {
              changed = undefined
            }
          }
        }
      } as typeof window.hermesDesktop
      view = renderHook(useConnectionsRegistry)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      connections.setConnectionsRegistry({
        ...registry,
        connections: registry.connections.filter(entry => entry.id !== 'work')
      })
      connections.setConnectionsRegistry(latest)
      navigation.setConnectionShownInSessions('work', false)
      await act(async () => {
        changed!({ connectionId: 'work', incarnation: registry.connections[2].incarnation, reason: 'removed' })
        await Promise.resolve()
      })
      expect(navigation.$hiddenSessionConnectionIds.get()).toContain('work')
      expect(localStorage.getItem(preferenceKey('work', latest.connections[2].incarnation!))).toBe('true')
    } finally {
      view?.unmount()
      window.hermesDesktop = originalBridge
      $desktopBoot.set(originalBoot)
    }
  })

  it('retires an explicit removal push even when a coalesced registry read already contains the recreated ID', async () => {
    const latest = await recreatedRegistry()
    const { useConnectionsRegistry } = await import('@/app/gateway/hooks/use-connections-registry')
    const { $desktopBoot } = await import('@/store/boot')
    const originalBoot = $desktopBoot.get()
    const originalBridge = window.hermesDesktop
    let changed: ((payload: { connectionId: string; incarnation?: string; reason: 'removed' }) => void) | undefined
    let view: ReturnType<typeof renderHook> | undefined

    try {
      $desktopBoot.set({ ...originalBoot, running: true })
      window.hermesDesktop = {
        connections: {
          list: async () => latest,
          onChanged: callback => {
            changed = callback

            return () => {
              changed = undefined
            }
          }
        }
      } as typeof window.hermesDesktop
      navigation.setConnectionShownInSessions('work', false)
      // The removal notification arrives before the coalesced replacement read.
      window.hermesDesktop!.connections!.list = async () => registry
      view = renderHook(useConnectionsRegistry)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['local', 'homelab'])
      window.hermesDesktop!.connections!.list = async () => latest
      await act(async () => {
        changed!({ connectionId: 'work', incarnation: registry.connections[2].incarnation, reason: 'removed' })
        await Promise.resolve()
      })
      expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual([
        'local',
        'homelab',
        'work'
      ])
    } finally {
      view?.unmount()
      window.hermesDesktop = originalBridge
      $desktopBoot.set(originalBoot)
    }
  })

  it.each(['hide/hide', 'restore/hide'])(
    'preserves independent cross-window edits before delayed storage events: %s',
    async variant => {
      if (variant === 'restore/hide') {
        await load(JSON.stringify(['local']))
      }

      const first = navigation
      const firstSession = session
      await load()
      const second = navigation
      const firstActive = firstSession.$connection.get()
      const secondActive = session.$connection.get()
      first.setConnectionShownInSessions('local', variant === 'restore/hide')
      second.setConnectionShownInSessions('work', false)
      // Deliver notifications only after both windows completed independent edits.
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
      const expected = variant === 'restore/hide' ? ['local', 'homelab'] : ['homelab']
      expect(first.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(expected)
      expect(second.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(expected)
      expect(firstSession.$connection.get()).toBe(firstActive)
      expect(session.$connection.get()).toBe(secondActive)
    }
  )

  it('defaults to the complete registry without changing raw multiple-source semantics', () => {
    expect(navigation.$sessionNavigationConnections.get()).toEqual(registry.connections)
    expect(navigation.$hasMultipleSessionNavigationConnections.get()).toBe(true)
    expect(localStorage.getItem(KEY)).toBeNull()
    const active = session.$connection.get()
    navigation.setConnectionShownInSessions('local', false)
    navigation.setConnectionShownInSessions('work', false)
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['homelab'])
    expect(navigation.$hasMultipleSessionNavigationConnections.get()).toBe(false)
    expect(connections.$hasMultipleConnections.get()).toBe(true)
    expect(connections.$connectionsRegistry.get()).toBe(registry)
    expect(session.$connection.get()).toBe(active)
  })

  it('persists stable IDs across restart and label/endpoint changes', async () => {
    navigation.setConnectionShownInSessions('local', false)
    navigation.setConnectionShownInSessions('work', false)
    await load()
    connections.setConnectionsRegistry({
      ...registry,
      connections: registry.connections.map(entry => ({
        ...entry,
        label: `Renamed ${entry.label}`,
        url: 'https://new.invalid'
      }))
    })
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['homelab'])
    navigation.setConnectionShownInSessions('work', true)
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['homelab', 'work'])
    expect(navigation.$hiddenSessionConnectionIds.get()).toEqual(['local'])
    expect(localStorage.getItem(preferenceKey('local'))).toBe('true')
  })

  it('always reveals the execution source without clearing its hidden preference', async () => {
    await load(JSON.stringify(['local', 'homelab']))
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['homelab', 'work'])
    navigation.setConnectionShownInSessions('homelab', false)
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['homelab', 'work'])
    session.$connection.set(descriptor('local')) // Another window / explicit route activates it.
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['local', 'work'])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['local', 'homelab'])
  })

  it('keeps the last navigation choice in legacy startup states', async () => {
    await load(JSON.stringify(['local']))
    session.$connection.set(descriptor())
    connections.setConnectionsRegistry({ ...registry, connections: [registry.connections[0]], primary: 'local' })
    expect(navigation.$sessionNavigationConnections.get()).toEqual([registry.connections[0]])
    navigation.setConnectionShownInSessions('local', false)
    expect(navigation.$sessionNavigationConnections.get()).toEqual([registry.connections[0]])
    expect(navigation.$hasMultipleSessionNavigationConnections.get()).toBe(false)
    expect(connections.$activeConnectionId.get()).toBeNull()
  })

  it('retires removed preferences across windows before recreating a label-derived ID', async () => {
    // Keep the Node-only registry implementation outside renderer compilation;
    // Vitest still imports and exercises the actual normalizer at runtime.
    const { normalizeConnectionInput } = await import(String('../../electron/connection-registry'))

    const base = {
      version: 2 as const,
      primary: 'local',
      lastUsed: 'local',
      launchMode: 'primary' as const,
      connections: [{ id: 'local', kind: 'local' as const, label: 'This device' }]
    }

    const old = normalizeConnectionInput({ kind: 'remote', label: 'Work', url: 'https://old.synthetic.invalid' }, base)

    const replacement = normalizeConnectionInput(
      { kind: 'remote', label: 'Work', url: 'https://new.synthetic.invalid' },
      base
    )

    expect(replacement.id).toBe(old.id)

    const registered = {
      ...registry,
      primary: 'local',
      connections: [
        registry.connections[0],
        { ...registry.connections[2], id: old.id, incarnation: old.incarnation, url: old.url }
      ]
    }

    session.$connection.set(descriptor('local'))
    connections.setConnectionsRegistry(registered)
    navigation.setConnectionShownInSessions(old.id, false)
    const first = navigation
    const firstConnections = connections
    await load()
    session.$connection.set(descriptor('local'))
    connections.setConnectionsRegistry(registered)
    firstConnections.setConnectionsRegistry({ ...registered, connections: [registry.connections[0]] })
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    // A stale window still observing the old incarnation stays hidden; it writes nothing.
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['local'])

    const recreated = {
      ...registered,
      connections: [
        registry.connections[0],
        { ...registered.connections[1], incarnation: replacement.incarnation, url: replacement.url }
      ]
    }

    firstConnections.setConnectionsRegistry(recreated)
    connections.setConnectionsRegistry({ ...registered, connections: [registry.connections[0]] })
    connections.setConnectionsRegistry(recreated)
    expect(first.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['local', replacement.id])
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['local', replacement.id])
  })

  it('adopts another desktop window’s visibility changes without switching execution sources', () => {
    const active = session.$connection.get()
    localStorage.setItem(preferenceKey('local'), 'true')
    localStorage.setItem(preferenceKey('homelab'), 'true')
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: localStorage.getItem(KEY) }))
    expect(navigation.$sessionNavigationConnections.get().map(entry => entry.id)).toEqual(['homelab', 'work'])
    expect(session.$connection.get()).toBe(active)
    localStorage.removeItem(preferenceKey('local'))
    localStorage.removeItem(preferenceKey('homelab'))
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }))
    expect(navigation.$sessionNavigationConnections.get()).toEqual(registry.connections)
  })

  it.each(['broken JSON', '{}', 'null', '[false, 1, "", "missing"]'])(
    'ignores malformed or stale preferences: %s',
    async raw => {
      await load(raw)
      expect(navigation.$sessionNavigationConnections.get()).toEqual(registry.connections)
      expect(localStorage.getItem(KEY)).toBe(raw) // Reads never overwrite a stored preference.
      navigation.setConnectionShownInSessions('missing', false)
      expect(localStorage.getItem(KEY)).toBe(raw)
    }
  )
})
