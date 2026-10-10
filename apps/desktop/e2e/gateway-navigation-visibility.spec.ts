import fs from 'node:fs'
import path from 'node:path'

import { buildAppEnv, createSandbox, launchDesktop, type Sandbox } from './fixtures'
import { allowErrorBanners, collectErrorBanners, type ElectronApplication, expect, type Page, test } from './test'

// Real Electron, preload, registry file, renderer and Chromium persistence.
// Only backend boundaries are synthetic: no Python runtime, production gateway,
// user credentials, or backend processes are used by this presentation test.
const KEY = 'hermes.desktop.sessions.hiddenConnectionIncarnations'
const BOOT_ERROR = 'Visibility fixture: backend deliberately not started'

const profiles = [
  { name: 'default', is_default: true },
  { name: 'scout', is_default: false }
]

const descriptor = {
  connectionId: 'homelab',
  profile: 'default',
  mode: 'remote',
  baseUrl: 'http://127.0.0.1:1',
  wsUrl: 'ws://127.0.0.1:1/api/ws',
  token: 'synthetic-visibility-token',
  isFullscreen: false,
  logs: [],
  nativeOverlayWidth: 0,
  windowButtonPosition: null
}

interface DesktopWindow extends Window {
  hermesDesktop: {
    getBootProgress: () => Promise<{ error?: string }>
    getConnection: () => Promise<typeof descriptor>
    connections: {
      list: () => Promise<{ primary: string; connections: Array<{ id: string; incarnation?: string; token?: unknown; label: string }> }>
      save: (input: Record<string, unknown>) => Promise<unknown>
      remove: (id: string) => Promise<unknown>
    }
    profile: {
      get: () => Promise<unknown>
      getDefault: () => Promise<unknown>
      remember: (name: string) => Promise<unknown>
    }
  }
}

interface FixtureState {
  requests: Array<{ channel: string; route: unknown }>
  activeRoute: { connectionId: string; profile: string }
  transitions: unknown[]
}

async function fixtureState(app: ElectronApplication): Promise<FixtureState> {
  return app.evaluate(() => (globalThis as unknown as { visibilityFixture: FixtureState }).visibilityFixture)
}

