import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { normalizePolicy } from 'dsh-claw-permissions/schema'
import { nextGeneration } from './delegate-handoff.mjs'

export function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function childFile(home, sessionId) {
  return join(home || defaultDshHome(), 'agent-delegate', 'children', String(sessionId) + '.json')
}

export function auditFile(home) {
  return join(home || defaultDshHome(), 'agent-delegate', 'audit.jsonl')
}

function safeId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length >= 6 && !sessionId.includes('/') && !sessionId.includes('\\')
}

function asStringList(value) {
  if (!Array.isArray(value)) return null
  return value.filter((item) => typeof item === 'string' && item)
}

function optionalNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function emptyChild(sessionId, now = new Date().toISOString()) {
  return {
    version: 1,
    sessionId,
    parentSession: null,
    policy: null,
    worktree: null,
    role: null,
    roles: null,
    kind: 'subagent',
    taskKey: null,
    generation: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function normalizeChild(raw, sessionId) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const now = new Date().toISOString()
  const policyRaw = value.policy && typeof value.policy === 'object' ? value.policy : null
  return {
    version: 1,
    sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : sessionId,
    parentSession: typeof value.parentSession === 'string' ? value.parentSession : null,
    policy: policyRaw ? normalizePolicy(policyRaw) : null,
    worktree: typeof value.worktree === 'string' && value.worktree ? value.worktree : null,
    parentRoot: typeof value.parentRoot === 'string' && value.parentRoot ? value.parentRoot : null,
    parentHead: typeof value.parentHead === 'string' && value.parentHead ? value.parentHead : null,
    baseCommit: typeof value.baseCommit === 'string' && value.baseCommit ? value.baseCommit : null,
    handoffPath: typeof value.handoffPath === 'string' && value.handoffPath ? value.handoffPath : null,
    role: typeof value.role === 'string' && value.role ? value.role : null,
    roles: asStringList(value.roles),
    kind: value.kind === 'job' ? 'job' : 'subagent',
    jobId: typeof value.jobId === 'string' && value.jobId ? value.jobId : null,
    maxChildren: optionalNumber(value.maxChildren != null ? value.maxChildren : policyRaw && policyRaw.delegation && policyRaw.delegation.maxChildren),
    maxOutputBytes: optionalNumber(value.maxOutputBytes != null ? value.maxOutputBytes : policyRaw && policyRaw.delegation && policyRaw.delegation.maxOutputBytes),
    taskKey: typeof value.taskKey === 'string' && value.taskKey ? value.taskKey : null,
    generation: optionalNumber(value.generation),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
  }
}

export function loadChildSync(home, sessionId) {
  if (!safeId(sessionId)) return null
  try {
    return normalizeChild(JSON.parse(readFileSync(childFile(home, sessionId), 'utf8')), sessionId)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

export function saveChildSync(home, record, now = new Date().toISOString()) {
  if (!record || !safeId(record.sessionId)) throw new Error('invalid child session id')
  const next = {
    ...normalizeChild(record, record.sessionId),
    updatedAt: now,
    createdAt: record.createdAt || now,
  }
  const file = childFile(home, next.sessionId)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, file)
  return next
}

export function removeChildSync(home, sessionId) {
  if (!safeId(sessionId)) return
  try {
    unlinkSync(childFile(home, sessionId))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
}

export function appendAudit(home, row) {
  try {
    const file = auditFile(home)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n', { flag: 'a' })
  } catch { /* best-effort */ }
}

export function childrenDir(home) {
  return join(home || defaultDshHome(), 'agent-delegate', 'children')
}

export function listDiskChildren(home) {
  let names
  try {
    names = readdirSync(childrenDir(home))
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const row = loadChildSync(home, name.slice(0, -5))
    if (row) out.push(row)
  }
  return out
}

export function listLiveChildren(home, parentSession) {
  return listDiskChildren(home).filter((row) => {
    if (parentSession && row.parentSession !== parentSession) return false
    return true
  })
}

export function taskFile(home, parentSession) {
  return join(home || defaultDshHome(), 'agent-delegate', 'tasks', String(parentSession) + '.json')
}

export function loadTaskLedger(home, parentSession) {
  if (!safeId(parentSession)) return { parentSession, tasks: {} }
  try {
    const raw = JSON.parse(readFileSync(taskFile(home, parentSession), 'utf8'))
    const tasks = raw && raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {}
    return { parentSession, tasks }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { parentSession, tasks: {} }
    throw error
  }
}

export function latestTask(home, parentSession, taskKey) {
  if (!taskKey) return null
  const ledger = loadTaskLedger(home, parentSession)
  const row = ledger.tasks[taskKey]
  if (!row || typeof row !== 'object') return null
  return {
    taskKey,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    generation: Number(row.generation) || 0,
  }
}

export function bumpTask(home, parentSession, taskKey, sessionId) {
  if (!safeId(parentSession) || !taskKey) {
    return { taskKey, sessionId, generation: 1 }
  }
  const ledger = loadTaskLedger(home, parentSession)
  const prev = ledger.tasks[taskKey]
  const generation = nextGeneration(prev && prev.generation)
  ledger.tasks[taskKey] = { sessionId, generation }
  writeLedger(home, parentSession, ledger)
  return { taskKey, sessionId, generation }
}

function writeLedger(home, parentSession, ledger) {
  const file = taskFile(home, parentSession)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n')
  renameSync(tmp, file)
}

export function restoreTask(home, parentSession, taskKey, previous) {
  if (!safeId(parentSession) || !taskKey) return
  const ledger = loadTaskLedger(home, parentSession)
  if (!previous) delete ledger.tasks[taskKey]
  else ledger.tasks[taskKey] = previous
  writeLedger(home, parentSession, ledger)
}
