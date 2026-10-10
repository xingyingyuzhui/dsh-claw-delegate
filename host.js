import { randomUUID } from 'node:crypto'
import { resolveLayersSync } from 'dsh-claw-permissions/layers'
import { renderDenyReceipt } from 'dsh-claw-permissions/official'
import { asArgs, classifyTool } from 'dsh-claw-permissions/schema'
import { allowExecution, looksLikeDsClaw } from 'dsh-claw-permissions/path'
import { currentBag, runWithBag } from './delegate-context.mjs'
import {
  clampStartMaxDepth,
  depthDenyReason,
  isSubagentTool,
  parentDepthOf,
} from './delegate-depth.mjs'
import { budgetDenyReason, budgetOf } from './delegate-budget.mjs'
import {
  prepareChildDelivery,
  staleDenyReason,
  taskKeyOf,
} from './delegate-handoff.mjs'
import { attenuateChildPolicy, childNeedsWorktree, denyPartialFileAction } from './delegate-policy.mjs'
import {
  allowedRolesOf,
  childRolesOf,
  parseRoleRequest,
  roleDenyReason,
  rolePolicyOf,
} from './delegate-role.mjs'
import { probeEnforcement } from './delegate-sandbox.mjs'
import {
  appendAudit,
  bumpTask,
  defaultDshHome,
  latestTask,
  listDiskChildren,
  listLiveChildren,
  loadChildSync,
  removeChildSync,
  restoreTask,
  saveChildSync,
} from './delegate-store.mjs'
import { createWriteWorktree, deliverChildHandoff, formatHandoffNote, removeWriteWorktree } from './delegate-worktree.mjs'
import { applyHandoffToParent, listHandoffs, loadHandoff, persistChildHandoff, rejectHandoff } from './delegate-deliver.mjs'
import { CODES, operation, runWithTrace, setObserveHome } from 'dsh-claw-observability/observe'
import { registerJsonRoute } from 'dsh-claw-core/http'

export const name = 'dsh-claw-delegate'
export const inject = ['tools', 'subagents', 'agents', 'connection']

let dshHome = defaultDshHome()
let cachedProbe

const _internal = {
  setDshHome(dir) {
    dshHome = dir
    cachedProbe = undefined
    setObserveHome(dir)
  },
  getDshHome() { return dshHome },
  resetProbe() { cachedProbe = undefined },
}
export { _internal }

function wrapMethod(obj, key, wrapper) {
  if (!obj || typeof obj[key] !== 'function') return function () {}
  const orig = obj[key]
  let live = true
  function wrapped(...args) {
    if (!live) return orig.apply(this, args)
    return wrapper.call(this, orig, ...args)
  }
  obj[key] = wrapped
  return function () {
    live = false
    if (obj[key] === wrapped) obj[key] = orig
  }
}

function optionalService(ctx, key) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const got = ctx.get(key)
      if (got != null) return got
    } catch { /* not injected */ }
  }
  if (ctx && Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key]
  return undefined
}

function wrapShell(ctx) {
  return wrapMethod(optionalService(ctx, 'shell'), 'resolve', function (orig, request) {
    const bag = currentBag()
    if (bag && bag.jobWorktree) {
      return orig.call(this, { ...request, workdir: bag.jobWorktree })
    }
    return orig.call(this, request)
  })
}

function wrapJobs(ctx) {
  const jobs = optionalService(ctx, 'jobs')
  const stopJobs = wrapMethod(jobs, 'start', function (orig, spec) {
    if (!spec || (spec.kind !== 'bash' && spec.kind !== 'subagent')) return orig.call(this, spec)
    const bag = currentBag()
    const reserved = bag && bag.jobId
    const owner = spec.owner
    const policy = policyOf(owner)
    const budget = budgetOf(policy, recordOf(owner))
    const parentId = parentIdOf(owner)
    if (!reserved && parentId) {
      const reason = budgetDenyReason(liveCount(parentId), budget.maxChildren)
      if (reason) {
        const err = new Error(reason)
        err.name = 'SubagentBudgetError'
        throw err
      }
    }
    const limit = spec.outputLimitBytes == null
      ? budget.maxOutputBytes
      : Math.min(spec.outputLimitBytes, budget.maxOutputBytes)
    const id = orig.call(this, { ...spec, outputLimitBytes: limit })
    if (reserved) {
      const record = loadChildSync(dshHome, reserved)
      if (record) saveChildSync(dshHome, { ...record, jobId: id })
    }
    return id
  })
  const stopJobDone = jobs && typeof jobs.onJobDone === 'function'
    ? jobs.onJobDone((snapshot) => {
      if (!snapshot || !snapshot.id || snapshot.status === 'running' || snapshot.status === 'stopping') return
      const rows = listLiveChildren(dshHome).filter((row) => row.kind === 'job' && row.jobId === snapshot.id)
      for (const row of rows) cleanupChild(row.sessionId)
    })
    : function () {}
  return function () {
    stopJobs()
    stopJobDone()
  }
}