async function launchFixture(
  sandbox: Sandbox,
  errors: string[]
): Promise<{ app: ElectronApplication; page: Page; forbiddenRpc: unknown[] }> {
  const { app, page } = await launchDesktop(
    buildAppEnv(sandbox, {
      HERMES_DESKTOP_APP_NAME: 'HermesE2EGatewayVisibility',
      HERMES_DESKTOP_BOOT_FAKE_ERROR: BOOT_ERROR,
      HERMES_DESKTOP_DEV_SERVER: ''
    })
  )

  page.on('pageerror', error => errors.push(error.stack ?? error.message))

  // Let the deliberate boot failure settle before replacing its external
  // boundaries. The genuine registry read/write handlers are never replaced.
  await page.waitForFunction(async () =>
    Boolean((await (window as unknown as DesktopWindow).hermesDesktop.getBootProgress()).error)
  )
  await app.evaluate(
    ({ ipcMain }, fixture) => {
      const state: FixtureState = {
        requests: [],
        activeRoute: { connectionId: fixture.descriptor.connectionId, profile: fixture.descriptor.profile },
        transitions: []
      }

      ;(globalThis as unknown as { visibilityFixture: FixtureState }).visibilityFixture = state
      const record = (channel: string, route: unknown) => state.requests.push({ channel, route })
      ipcMain.removeAllListeners('hermes:connection:active-route')
      ipcMain.on('hermes:connection:active-route', (_event: unknown, route: FixtureState['activeRoute']) => {
        state.transitions.push(route)
        state.activeRoute = route
      })

      const replace = (channel: string, handler: (...args: any[]) => unknown) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }

      replace('hermes:connection', (_event, profile) => {
        record('hermes:connection', profile ?? null)

        return { ...fixture.descriptor, ...state.activeRoute }
      })
      replace('hermes:connection:for', (_event, route) => {
        record('hermes:connection:for', route)

        if (route.connectionId === 'local') {
          throw new Error('Visibility must not activate the local backend')
        }

        return { ...fixture.descriptor, ...route }
      })

      for (const channel of ['hermes:gateway:ws-url', 'hermes:gateway:ws-url-for']) {
        replace(channel, (_event, route) => {
          record(channel, route ?? null)

          return fixture.descriptor.wsUrl
        })
      }

      for (const channel of [
        'hermes:connection:revalidate',
        'hermes:connection-config:apply',
        'hermes:backend:touch'
      ]) {
        replace(channel, (_event, route) => {
          record(channel, route ?? null)
          throw new Error(`Visibility fixture: unexpected backend-changing request ${channel}`)
        })
      }

      replace('hermes:boot-progress:get', () => ({ running: false, progress: 100, error: null }))
      replace('hermes:agents:roster', () => ({
        sources: [
          { connectionId: 'local', kind: 'local', label: 'This device', reachable: true },
          { connectionId: 'homelab', kind: 'remote', label: 'Homelab', reachable: true },
          { connectionId: 'offline', kind: 'ssh', label: 'Offline', reachable: false }
        ],
        agents: [
          {
            connectionId: 'local',
            connectionKind: 'local',
            connectionLabel: 'This device',
            profile: 'builder',
            handle: 'builder-local'
          },
          {
            connectionId: 'homelab',
            connectionKind: 'remote',
            connectionLabel: 'Homelab',
            profile: 'scout',
            handle: 'scout-homelab'
          }
        ]
      }))
      replace('hermes:api', (_event, request) => {
        if (request.method && request.method !== 'GET') {
          record('hermes:api', { method: request.method, path: request.path })
        }

        switch (request.path.split('?')[0]) {
          case '/api/profiles/active':
            return { current: 'default', active: 'default' }

          case '/api/profiles':
            return { profiles: fixture.profiles }

          case '/api/config':
            return { model: { default: 'synthetic-model', provider: 'custom' }, display: {} }

          case '/api/sessions':
            return { sessions: [], has_more: false }

          case '/api/tools/terminal/backends':
            return { backends: [] }

          case '/api/status':
            return { gateway_platforms: {}, gateway_running: false, version: 'fixture', hermes_home: '/synthetic' }

          default:
            return {}
        }
      })
    },
    { descriptor, profiles }
  )

  // Runner-owned records survive renderer rejection/catch paths.
  const forbiddenRpc: unknown[] = []
  await page.routeWebSocket('ws://127.0.0.1:1/**', socket => {
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw))

      const results: Record<string, unknown> = {
        'session.list': { sessions: [], has_more: false },
        'session.active_list': { sessions: [] },
        'profiles.list': { profiles },
        'setup.status': { provider_configured: true },
        'setup.runtime_check': { ok: true, model: 'synthetic-model', provider: 'custom' },
        'free_tier.status': { has_guest: false, enabled: false, notice_pending: false },
        'model.options': { providers: [], model: 'synthetic-model', provider: 'custom' },
        'pet.info': {},
        'commands.catalog': { commands: [] },
        'subscription.state': {}
      }

      // These are the explicitly allowed read/setup methods. Everything else
      // is forbidden during presentation changes, including unknown methods.
      if (!Object.hasOwn(results, request.method)) {
        forbiddenRpc.push({ method: request.method, params: request.params ?? null })
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Forbidden visibility RPC' }
          })
        )

        return
      }
      const result = results[request.method]
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  await page.setViewportSize({ width: 1220, height: 800 })
  await page.reload()
  await expect(page.locator('[data-slot~="profile-rail"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'scout', exact: true })).toBeVisible()

  return { app, page, forbiddenRpc }
}

const settings = async (page: Page) => {
  await page.evaluate(() => {
    location.hash = '#/settings?tab=gateway&page=devices'
  })
  await expect(page.getByRole('switch', { name: 'Show in Sessions navigation: This device' })).toBeVisible()
}

const sessions = async (page: Page) => {
  await page.evaluate(() => {
    location.hash = '#/'
  })
  await expect(page.locator('[data-slot~="profile-rail"]')).toBeVisible()
}

async function guardNativeProfiles(app: ElectronApplication): Promise<void> {
  // Install only after normal startup initialization has settled. Preserve the
  // genuine read handlers; prevent a hard re-home in the sandbox while recording
  // every attempted mutation outside the renderer's catches.
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ['hermes:profile:remember', 'hermes:profile:default:set', 'hermes:profile:set']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event: unknown, route: unknown) => {
        const state = (globalThis as unknown as { visibilityFixture: FixtureState }).visibilityFixture
        state.requests.push({ channel, route })
        throw new Error(`Forbidden visibility native profile request: ${channel}`)
      })
    }
  })
}

