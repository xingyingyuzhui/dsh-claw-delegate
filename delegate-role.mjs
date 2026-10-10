import { applyPreset, isPresetId } from 'dsh-claw-permissions/schema'
import { asArgs } from 'dsh-claw-permissions/schema'

export const DELEGATION_ROLES = ['research', 'developer', 'reviewer', 'release', 'public']

const PRESET_ROLES = {
  full: DELEGATION_ROLES.slice(),
  developer: ['research', 'reviewer'],
  research: [],
  reviewer: [],
  release: [],
  public: [],
}

export function isDelegationRole(value) {
  return DELEGATION_ROLES.includes(value)
}

export function defaultRolesOf(preset) {
  return (PRESET_ROLES[preset] || []).slice()
}

export function allowedRolesOf(policy, storedRoles) {
  if (Array.isArray(storedRoles)) {
    return storedRoles.filter(isDelegationRole)
  }
  const explicit = policy && policy.delegation && policy.delegation.roles
  if (Array.isArray(explicit)) return explicit.filter(isDelegationRole)
  return defaultRolesOf(policy && policy.preset)
}

function textOfPrompt(prompt) {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map((block) => (block && block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function parseRoleRequest(args, request) {
  const value = asArgs(args)
  const direct = String(value.role || value.preset || '').toLowerCase().trim()
  if (direct) {
    return { supplied: true, role: isDelegationRole(direct) ? direct : null, raw: direct }
  }
  const label = String((request && request.label) || value.description || '')
  const fromLabel = label.match(/^\s*\[(research|developer|reviewer|release|public)\]/i)
  if (fromLabel) {
    const role = fromLabel[1].toLowerCase()
    return { supplied: true, role, raw: role }
  }
  const prompt = textOfPrompt(request && request.prompt) || String(value.prompt || '')
  const fromPrompt = prompt.match(/^\s*(?:role|preset)\s*[:=]\s*(research|developer|reviewer|release|public)\b/i)
  if (fromPrompt) {
    const role = fromPrompt[1].toLowerCase()
    return { supplied: true, role, raw: role }
  }
  return { supplied: false, role: null, raw: '' }
}

export function parseRequestedRole(args, request) {
  return parseRoleRequest(args, request).role
}

export function roleDenyReason(policy, requestedRole, storedRoles, supplied) {
  if (supplied && !requestedRole) {
    return 'Denied: unknown delegation role.'
  }
  if (!requestedRole) return undefined
  if (!isDelegationRole(requestedRole) || !isPresetId(requestedRole)) {
    return 'Denied: unknown delegation role ' + requestedRole + '.'
  }
  const allowed = allowedRolesOf(policy, storedRoles)
  if (allowed.indexOf(requestedRole) < 0) {
    return 'Denied: role ' + requestedRole + ' is not in the parent delegation allowlist.'
  }
  return undefined
}

export function rolePolicyOf(role) {
  if (!isDelegationRole(role)) return null
  return applyPreset(role)
}

export function childRolesOf(parentPolicy, requestedRole, parentStoredRoles) {
  const parentRoles = allowedRolesOf(parentPolicy, parentStoredRoles)
  if (!requestedRole) return parentRoles.slice()
  return allowedRolesOf(rolePolicyOf(requestedRole), defaultRolesOf(requestedRole))
    .filter((role) => parentRoles.includes(role))
}