function headerOf(agentOrSession) {
  if (!agentOrSession) return {}
  if (agentOrSession.header) return agentOrSession.header
  const session = agentOrSession.session
  return (session && session.header) || {}
}

function layersOf(agentOrSession) {
  const session = agentOrSession && agentOrSession.session ? agentOrSession.session : agentOrSession
  if (!session || !session.id) return null
  const header = session.header || {}
  return resolveLayersSync(dshHome, {
    sessionId: session.id,
    cwd: header.cwd,
    preset: header.agentPreset,
    events: session.events,
  })
}

function recordOf(agentOrSession) {
  const session = agentOrSession && agentOrSession.session ? agentOrSession.session : agentOrSession
  const id = session && session.id
  return id ? loadChildSync(dshHome, id) : null
}

function policyOf(agentOrSession) {
  const record = recordOf(agentOrSession)
  if (record && record.policy) return record.policy
  const layers = layersOf(agentOrSession)
  return layers && layers.effective
}

function storedRolesOf(agentOrSession) {
  const record = recordOf(agentOrSession)
  return record ? record.roles : null
}

function parentLayersOf(ctx, parentSession, cwd) {
  if (parentSession && ctx.agents && typeof ctx.agents.get === 'function') {
    const agent = ctx.agents.get(parentSession)
    if (agent) return layersOf(agent)
  }
  if (parentSession && ctx.sessions && typeof ctx.sessions.binding === 'function') {
    try {
      const bound = ctx.sessions.binding(parentSession)
      if (bound && bound.session) return layersOf(bound.session)
    } catch { /* binding unavailable */ }
  }
  return resolveLayersSync(dshHome, { sessionId: parentSession, cwd })
}

function enforcementOf(ctx, cwd) {
  if (cachedProbe) return cachedProbe
  const sandbox = ctx && typeof ctx.get === 'function' ? ctx.get('sandbox') : ctx && ctx.sandbox
  cachedProbe = probeEnforcement(sandbox, cwd)
  return cachedProbe
}

function liveCount(parentSession) {
  return listLiveChildren(dshHome, parentSession).length
}

function parentIdOf(agent) {
  const session = agent && agent.session
  return session && session.id
}

function isBackgroundWrite(name, args, policy) {
  if (classifyTool(name, args) !== 'bash') return false
  if (asArgs(args).run_in_background !== true) return false
  return childNeedsWorktree(policy)
}

function labelOf(args, request) {
  const value = asArgs(args)
  return (request && request.label) || value.description || value.command || ''
}

