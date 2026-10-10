import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyPreset } from 'dsh-claw-permissions/schema'
import { loadChildSync, removeChildSync, saveChildSync } from '../delegate-store.mjs'

test('child records accept official UUID session ids', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-store-'))
  const sessionId = '8f14e45f-ceea-467c-819b-748b1c2f8e9d'
  const saved = saveChildSync(home, {
    sessionId,
    parentSession: 'session-parent',
    policy: applyPreset('developer'),
    worktree: '/tmp/wt',
  })
  assert.equal(saved.sessionId, sessionId)
  assert.equal(saved.policy.files.write, 'workspace')
  const loaded = loadChildSync(home, sessionId)
  assert.equal(loaded.parentSession, 'session-parent')
  assert.equal(loaded.worktree, '/tmp/wt')
  removeChildSync(home, sessionId)
  assert.equal(loadChildSync(home, sessionId), null)
})
