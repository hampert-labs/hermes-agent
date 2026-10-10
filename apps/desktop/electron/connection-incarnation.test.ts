import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import * as registryModule from './connection-registry'
import { normalizeConnectionInput, normalizeRegistry, removeConnection, upsertConnection } from './connection-registry'
import { writeSecretFileAtomic } from './hardening'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('disposable native registry migration is atomic, stable and idempotent across restart', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'incarnation-'))
  const file = path.join(dir, 'connections.json')
  const legacy = {
    version: 2,
    primary: 'work',
    lastUsed: 'work',
    launchMode: 'last-used',
    connections: [
      { id: 'local', kind: 'local', label: 'This device' },
      {
        id: 'work',
        kind: 'remote',
        label: 'Work',
        url: 'https://synthetic.invalid',
        authMode: 'token',
        token: { encoding: 'plain', value: 'synthetic-token' },
        headers: { 'CF-Access-Client-Secret': { encoding: 'plain', value: 'synthetic-header' } },
        incarnation: { malformed: true }
      }
    ]
  }
  try {
    writeSecretFileAtomic(file, JSON.stringify(legacy))
    let writes = 0
    const persist = (value: unknown) => {
      writes++
      writeSecretFileAtomic(file, JSON.stringify(value))
    }
    const read = () =>
      registryModule.migrateRegistryIncarnations(normalizeRegistry(JSON.parse(fs.readFileSync(file, 'utf8'))), persist)
    const migrated = read()
    assert.equal(writes, 1)
    migrated.connections.forEach(c => assert.match(c.incarnation ?? '', UUID))
    const { incarnation: _ignored, ...work } = migrated.connections[1]
    const { incarnation: _malformed, ...originalWork } = legacy.connections[1]
    assert.deepEqual(work, originalWork)
    assert.equal(migrated.primary, legacy.primary)
    assert.equal(migrated.lastUsed, legacy.lastUsed)
    assert.equal(migrated.launchMode, legacy.launchMode)
    assert.deepEqual(read(), migrated)
    assert.equal(writes, 1)
    assert.deepEqual(fs.readdirSync(dir), ['connections.json'])
    const originalBytes = fs.readFileSync(file, 'utf8')
    assert.throws(
      () =>
        registryModule.migrateRegistryIncarnations(normalizeRegistry(legacy), () => {
          throw new Error('disk unavailable')
        }),
      /disk unavailable/
    )
    assert.equal(fs.readFileSync(file, 'utf8'), originalBytes)
    assert.deepEqual(normalizeRegistry(migrated), migrated)
    const removed = removeConnection(migrated, 'work')
    persist(removed)
    const recreated = normalizeConnectionInput(
      { kind: 'remote', label: 'Work', url: 'https://synthetic.invalid', authMode: 'oauth' },
      read()
    )
    persist(upsertConnection(read(), recreated))
    assert.equal(recreated.id, 'work')
    assert.notEqual(recreated.incarnation, migrated.connections[1].incarnation)
    assert.equal(read().connections[1].incarnation, recreated.incarnation)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('native save owns immutable incarnation, preserving edits but not same-ID recreation', () => {
  const base = normalizeRegistry(null)
  const input = { kind: 'remote' as const, label: 'Work', url: 'https://synthetic.invalid', authMode: 'oauth' }
  const original = normalizeConnectionInput({ ...input, incarnation: 'caller-controlled' } as typeof input, base)
  assert.match(original.incarnation ?? '', UUID)
  const registered = upsertConnection(base, original)
  const edited = normalizeConnectionInput(
    {
      ...input,
      id: original.id,
      label: 'Renamed',
      url: 'https://changed.synthetic.invalid',
      incarnation: 'forged'
    } as typeof input,
    registered
  )
  assert.equal(edited.incarnation, original.incarnation)
  assert.equal(
    normalizeRegistry(registered).connections.find(c => c.id === original.id)?.incarnation,
    original.incarnation
  )
  const replacement = normalizeConnectionInput(input, removeConnection(registered, original.id))
  assert.equal(replacement.id, original.id)
  assert.notEqual(replacement.incarnation, original.incarnation)
  assert.match(replacement.incarnation ?? '', UUID)
})