function clampRequest(request) {
  if (!request || !request.parent) return request
  const policy = policyOf(request.parent)
  const bag = currentBag()
  const spec = parseRoleRequest(null, request)
  const role = (bag && bag.role) || spec.role
  const roleReason = roleDenyReason(policy, role, storedRolesOf(request.parent), spec.supplied)
  if (roleReason) {
    const err = new Error(roleReason)
    err.name = 'SubagentRoleError'
    const logged = operation({ plugin: 'dsh-claw-delegate', feature: 'child-session', operation: 'start_child', sessionId: parentIdOf(request.parent) })
    logged.start()
    logged.reject(CODES.DELEGATE_ROLE_DENIED, { reason: 'role_denied' })
    throw err
  }
  const budget = budgetOf(policy, recordOf(request.parent))
  const budgetReason = budgetDenyReason(liveCount(parentIdOf(request.parent)), budget.maxChildren)
  if (budgetReason) {
    const err = new Error(budgetReason)
    err.name = 'SubagentBudgetError'
    const logged = operation({ plugin: 'dsh-claw-delegate', feature: 'child-session', operation: 'start_child', sessionId: parentIdOf(request.parent) })
    logged.start()
    logged.reject(CODES.DELEGATE_BUDGET_DENIED, { reason: 'budget' })
    throw err
  }
  const maxDepth = clampStartMaxDepth(request.maxDepth, policy && policy.delegation && policy.delegation.maxDepth)
  const reason = depthDenyReason(parentDepthOf(request.parent), maxDepth)
  if (reason) {
    const err = new Error(reason)
    err.name = 'SubagentDepthError'
    const logged = operation({ plugin: 'dsh-claw-delegate', feature: 'child-session', operation: 'start_child', sessionId: parentIdOf(request.parent) })
    logged.start()
    logged.reject(CODES.DELEGATE_DEPTH_DENIED, { reason: 'depth' })
    throw err
  }
  return { ...request, maxDepth }
}

function prepareChildCreate(ctx, options) {
  const meta = options && options.meta
  if (!meta || meta.origin !== 'subagent' || !options.sessionId) return options
  const bag = currentBag()
  const parentLayers = parentLayersOf(ctx, meta.parentSession, meta.cwd)
  const parentPolicy = parentLayers && parentLayers.effective
  const parentRecord = meta.parentSession ? loadChildSync(dshHome, meta.parentSession) : null
  const spec = bag && bag.roleSpec ? bag.roleSpec : parseRoleRequest(null, null)
  const role = bag && bag.role ? bag.role : spec.role
  const roleReason = roleDenyReason(parentPolicy, role, parentRecord && parentRecord.roles, spec.supplied)
  if (roleReason) {
    const denied = operation({ plugin: 'dsh-claw-delegate', feature: 'child-session', operation: 'create_child', sessionId: meta.parentSession, childSessionId: options.sessionId })
    denied.start()
    denied.reject(CODES.DELEGATE_ROLE_DENIED, { reason: 'role_denied' })
    const err = new Error(roleReason)
    err.name = 'SubagentRoleError'
    throw err
  }
  const policy = attenuateChildPolicy(parentPolicy, role ? rolePolicyOf(role) : null)
  const roles = childRolesOf(parentPolicy, role, parentRecord && parentRecord.roles)
  const taskKey = (bag && bag.taskKey) || taskKeyOf(bag && bag.label, role, options.sessionId)
  const previousTask = latestTask(dshHome, meta.parentSession, taskKey)
  const budget = budgetOf(parentPolicy, parentRecord)
  const budgetReason = budgetDenyReason(liveCount(meta.parentSession), budget.maxChildren)
  if (budgetReason) {
    const op = operation({ plugin: 'dsh-claw-delegate', feature: 'child-session', operation: 'create_child', sessionId: meta.parentSession })
    op.start()
    op.reject(CODES.DELEGATE_BUDGET_DENIED, { reason: 'budget' })
    const err = new Error(budgetReason)
    err.name = 'SubagentBudgetError'
    throw err
  }
  const bumped = bumpTask(dshHome, meta.parentSession, taskKey, options.sessionId)
  if (bag) bag.childId = options.sessionId
  const record = {
    sessionId: options.sessionId,
    parentSession: meta.parentSession || null,
    policy,
    worktree: null,
    role,
    roles,
    kind: 'subagent',
    taskKey,
    generation: bumped.generation,
  }
  saveChildSync(dshHome, record)
  appendAudit(dshHome, {
    kind: 'create',
    sessionId: options.sessionId,
    parentSession: meta.parentSession,
    role,
    taskKey,
    generation: bumped.generation,
    write: policy && policy.files && policy.files.write,
    maxDepth: policy && policy.delegation && policy.delegation.maxDepth,
  })
  const rollback = () => rollbackChildCreate({
    sessionId: options.sessionId,
    parentSession: meta.parentSession,
    taskKey,
    previousTask,
    parentCwd: meta.cwd,
  })
  if (bag) bag.rollback = rollback
  if (!childNeedsWorktree(policy)) return options
  try {
    const created = createWriteWorktree({
      home: dshHome,
      sessionId: options.sessionId,
      parentCwd: meta.cwd,
    })
    saveChildSync(dshHome, {
      ...record,
      worktree: created.path,
      parentRoot: created.parentRoot,
      parentHead: created.parentHead,
      baseCommit: created.baseCommit,
    })
    appendAudit(dshHome, { kind: 'worktree', sessionId: options.sessionId, worktree: created.path })
    return { ...options, meta: { ...meta, cwd: created.path } }
  } catch (error) {
    const op = operation({ plugin: 'dsh-claw-delegate', feature: 'child-session', operation: 'create_child', sessionId: meta.parentSession, childSessionId: options.sessionId })
    op.start()
    op.stage('worktree')
    try {
      rollback()
      op.fail(CODES.DELEGATE_WORKTREE_FAILED, error, {
        state: 'clean',
        recovery: { attempted: true, outcome: 'succeeded' },
      })
    } catch (rollbackError) {
      op.fail(CODES.DELEGATE_ROLLBACK_FAILED, rollbackError, {
        state: 'orphaned',
        remainingArtifacts: ['delegate_worktree', 'child_record'],
        recovery: { attempted: true, outcome: 'failed' },
      })
    }
    throw error
  }
}

