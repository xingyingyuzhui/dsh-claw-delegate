import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPreset, intersectPolicies } from 'dsh-claw-permissions/schema'
import { rolePolicyOf } from '../delegate-role.mjs'
import {
  attenuateChildPolicy,
  childNeedsWorktree,
  childPolicyOf,
  denyPartialFileAction,
  isFileAction,
  requiresFullEnforcement,
} from '../delegate-policy.mjs'

test('child policy is parent ∩ child, tighter wins', () => {
  const parent = applyPreset('developer')
  const requested = applyPreset('research')
  const child = childPolicyOf(parent, requested)
  assert.equal(child.files.write, 'none')
  assert.equal(child.shell, 'deny')
  assert.equal(child.delegation.maxDepth, 1)
  assert.equal(isFileAction('write'), true)
  assert.equal(isFileAction('subagent'), false)
})

test('write-all child is attenuated to workspace so it cannot write the parent root', () => {
  const parent = applyPreset('full')
  const child = attenuateChildPolicy(parent, parent)
  assert.equal(parent.files.write, 'all')
  assert.equal(child.files.write, 'workspace')
  assert.equal(childNeedsWorktree(child), true)
  assert.equal(childNeedsWorktree(applyPreset('research')), false)
})

test('intersected research child still requires full enforcement via role', () => {
  const child = attenuateChildPolicy(applyPreset('developer'), rolePolicyOf('research'))
  assert.equal(child.preset, 'developer')
  assert.equal(child.files.write, 'none')
  assert.equal(requiresFullEnforcement(child), false)
  assert.equal(requiresFullEnforcement(child, 'research'), true)
  assert.match(
    denyPartialFileAction(child, { kind: 'ok', enforcement: 'partial' }, 'read', {}, 'research'),
    /partial/,
  )
})

test('research / reviewer / public require full sandbox enforcement', () => {
  assert.equal(requiresFullEnforcement(applyPreset('research')), true)
  assert.equal(requiresFullEnforcement(applyPreset('reviewer')), true)
  assert.equal(requiresFullEnforcement(applyPreset('public')), true)
  assert.equal(requiresFullEnforcement(applyPreset('developer')), false)
  assert.equal(requiresFullEnforcement({
    ...applyPreset('developer'),
    sandbox: { requireEnforcement: 'full' },
  }), true)
})

test('partial enforcement denies file actions for isolation roles and does not degrade', () => {
  const research = applyPreset('research')
  assert.match(
    denyPartialFileAction(research, { kind: 'ok', enforcement: 'partial' }, 'read', {}),
    /partial/,
  )
  assert.equal(
    denyPartialFileAction(research, { kind: 'ok', enforcement: 'full' }, 'read', {}),
    undefined,
  )
  assert.equal(
    denyPartialFileAction(applyPreset('developer'), { kind: 'ok', enforcement: 'partial' }, 'write', {}),
    undefined,
  )
  assert.equal(
    denyPartialFileAction(research, { kind: 'unknown' }, 'read', {}),
    undefined,
  )
  assert.equal(
    denyPartialFileAction(research, { kind: 'ok', enforcement: 'partial' }, 'subagent', {}),
    undefined,
  )
})

test('intersected child cannot exceed parent maxDepth', () => {
  const parent = { ...applyPreset('developer'), delegation: { maxDepth: 1 } }
  const requested = { ...applyPreset('developer'), delegation: { maxDepth: 8 } }
  const child = intersectPolicies(parent, requested)
  assert.equal(child.delegation.maxDepth, 1)
})