async function startupState(page: Page, sandbox: Sandbox) {
  const file = path.join(sandbox.userDataDir, 'active-profile.json')

  return {
    native: await page.evaluate(async () => {
      const profile = (window as unknown as DesktopWindow).hermesDesktop.profile

      return { active: await profile.get(), default: await profile.getDefault() }
    }),
    file: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  }
}

const controls = [
  { phase: null, method: null },
  ...(['hide', 'restore'] as const).flatMap(phase =>
    ['session.create', 'prompt.submit', 'profile.remember'].map(method => ({ phase, method }))
  )
]

for (const control of controls) {
  test(`gateway visibility restart invariants${control.phase ? `: caught ${control.method} during ${control.phase}` : ''}`, async () => {
    // The initial boot failure is deliberate; later alerts are checked explicitly.
    allowErrorBanners()
    const sandbox = createSandbox('gateway-visibility')
    const file = path.join(sandbox.userDataDir, 'connections.json')

    const registry = {
      version: 2,
      primary: 'homelab',
      launchMode: 'primary',
      lastUsed: 'homelab',
      connections: [
        { id: 'local', kind: 'local', label: 'This device' },
        {
          id: 'homelab',
          kind: 'remote',
          label: 'Homelab',
          url: descriptor.baseUrl,
          authMode: 'token',
          token: { encoding: 'plain', value: descriptor.token }
        },
        { id: 'offline', kind: 'ssh', label: 'Offline', host: 'synthetic.invalid' }
      ]
    }

    fs.writeFileSync(file, JSON.stringify(registry, null, 2), { mode: 0o600 })
    let app: ElectronApplication | undefined
    const errors: string[] = []

    try {
      let launched = await launchFixture(sandbox, errors)
      app = launched.app
      let page = launched.page
      const persistedRegistry = JSON.parse(fs.readFileSync(file, 'utf8'))
      expect(
        persistedRegistry.connections.map(({ incarnation: _identity, ...entry }: { incarnation?: string }) => entry)
      ).toEqual(registry.connections)
      for (const entry of persistedRegistry.connections) {
        expect(entry.incarnation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      }
      const nativeRead = await page.evaluate(() =>
        (window as unknown as DesktopWindow).hermesDesktop.connections.list()
      )
      expect(nativeRead.connections.map(c => c.incarnation)).toEqual(
        persistedRegistry.connections.map((c: { incarnation: string }) => c.incarnation)
      )
      expect(nativeRead.connections.every(c => !Object.hasOwn(c, 'token'))).toBe(true)

      await expect(page.getByRole('button', { name: 'builder · This device', exact: true })).toBeVisible()
      await settings(page)
      await guardNativeProfiles(app)
      const beforeHide = await fixtureState(app)
      const startupBeforeHide = await startupState(page, sandbox)
      const rpcBeforeHide = [...launched.forbiddenRpc]
      await expect(page.getByRole('switch', { name: 'Show in Sessions navigation: Homelab' })).toBeDisabled()
      await page.getByRole('switch', { name: 'Show in Sessions navigation: This device' }).click()
      await page.getByRole('switch', { name: 'Show in Sessions navigation: Offline' }).click()
      await expect(page.getByText('Hidden from Sessions navigation', { exact: true })).toHaveCount(2)
      await page.screenshot({ path: test.info().outputPath('settings-hidden.png') })
      await sessions(page)
      await expect(page.getByRole('button', { name: 'builder · This device', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Registered gateways:/ })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'scout', exact: true })).toBeVisible()
      expect(
        await page.evaluate(async key => {
          const { connections } = await (window as unknown as DesktopWindow).hermesDesktop.connections.list()
          return connections
            .filter(
              c =>
                ['local', 'offline'].includes(c.id) &&
                localStorage.getItem(`${key}.${encodeURIComponent(c.id)}.${c.incarnation}`) === 'true'
            )
            .map(c => c.id)
        }, KEY)
      ).toEqual(['local', 'offline'])
      // Main-process records cannot be hidden by renderer catch paths.
      const assertHide = async () => {
        expect(launched.forbiddenRpc, 'forbidden RPC delta during hide').toEqual(rpcBeforeHide)
        expect(await fixtureState(app!), 'native execution/profile delta during hide').toEqual(beforeHide)
        expect(await startupState(page, sandbox), 'startup preference delta during hide').toEqual(startupBeforeHide)
      }
      if (control.phase === 'hide') {
        await assertHide() // A negative control must start from a clean invariant.
        await sabotage(page, control.method!)
        await expect(assertHide()).rejects.toThrow(
          control.method === 'profile.remember'
            ? 'native execution/profile delta during hide'
            : 'forbidden RPC delta during hide'
        )

        return
      }
      await assertHide()
      expect(beforeHide.activeRoute).toEqual({ connectionId: 'homelab', profile: 'default', registryScoped: false })
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(persistedRegistry)
      await page.screenshot({ path: test.info().outputPath('sessions-hidden.png') })
      expect(errors).toEqual([])
      expect((await collectErrorBanners(page)).filter(error => !error.includes(BOOT_ERROR))).toEqual([])
      await app.close()
      app = undefined

      launched = await launchFixture(sandbox, errors)
      app = launched.app
      page = launched.page

      await settings(page)
      await guardNativeProfiles(app)
      const beforeRestore = await fixtureState(app)
      const startupBeforeRestore = await startupState(page, sandbox)
      expect(startupBeforeRestore, 'startup preference persisted across restart').toEqual(startupBeforeHide)
      const rpcBeforeRestore = [...launched.forbiddenRpc]
      const local = page.getByRole('switch', { name: 'Show in Sessions navigation: This device' })
      const offline = page.getByRole('switch', { name: 'Show in Sessions navigation: Offline' })
      await expect(local).not.toBeChecked()
      await expect(offline).not.toBeChecked()
      await expect(offline).toBeEnabled()
      await offline.click() // Recovery does not need a reachable gateway.
      await local.click()
      await sessions(page)
      await expect(page.getByRole('button', { name: 'builder · This device', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Registered gateways: Homelab' })).toBeVisible()
      expect(
        await page.evaluate(async key => {
          const { connections } = await (window as unknown as DesktopWindow).hermesDesktop.connections.list()
          return connections
            .filter(
              c =>
                ['local', 'offline'].includes(c.id) &&
                localStorage.getItem(`${key}.${encodeURIComponent(c.id)}.${c.incarnation}`) === 'true'
            )
            .map(c => c.id)
        }, KEY)
      ).toEqual([])
      const assertRestore = async () => {
        expect(launched.forbiddenRpc, 'forbidden RPC delta during restore').toEqual(rpcBeforeRestore)
        expect(await fixtureState(app!), 'native execution/profile delta during restore').toEqual(beforeRestore)
        expect(await startupState(page, sandbox), 'startup preference delta during restore').toEqual(
          startupBeforeRestore
        )
      }
      if (control.phase === 'restore') {
        await assertRestore()
        await sabotage(page, control.method!)
        await expect(assertRestore()).rejects.toThrow(
          control.method === 'profile.remember'
            ? 'native execution/profile delta during restore'
            : 'forbidden RPC delta during restore'
        )

        return
      }
      await assertRestore()
      expect(beforeRestore.activeRoute).toEqual({ connectionId: 'homelab', profile: 'default', registryScoped: false })
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(persistedRegistry)
      expect(errors).toEqual([])
      expect((await collectErrorBanners(page)).filter(error => !error.includes(BOOT_ERROR))).toEqual([])
      await page.screenshot({ path: test.info().outputPath('sessions-recovered.png') })
    } finally {
      try {
        await app?.close()
      } finally {
        sandbox.cleanup()
      }
    }
  })
}

test('native incarnation survives edits/restart and replacement hides survive obsolete removal pushes', async () => {
  allowErrorBanners()
  const sandbox = createSandbox('gateway-incarnation')
  const file = path.join(sandbox.userDataDir, 'connections.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      primary: 'homelab',
      lastUsed: 'homelab',
      launchMode: 'primary',
      connections: [
        { id: 'local', kind: 'local', label: 'This device' },
        {
          id: 'homelab',
          kind: 'remote',
          label: 'Homelab',
          url: descriptor.baseUrl,
          authMode: 'token',
          token: { encoding: 'plain', value: descriptor.token }
        },
        { id: 'offline', kind: 'ssh', label: 'Offline', host: 'synthetic.invalid' }
      ]
    }),
    { mode: 0o600 }
  )
  let app: ElectronApplication | undefined
  const errors: string[] = []
  try {
    let launched = await launchFixture(sandbox, errors)
    app = launched.app
    let page = launched.page
    const initial = JSON.parse(fs.readFileSync(file, 'utf8'))
    const oldIdentity = initial.connections.find((c: { id: string }) => c.id === 'offline').incarnation
    expect(oldIdentity).toMatch(/^[0-9a-f-]{36}$/)
    await settings(page)
    await page.getByRole('switch', { name: 'Show in Sessions navigation: Offline' }).click()
    // Genuine native save; only backend descriptor/roster/transport boundaries are synthetic.
    await page.evaluate(() =>
      (window as unknown as DesktopWindow).hermesDesktop.connections.save({
        id: 'offline',
        kind: 'ssh',
        label: 'Renamed Offline',
        host: 'edited.synthetic.invalid',
        incarnation: 'caller-forged'
      })
    )
    // Direct preload writes bypass Settings' own save/publish callback; remount
    // the section to read the genuine native snapshot, as reopening Settings does.
    await sessions(page)
    await settings(page)
    await expect(page.getByRole('switch', { name: 'Show in Sessions navigation: Renamed Offline' })).not.toBeChecked()
    const edited = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(edited.connections.find((c: { id: string }) => c.id === 'offline').incarnation).toBe(oldIdentity)
    await app.close()
    app = undefined
    launched = await launchFixture(sandbox, errors)
    app = launched.app
    page = launched.page
    await settings(page)
    await expect(page.getByRole('switch', { name: 'Show in Sessions navigation: Renamed Offline' })).not.toBeChecked()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(edited)
    await page.evaluate(async () => {
      const connections = (window as unknown as DesktopWindow).hermesDesktop.connections
      await connections.remove('offline')
      await connections.save({
        kind: 'ssh',
        label: 'Offline',
        host: 'replacement.synthetic.invalid',
        incarnation: 'caller-forged'
      })
    })
    await sessions(page)
    await settings(page)
    const recreated = JSON.parse(fs.readFileSync(file, 'utf8'))
    const newIdentity = recreated.connections.find((c: { id: string }) => c.id === 'offline').incarnation
    expect(newIdentity).not.toBe(oldIdentity)
    expect(newIdentity).toMatch(/^[0-9a-f-]{36}$/)
    const toggle = page.getByRole('switch', { name: 'Show in Sessions navigation: Offline' })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    // Synthetic delayed lifecycle delivery, not a claim about backend teardown timing.
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('hermes:connections:changed', { connectionId: 'offline', reason: 'removed' })
      }
    })
    await page.evaluate(() => (window as unknown as DesktopWindow).hermesDesktop.connections.list())
    await expect(toggle).not.toBeChecked()
    expect(
      await page.evaluate(({ key, incarnation }) => localStorage.getItem(`${key}.offline.${incarnation}`), {
        key: KEY,
        incarnation: newIdentity
      })
    ).toBe('true')
    await app.close()
    app = undefined
    launched = await launchFixture(sandbox, errors)
    app = launched.app
    page = launched.page
    await settings(page)
    await expect(page.getByRole('switch', { name: 'Show in Sessions navigation: Offline' })).not.toBeChecked()
    const readback = await page.evaluate(() => (window as unknown as DesktopWindow).hermesDesktop.connections.list())
    expect(readback.connections.find(c => c.id === 'offline')?.incarnation).toBe(newIdentity)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(recreated)
    expect(errors).toEqual([])
  } finally {
    try {
      await app?.close()
    } finally {
      sandbox.cleanup()
    }
  }
})