function rollbackChildCreate({ sessionId, parentSession, taskKey, previousTask, parentCwd }) {
  const record = sessionId ? loadChildSync(dshHome, sessionId) : null
  if (record && record.worktree) {
    removeWriteWorktree({
      home: dshHome,
      sessionId,
      parentCwd: parentCwd || record.worktree,
    })
  }
  if (sessionId) removeChildSync(dshHome, sessionId)
  if (parentSession && taskKey) {
    restoreTask(dshHome, parentSession, taskKey, previousTask
      ? { sessionId: previousTask.sessionId, generation: previousTask.generation }
      : null)
  }
}

function denyExec(ctx, exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (!session || !session.id) return undefined
  const policy = policyOf(agent)
  if (!policy) return undefined
  const name = exec.name
  const args = exec.arguments
  if (isSubagentTool(name)) {
    const spec = parseRoleRequest(args, null)
    const roleReason = roleDenyReason(policy, spec.role, storedRolesOf(agent), spec.supplied)
    if (roleReason) return roleReason
    const budget = budgetOf(policy, recordOf(agent))
    const budgetReason = budgetDenyReason(liveCount(session.id), budget.maxChildren)
    if (budgetReason) return budgetReason
    const depthReason = depthDenyReason(parentDepthOf(agent), policy.delegation && policy.delegation.maxDepth)
    if (depthReason) return depthReason
  }
  if (isBackgroundWrite(name, args, policy)) {
    const budget = budgetOf(policy, recordOf(agent))
    const budgetReason = budgetDenyReason(liveCount(session.id), budget.maxChildren)
    if (budgetReason) return budgetReason
  }
  const cwd = headerOf(session).cwd
  const childRecord = loadChildSync(dshHome, session.id)
  const partial = denyPartialFileAction(policy, enforcementOf(ctx, cwd), name, args, childRecord && childRecord.role)
  if (partial) return partial
  const record = childRecord
  if (record && record.policy && !allowExecution(policy, name, args, cwd)) {
    return renderDenyReceipt(classifyTool(name, args), 'Denied by delegated child policy.')
  }
  return undefined
}

function captureHandoff(record) {
  if (!record || !record.worktree) return null
  try {
    const info = deliverChildHandoff({
      home: dshHome,
      sessionId: record.sessionId,
      worktree: record.worktree,
      baseCommit: record.baseCommit,
      parentRoot: record.parentRoot,
    })
    if (info && info.path) {
      saveChildSync(dshHome, { ...record, handoffPath: info.path })
      persistChildHandoff(dshHome, { ...record, handoffPath: info.path }, info)
    }
    return info
  } catch {
    return null
  }
}

function attachHandoffNote(result, info, childSessionId) {
  const note = formatHandoffNote(info, childSessionId)
  if (!note) return result
  if (!result || typeof result !== 'object') return result
  if (result.kind === 'block' || result.kind === 'deny') return result
  const value = result.value
  if (value && typeof value === 'object' && Array.isArray(value.output)) {
    return {
      kind: 'accept',
      value: { ...value, output: [{ type: 'text', text: note }, ...value.output] },
    }
  }
  if (typeof result.content === 'string') {
    return { ...result, content: note + '\n\n' + result.content }
  }
  return result
}

