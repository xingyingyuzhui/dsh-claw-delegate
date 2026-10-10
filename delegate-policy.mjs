import {
  classifyTool,
  intersectPolicies,
  isToolEnabled,
  normalizePolicy,
} from 'dsh-claw-policy/schema'

const FULL_ISOLATION_PRESETS = ['research', 'reviewer', 'public']

export function childPolicyOf(parentPolicy, requestedPolicy) {
  return intersectPolicies(parentPolicy, requestedPolicy || parentPolicy)
}

export function attenuateChildPolicy(parentPolicy, requestedPolicy) {
  const child = childPolicyOf(parentPolicy, requestedPolicy)
  if (!child.files || child.files.write !== 'all') return child
  return {
    ...child,
    files: { ...child.files, write: 'workspace' },
  }
}

export function childNeedsWorktree(policy) {
  if (!policy || !policy.files) return false
  if (policy.files.write !== 'none') return true
  return isToolEnabled(policy, 'write') || isToolEnabled(policy, 'edit') || isToolEnabled(policy, 'apply_patch')
}

export function requiresFullEnforcement(policy, role) {
  if (role && FULL_ISOLATION_PRESETS.includes(role)) return true
  if (!policy) return false
  const sandbox = policy.sandbox
  if (sandbox && sandbox.requireEnforcement === 'full') return true
  return FULL_ISOLATION_PRESETS.includes(policy.preset)
}

export function isFileAction(name, args) {
  const cls = classifyTool(name, args)
  return cls === 'read' || cls === 'write' || cls === 'edit' || cls === 'apply_patch' || cls === 'bash'
}

export function denyPartialFileAction(policy, probe, name, args, role) {
  if (!requiresFullEnforcement(policy, role)) return undefined
  if (!isFileAction(name, args)) return undefined
  if (!probe || probe.kind !== 'ok') return undefined
  if (probe.enforcement !== 'partial') return undefined
  return 'Denied: sandbox enforcement is partial; this role requires full file isolation.'
}

export function normalizeRequestedPolicy(raw, fallbackPreset) {
  if (!raw) return null
  return normalizePolicy(raw, fallbackPreset)
}
