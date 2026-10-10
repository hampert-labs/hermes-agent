// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import type { DesktopConnectionsRegistry } from '@/global'
import { setConnectionShownInSessions } from '@/store/connection-navigation'
import { $profileRailVisible } from '@/store/profile-rail-prefs'

import { ProfileSwitcher } from './profile-dropdown-switcher'

// With the colored rail hidden, the statusbar's profile dropdown is the ONLY
// door to switching profiles — it must list every profile of the active
// gateway and select through the same store action the rail uses.

const selectProfile = vi.fn()
const setShowAllProfiles = vi.fn()

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      profiles: {
        allProfiles: 'All profiles',
        fleet: {
          onGateway: (name: string, gateway: string) => `${name} · ${gateway}`,
          gateway: (gateway: string) => `Profiles on ${gateway}`,
          gatewayUnreachable: (gateway: string) => `${gateway} · unreachable`,
          localDevice: 'This device'
        },
        importProfile: 'Import profile…',
        manageProfiles: 'Manage profiles…',
        newProfile: 'New profile',
        switchConnectionFailed: (name: string) => `Could not connect to ${name}`,
        title: 'Profiles'
      },
      settings: { toolsets: { needsSignIn: 'Needs sign-in' } }
    }
  })
}))

vi.mock('@/store/profile', () => ({
  $activeGatewayProfile: atom('default'),
  $profileColors: atom({}),
  $profileCreateRequest: atom(0),
  $profileOrder: atom([]),
  $profiles: atom([
    { is_default: true, name: 'default' },
    { is_default: false, name: 'clippy' }
  ]),
  $showAllProfiles: atom(false),
  ALL_PROFILES: '__all__',
  normalizeProfileKey: (name: string) => name,
  profileLabel: (profile: { name: string }) => profile.name,
  refreshActiveProfile: vi.fn().mockResolvedValue(undefined),
  selectProfile: (name: string) => selectProfile(name),
  setShowAllProfiles: (value: boolean) => setShowAllProfiles(value),
  sortByProfileOrder: (profiles: Array<{ name: string }>) => profiles
}))

vi.mock('@/store/connections', () => ({
  $activeConnectionId: atom<null | string>(null),
  $connectionsRegistry: atom<DesktopConnectionsRegistry | null>(null),
  $hasMultipleConnections: atom(false),
  selectConnection: vi.fn(async () => undefined)
}))

vi.mock('@/store/profile-share', () => ({ runImportProfileFlow: vi.fn() }))
vi.mock('./use-profile-prewarm', () => ({
  useProfilePrewarm: () => ({ cancelPrewarm: vi.fn(), startPrewarm: vi.fn() })
}))
vi.mock('./use-fleet-roster', () => ({ useFleetRoster: () => undefined }))
vi.mock('../../profiles/create-profile-dialog', () => ({ CreateProfileDialog: () => null }))

const connectionsStore = await import('@/store/connections')
const activeConnectionId = connectionsStore.$activeConnectionId as ReturnType<typeof atom<null | string>>
const { $fleetRoster } = await import('@/store/fleet-roster')

afterEach(() => {
  cleanup()
  setConnectionShownInSessions('local', true)
  setConnectionShownInSessions('gateway-b', true)
  connectionsStore.$connectionsRegistry.set(null)
  activeConnectionId.set(null)
  $fleetRoster.set(null)
  $profileRailVisible.set(true)
  vi.clearAllMocks()
})

it('excludes hidden gateway profiles from the replacement dropdown without losing exact remote ownership', async () => {
  connectionsStore.$connectionsRegistry.set({
    version: 2,
    secureTokenStorage: true,
    primary: 'gateway-a',
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
        id: 'gateway-a',
        incarnation: '00000000-0000-4000-8000-000000000002',
        kind: 'remote',
        label: 'Gateway A',
        tokenSet: false,
        tokenPreview: null
      },
      {
        id: 'gateway-b',
        incarnation: '00000000-0000-4000-8000-000000000003',
        kind: 'remote',
        label: 'Gateway B',
        tokenSet: false,
        tokenPreview: null
      }
    ]
  })
  const multiple = connectionsStore.$hasMultipleConnections as ReturnType<typeof atom<boolean>>
  multiple.set(true)
  activeConnectionId.set('gateway-a')
  $fleetRoster.set({
    sources: [
      { connectionId: 'local', kind: 'local', label: 'This device', reachable: true },
      { connectionId: 'gateway-b', kind: 'remote', label: 'Gateway B', reachable: true }
    ],
    agents: ['local', 'gateway-b'].map(connectionId => ({
      connectionId,
      connectionKind: connectionId === 'local' ? 'local' : 'remote',
      connectionLabel: connectionId === 'local' ? 'This device' : 'Gateway B',
      profile: 'builder',
      handle: `builder-${connectionId}`
    }))
  })
  setConnectionShownInSessions('local', false)
  render(<ProfileSwitcher compact />)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles: default' }), { button: 0, ctrlKey: false })
  expect(document.querySelector('[data-connection-id="local"]')).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'builder · This device' })).toBeNull()
  expect(screen.getByRole('menuitemradio', { name: 'clippy' })).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'builder · Gateway B' })))
  expect(connectionsStore.selectConnection).toHaveBeenCalledWith('gateway-b', { profile: 'builder' })
  expect(selectProfile).not.toHaveBeenCalled()
  multiple.set(false)
})

it('switches profiles from the statusbar dropdown while the rail is hidden', async () => {
  act(() => $profileRailVisible.set(false))
  render(<ProfileSwitcher compact />)

  const trigger = screen.getByRole('button', { name: 'Profiles: default' })
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await Promise.resolve()
  })

  const clippy = await screen.findByRole('menuitemradio', { name: /clippy/ })
  await act(async () => {
    fireEvent.click(clippy)
    await Promise.resolve()
  })

  expect(selectProfile).toHaveBeenCalledWith('clippy')
  expect(setShowAllProfiles).not.toHaveBeenCalled()
})