function cleanupChild(sessionId) {
  const record = loadChildSync(dshHome, sessionId)
  if (!record) return
  const handoff = captureHandoff(record)
  if (handoff && !handoff.empty) {
    const op = operation({ plugin: 'dsh-claw-delegate', feature: 'handoff', operation: 'child_handoff', sessionId: record.parentSession, childSessionId: sessionId })
    op.start()
    op.success({ code: CODES.DELEGATE_HANDOFF_SAVED, fileCount: (handoff.files || []).length, bytes: handoff.bytes })
  }
  if (record.worktree) {
    removeWriteWorktree({
      home: dshHome,
      sessionId,
      parentCwd: record.parentRoot || record.worktree,
    })
  }
  removeChildSync(dshHome, sessionId)
  appendAudit(dshHome, {
    kind: 'end',
    sessionId,
    worktree: record.worktree,
    role: record.role,
    taskKey: record.taskKey,
    handoffPath: handoff && handoff.path,
    handoffFiles: handoff && handoff.files,
  })
}

function prepareJobWorktree(exec) {
  const agent = exec && exec.agent
  const policy = policyOf(agent)
  if (!isBackgroundWrite(exec.name, exec.arguments, policy)) return null
  const parentSession = parentIdOf(agent)
  const jobId = 'job-' + randomUUID()
  const role = null
  const taskKey = taskKeyOf(labelOf(exec.arguments), role, jobId)
  const bumped = bumpTask(dshHome, parentSession, taskKey, jobId)
  const cwd = headerOf(agent && agent.session).cwd
  const created = createWriteWorktree({
    home: dshHome,
    sessionId: jobId,
    parentCwd: cwd,
  })
  saveChildSync(dshHome, {
    sessionId: jobId,
    parentSession,
    policy,
    worktree: created.path,
    parentRoot: created.parentRoot,
    parentHead: created.parentHead,
    baseCommit: created.baseCommit,
    role,
    roles: allowedRolesOf(policy, storedRolesOf(agent)),
    kind: 'job',
    taskKey,
    generation: bumped.generation,
  })
  appendAudit(dshHome, { kind: 'worktree', sessionId: jobId, parentSession, worktree: created.path, job: true })
  return { jobId, path: created.path }
}

function bagFromExec(exec) {
  if (!exec) return null
  if (isSubagentTool(exec.name)) {
    const spec = parseRoleRequest(exec.arguments, null)
    return {
      role: spec.role,
      roleSpec: spec,
      label: labelOf(exec.arguments),
      taskKey: taskKeyOf(labelOf(exec.arguments), spec.role, parentIdOf(exec.agent)),
      parentSession: parentIdOf(exec.agent),
    }
  }
  return null
}

function applyHandoffResult(result, childId) {
  if (!childId) return result
  const record = loadChildSync(dshHome, childId)
  if (!record) return result
  const latest = latestTask(dshHome, record.parentSession, record.taskKey)
  if (!result || typeof result !== 'object') return result
  if (result.kind === 'block' || result.kind === 'deny') return result
  try {
    const value = result.value
    let next = result
    if (value && typeof value === 'object' && Array.isArray(value.output)) {
      next = {
        kind: 'accept',
        value: { ...value, output: prepareChildDelivery(record, latest, value.output) },
      }
    } else if (typeof result.content === 'string') {
      const trimmed = prepareChildDelivery(record, latest, [{ type: 'text', text: result.content }])
      const text = trimmed && trimmed[0] && typeof trimmed[0].text === 'string' ? trimmed[0].text : result.content
      next = { ...result, content: text }
    } else {
      prepareChildDelivery(record, latest, [])
    }
    const handoff = captureHandoff(record)
    return attachHandoffNote(next, handoff, childId)
  } catch (error) {
    if (error && error.name === 'SubagentStaleError') {
      const stale = operation({ plugin: 'dsh-claw-delegate', feature: 'handoff', operation: 'child_handoff', sessionId: record.parentSession, childSessionId: childId })
      stale.start()
      stale.reject(CODES.DELEGATE_STALE_RESULT, { reason: 'stale_generation' })
      return { kind: 'block', feedback: [{ type: 'text', text: staleDenyReason() }] }
    }
    throw error
  }
}

