import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyPreset } from 'dsh-claw-permissions/schema'
import { allowExecution } from 'dsh-claw-permissions/path'
import { attenuateChildPolicy, childNeedsWorktree } from '../delegate-policy.mjs'
import { createWriteWorktree, removeWriteWorktree } from '../delegate-worktree.mjs'
import { roleDenyReason } from '../delegate-role.mjs'

async function tempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acc-repo-'))
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  await writeFile(join(dir, 'SECRET.md'), 'parent-only\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

test('write child cannot write the parent workspace; it can write its worktree', async () => {
  const repo = await tempRepo()
  const home = await mkdtemp(join(tmpdir(), 'dsh-acc-home-'))
  const child = attenuateChildPolicy(applyPreset('full'), applyPreset('full'))
  assert.equal(child.files.write, 'workspace')
  assert.equal(childNeedsWorktree(child), true)
  const worktree = createWriteWorktree({ home, sessionId: 'child-acc-1', parentCwd: repo }).path
  assert.equal(allowExecution(child, 'write', { path: join(repo, 'SECRET.md') }, worktree), false)
  assert.equal(allowExecution(child, 'write', { path: join(worktree, 'out.md') }, worktree), true)
  removeWriteWorktree({ home, sessionId: 'child-acc-1', parentCwd: repo })
})

test('developer parent cannot spawn an unauthorized release child', () => {
  assert.match(roleDenyReason(applyPreset('developer'), 'release'), /allowlist/)
  assert.equal(roleDenyReason(applyPreset('developer'), 'research'), undefined)
})
