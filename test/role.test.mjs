import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPreset } from 'dsh-claw-permissions/schema'
import { attenuateChildPolicy } from '../delegate-policy.mjs'
import {
  allowedRolesOf,
  childRolesOf,
  parseRequestedRole,
  parseRoleRequest,
  roleDenyReason,
  rolePolicyOf,
} from '../delegate-role.mjs'

test('developer may send research/reviewer; empty-role presets may not name a role', () => {
  assert.deepEqual(allowedRolesOf(applyPreset('developer')), ['research', 'reviewer'])
  assert.deepEqual(allowedRolesOf(applyPreset('research')), [])
  assert.deepEqual(allowedRolesOf(applyPreset('developer'), []), [])
  assert.equal(roleDenyReason(applyPreset('developer'), 'research'), undefined)
  assert.match(roleDenyReason(applyPreset('developer'), 'release'), /allowlist/)
  assert.match(roleDenyReason(applyPreset('research'), 'developer'), /allowlist/)
  assert.deepEqual(childRolesOf(applyPreset('developer'), 'research'), [])
})

test('role is parsed from args, [role] label, or prompt prefix', () => {
  assert.equal(parseRequestedRole({ role: 'research' }), 'research')
  assert.equal(parseRequestedRole({ description: '[reviewer] check diff' }), 'reviewer')
  assert.equal(parseRequestedRole({ prompt: 'role: public\nlook around' }), 'public')
  assert.equal(parseRequestedRole({ description: 'implement feature' }), null)
  assert.deepEqual(parseRoleRequest({ role: 'administrator' }), { supplied: true, role: null, raw: 'administrator' })
  assert.match(roleDenyReason(applyPreset('developer'), null, null, true), /unknown/)
})

test('named research child is parent ∩ research and does not write', () => {
  const child = attenuateChildPolicy(applyPreset('developer'), rolePolicyOf('research'))
  assert.equal(child.files.write, 'none')
  assert.equal(child.preset, 'developer')
})