function runHandoffAction(args, parentSession) {
  const value = asArgs(args)
  const action = String(value.action || '').toLowerCase()
  const child = String(value.child || value.id || '').trim()
  if (action === 'list' || action === '') {
    return { ok: true, items: listHandoffs(dshHome, parentSession) }
  }
  if (!child) return { ok: false, error: 'child session id required' }
  const row = loadHandoff(dshHome, child)
  if (!row) return { ok: false, error: 'handoff not found' }
  if (row.parentSession && parentSession && row.parentSession !== parentSession) {
    return { ok: false, error: 'handoff belongs to another parent' }
  }
  const op = operation({
    plugin: 'dsh-claw-delegate',
    feature: 'handoff',
    operation: 'parent_' + action,
    sessionId: parentSession,
    childSessionId: child,
  })
  op.start()
  if (action === 'accept') {
    const childRecord = loadChildSync(dshHome, child)
    const generationRecord = childRecord || (row.taskKey
      ? {
        sessionId: child,
        parentSession: row.parentSession || parentSession,
        taskKey: row.taskKey,
        generation: row.generation,
        policy: null,
      }
      : null)
    if (generationRecord && generationRecord.taskKey) {
      const latest = latestTask(dshHome, generationRecord.parentSession, generationRecord.taskKey)
      try {
        prepareChildDelivery(generationRecord, latest, [])
      } catch (error) {
        if (error && error.name === 'SubagentStaleError') {
          op.reject(CODES.DELEGATE_STALE_RESULT, { reason: 'stale_generation' })
          appendAudit(dshHome, { kind: 'handoff-stale', sessionId: child, parentSession, error: error.message })
          return { ok: false, status: 'stale', error: error.message }
        }
        throw error
      }
    }
    const result = applyHandoffToParent(dshHome, child)
    if (result.status === 'conflicted') {
      op.degraded(CODES.DELEGATE_HANDOFF_CONFLICT, { skipReason: 'conflict' })
    } else if (result.ok) {
      op.success({ code: CODES.DELEGATE_HANDOFF_APPLIED, status: result.status })
    } else {
      op.reject(CODES.DELEGATE_HANDOFF_INVALID, { reason: result.error })
    }
    appendAudit(dshHome, { kind: 'handoff-' + result.status, sessionId: child, parentSession, error: result.error || '' })
    return result
  }
  if (action === 'reject') {
    const result = rejectHandoff(dshHome, child)
    if (result.ok) op.success({ code: CODES.DELEGATE_HANDOFF_REJECTED })
    else op.reject(CODES.DELEGATE_HANDOFF_INVALID, { reason: result.error })
    appendAudit(dshHome, { kind: 'handoff-rejected', sessionId: child, parentSession })
    return result
  }
  op.reject(CODES.DELEGATE_HANDOFF_INVALID, { reason: 'bad action' })
  return { ok: false, error: 'action must be list, accept, or reject' }
}

function handoffTool() {
  return {
    name: 'delegate_handoff',
    description: 'Accept, reject, or list write-child handoff patches. Accept applies the saved patch to the parent git workspace after you have reviewed the child. Reject discards it. Do not accept blindly.',
    timeoutMs: 20000,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'accept', 'reject'], description: 'list | accept | reject' },
        child: { type: 'string', description: 'Child session id for accept/reject' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value || {}, null, 2) }]
      },
    },
    execute(args, exec) {
      return runWithTrace(exec, async () => {
        const parentSession = parentIdOf(exec && exec.agent)
        return { kind: 'accept', value: runHandoffAction(args || {}, parentSession) }
      })
    },
  }
}

function mountHandoffTool(agent) {
  const session = agent && agent.session
  const cwd = session && session.header && session.header.cwd ? String(session.header.cwd) : ''
  if (!looksLikeDsClaw(cwd)) return
  const tools = agent && agent.ctx && agent.ctx.tools
  if (!tools || typeof tools.register !== 'function') return
  try { tools.register(handoffTool()) } catch { /* already registered */ }
}