test('readable legacy registry survives optional identity write failure and retries', async () => {
  allowErrorBanners()
  const sandbox = createSandbox('identity-recovery')
  const file = path.join(sandbox.userDataDir, 'connections.json')
  const registry = {
    version: 2, primary: 'homelab', lastUsed: 'homelab', launchMode: 'last-used',
    connections: [
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'Homelab', url: descriptor.baseUrl,
        authMode: 'token', token: { encoding: 'plain', value: descriptor.token } }
    ]
  }
  const bytes = JSON.stringify(registry)
  fs.writeFileSync(file, JSON.stringify({ ...registry, connections: registry.connections.map((c, i) => ({
    ...c, incarnation: `00000000-0000-4000-8000-00000000000${i + 1}`
  })) }), { mode: 0o600 })
  let app: ElectronApplication | undefined
  try {
    const launched = await launchDesktop(buildAppEnv(sandbox, {
      HERMES_DESKTOP_APP_NAME: 'HermesE2EGatewayVisibility',
      HERMES_DESKTOP_BOOT_FAKE_ERROR: BOOT_ERROR, HERMES_DESKTOP_DEV_SERVER: ''
    }))
    app = launched.app
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    fs.mkdirSync(`${file}.tmp`)
    const read = () => launched.page.evaluate(() =>
      (window as unknown as DesktopWindow).hermesDesktop.connections.list())
    const unavailable = await read()
    expect(unavailable).toMatchObject({ primary: 'homelab', lastUsed: 'homelab', launchMode: 'last-used' })
    expect(unavailable.connections.map(c => c.id)).toEqual(['local', 'homelab'])
    expect(unavailable.connections.every(c => !c.incarnation)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    fs.rmdirSync(`${file}.tmp`)
    const recovered = await read()
    expect(recovered.connections.every(c => /^[0-9a-f-]{36}$/.test(c.incarnation ?? ''))).toBe(true)
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(persisted.connections[1].token).toEqual(registry.connections[1].token)
    expect((await read()).connections).toEqual(recovered.connections)
  } finally {
    await app?.close()
    sandbox.cleanup()
  }
})