function liveIdsOf(ctx) {
  const sessionIds = []
  const jobIds = []
  try {
    const agents = optionalService(ctx, 'agents')
    const list = agents && typeof agents.list === 'function' ? agents.list() : []
    for (const agent of list || []) {
      const id = agent && agent.session && agent.session.id
      if (id) sessionIds.push(id)
    }
  } catch { /* optional */ }
  try {
    const jobs = optionalService(ctx, 'jobs')
    const list = jobs && typeof jobs.list === 'function' ? jobs.list() : []
    for (const job of list || []) {
      if (job && job.id && (job.status === 'running' || job.status === 'stopping')) jobIds.push(job.id)
    }
  } catch { /* optional */ }
  return { sessionIds, jobIds }
}

function reconcileOrphans(ctx) {
  const agents = optionalService(ctx, 'agents')
  const jobs = optionalService(ctx, 'jobs')
  if ((!agents || typeof agents.list !== 'function') && (!jobs || typeof jobs.list !== 'function')) return
  const live = liveIdsOf(ctx)
  const sessions = new Set(live.sessionIds)
  const liveJobs = new Set(live.jobIds)
  for (const row of listDiskChildren(dshHome)) {
    if (sessions.has(row.sessionId)) continue
    if (row.jobId && liveJobs.has(row.jobId)) continue
    if (row.worktree) {
      removeWriteWorktree({
        home: dshHome,
        sessionId: row.sessionId,
        parentCwd: row.worktree,
      })
    }
    removeChildSync(dshHome, row.sessionId)
    appendAudit(dshHome, { kind: 'reconcile', sessionId: row.sessionId, worktree: row.worktree })
    const op = operation({ plugin: 'dsh-claw-delegate', feature: 'child-session', operation: 'reconcile', sessionId: row.parentSession, childSessionId: row.sessionId })
    op.start()
    op.degraded(CODES.DELEGATE_ORPHAN_RECONCILED, { state: 'clean', remainingArtifacts: [] })
  }
}

export function apply(ctx) {
  try { reconcileOrphans(ctx) } catch { /* startup reconcile is best-effort */ }
  const stopStart = wrapMethod(ctx.subagents, 'start', function (orig, provider, request) {
    return Promise.resolve().then(() => orig.call(this, provider, clampRequest(request)))
  })
  const stopContinuable = wrapMethod(ctx.subagents, 'startContinuable', function (orig, spec) {
    return Promise.resolve().then(() => {
      if (!spec || !spec.request) return orig.call(this, spec)
      return orig.call(this, { ...spec, request: clampRequest(spec.request) })
    })
  })
  const stopCreate = wrapMethod(ctx.agents, 'create', function (orig, options) {
    return Promise.resolve().then(() => runWithTrace(options && options.traceId, () => {
      let prepared
      try {
        prepared = prepareChildCreate(ctx, options)
      } catch (error) {
        throw error
      }
      if (!options || !options.meta || options.meta.origin !== 'subagent') {
        return orig.call(this, prepared)
      }
      const op = operation({
        plugin: 'dsh-claw-delegate',
        feature: 'child-session',
        operation: 'create_child',
        sessionId: options.meta.parentSession,
        childSessionId: options.sessionId,
      })
      op.start()
      op.stage('provider_create')
      return Promise.resolve(orig.call(this, prepared)).then((value) => {
        op.success({ childSessionId: options.sessionId })
        return value
      }).catch((error) => {
        let recovered = true
        try {
          const bag = currentBag()
          if (bag && typeof bag.rollback === 'function') bag.rollback()
          else if (prepared && prepared.sessionId) {
            rollbackChildCreate({
              sessionId: prepared.sessionId,
              parentSession: prepared.meta && prepared.meta.parentSession,
              parentCwd: prepared.meta && prepared.meta.cwd,
            })
          }
        } catch {
          recovered = false
        }
        op.fail(CODES.DELEGATE_PROVIDER_CREATE_FAILED, error, {
          state: recovered ? 'clean' : 'orphaned',
          remainingArtifacts: recovered ? [] : ['delegate_worktree', 'child_record'],
          recovery: { attempted: true, outcome: recovered ? 'succeeded' : 'failed' },
        })
        throw error
      })
    }))
  })
  const optionalStops = []
  if (typeof ctx.inject === 'function') {
    ctx.inject(['shell'], (sub) => {
      const stop = wrapShell(sub)
      sub.effect(() => () => stop())
    })
    ctx.inject(['jobs'], (sub) => {
      const stop = wrapJobs(sub)
      sub.effect(() => () => stop())
    })
  } else {
    optionalStops.push(wrapShell(ctx), wrapJobs(ctx))
  }

  const stopSend = wrapMethod(ctx.subagents, 'sendMessage', function (orig, sender, targetId, content, options) {
    return Promise.resolve().then(() => {
      const senderSession = sender && sender.session
      const record = senderSession && senderSession.id ? loadChildSync(dshHome, senderSession.id) : null
      if (record && targetId === record.parentSession) {
        const latest = latestTask(dshHome, record.parentSession, record.taskKey)
        const trimmed = prepareChildDelivery(record, latest, content, budgetOf(record.policy, record).maxOutputBytes)
        return orig.call(this, sender, targetId, trimmed, options)
      }
      return orig.call(this, sender, targetId, content, options)
    })
  })
  const stopGuard = ctx.tools && typeof ctx.tools.guard === 'function'
    ? ctx.tools.guard((exec) => denyExec(ctx, exec))
    : function () {}

  const stopPre = typeof ctx.on === 'function'
    ? ctx.on('tools/pre-execute', (exec, next) => {
      const reason = denyExec(ctx, exec)
      if (reason) {
        appendAudit(dshHome, { kind: 'deny', tool: exec && exec.name, reason, sessionId: exec && exec.agent && exec.agent.session && exec.agent.session.id })
        return { kind: 'deny', reason }
      }
      return next()
    })
    : function () {}

  const stopExecute = typeof ctx.on === 'function'
    ? ctx.on('tools/execute', (exec, next) => {
      const bag = bagFromExec(exec) || {}
      let job
      try {
        job = prepareJobWorktree(exec)
      } catch (error) {
        return Promise.reject(error)
      }
      if (job) {
        bag.jobWorktree = job.path
        bag.jobId = job.jobId
      }
      if (!bag.role && !bag.jobWorktree && !isSubagentTool(exec && exec.name)) return next()
      return runWithTrace(exec, () => runWithBag(bag, () => Promise.resolve().then(() => next()).then((result) => {
        if (bag.jobId) {
          const jobRecord = loadChildSync(dshHome, bag.jobId)
          return attachHandoffNote(result, captureHandoff(jobRecord), bag.jobId)
        }
        if (!isSubagentTool(exec && exec.name)) return result
        return applyHandoffResult(result, bag.childId)
      }).catch((error) => {
        if (bag.jobId) {
          const row = loadChildSync(dshHome, bag.jobId)
          if (row && !row.jobId) cleanupChild(bag.jobId)
        }
        throw error
      })))
    })
    : function () {}

  const stopEnd = typeof ctx.on === 'function'
    ? ctx.on('subagent/end', (info) => {
      if (info && info.id) cleanupChild(info.id)
    })
    : function () {}

  // DSH 0.1.6+: mount handoff on agent/created so the tool exists before the first turn.
  const stopSessionStart = typeof ctx.on === 'function'
    ? ctx.on('agent/created', (payload) => {
      mountHandoffTool(payload && payload.agent)
    })
    : function () {}

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/delegate/handoff',
    handle: (body) => runHandoffAction(body, body && body.parentSession),
  })

  ctx.effect(() => () => {
    if (typeof stopStart === 'function') stopStart()
    if (typeof stopContinuable === 'function') stopContinuable()
    if (typeof stopCreate === 'function') stopCreate()
    if (typeof stopSend === 'function') stopSend()
    for (const stop of optionalStops) if (typeof stop === 'function') stop()
    if (typeof stopGuard === 'function') stopGuard()
    if (typeof stopPre === 'function') stopPre()
    if (typeof stopExecute === 'function') stopExecute()
    if (typeof stopEnd === 'function') stopEnd()
    if (typeof stopSessionStart === 'function') stopSessionStart()
  })
}