test('failed drift repair preserves routing fallback without exposing non-durable identities', async () => {
  allowErrorBanners()
  const sandbox = createSandbox('identity-drift')
  const file = path.join(sandbox.userDataDir, 'connections.json')
  const persisted = { version: 2, primary: 'local', lastUsed: 'local', launchMode: 'primary',
    connections: [{ id: 'local', kind: 'local', label: 'This device',
      incarnation: '00000000-0000-4000-8000-000000000001' }] }
  fs.writeFileSync(file, JSON.stringify(persisted), { mode: 0o600 })
  let app: ElectronApplication | undefined
  try {
    const launched = await launchDesktop(buildAppEnv(sandbox, {
      HERMES_DESKTOP_APP_NAME: 'HermesE2EGatewayVisibility',
      HERMES_DESKTOP_BOOT_FAKE_ERROR: BOOT_ERROR, HERMES_DESKTOP_DEV_SERVER: ''
    }))
    app = launched.app
    fs.writeFileSync(path.join(sandbox.userDataDir, 'connection.json'), JSON.stringify({
      mode: 'remote', remote: { url: 'https://drift.synthetic.invalid',
        token: { encoding: 'plain', value: 'synthetic-drift-token' } }
    }), { mode: 0o600 })
    fs.writeFileSync(file, JSON.stringify(persisted), { mode: 0o600 })
    fs.mkdirSync(`${file}.tmp`)
    const read = () => launched.page.evaluate(() =>
      (window as unknown as DesktopWindow).hermesDesktop.connections.list())
    const first = await read()
    expect(first).toMatchObject({ primary: 'drift-synthetic-invalid' })
    expect(first.connections.find(c => c.id === 'local')?.incarnation).toBe(persisted.connections[0].incarnation)
    expect(first.connections.find(c => c.id === first.primary)?.incarnation).toBeUndefined()
    expect(await read()).toEqual(first)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(persisted)
    fs.rmdirSync(`${file}.tmp`)
    const repaired = await read()
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(repaired.connections.map(c => c.incarnation)).toEqual(disk.connections.map((c: { incarnation: string }) => c.incarnation))
    expect(disk.connections[1].token.value).toBe('synthetic-drift-token')
  } finally {
    await app?.close()
    sandbox.cleanup()
  }
})

async function sabotage(page: Page, method: string): Promise<void> {
  await page.evaluate(async method => {
    if (method === 'profile.remember') {
      await (window as unknown as DesktopWindow).hermesDesktop.profile.remember('scout').catch(() => undefined)

      return
    }
    await new Promise<void>(resolve => {
      const socket = new WebSocket('ws://127.0.0.1:1/api/ws')
      socket.onopen = () =>
        socket.send(
          JSON.stringify({ jsonrpc: '2.0', id: 98765, method, params: { profile: 'default', source: 'desktop' } })
        )
      socket.onmessage = () => {
        socket.close()
        // Deliberately catch/ignore the application's rejected operation. The
        // external invariant must still fail for the recorded request.
        resolve()
      }
    })
  }, method)
}
