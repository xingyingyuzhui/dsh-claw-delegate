import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { gitRootOf, handoffPath } from './delegate-worktree.mjs'

export const HANDOFF_STATUSES = ['pending', 'applied', 'conflicted', 'rejected', 'empty']

export function handoffMetaPath(home, sessionId) {
  return join(home, 'agent-delegate', 'handoffs', String(sessionId) + '.json')
}

function safeId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length >= 6 && !sessionId.includes('/') && !sessionId.includes('\\')
}

function runGit(args, cwd, runner, opts) {
  const run = runner || ((nextArgs, nextCwd, nextOpts) => spawnSync('git', nextArgs, {
    cwd: nextCwd,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    input: nextOpts && nextOpts.input,
  }))
  return run(args, cwd, opts)
}

export function normalizeHandoff(raw, sessionId) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const status = HANDOFF_STATUSES.includes(value.status) ? value.status : 'pending'
  return {
    version: 1,
    childSessionId: typeof value.childSessionId === 'string' && value.childSessionId ? value.childSessionId : sessionId,
    parentSession: typeof value.parentSession === 'string' ? value.parentSession : null,
    parentRoot: typeof value.parentRoot === 'string' && value.parentRoot ? value.parentRoot : '',
    parentHead: typeof value.parentHead === 'string' ? value.parentHead : '',
    path: typeof value.path === 'string' && value.path ? value.path : '',
    files: Array.isArray(value.files) ? value.files.filter((name) => typeof name === 'string') : [],
    bytes: Number.isFinite(Number(value.bytes)) ? Number(value.bytes) : 0,
    empty: value.empty === true,
    status,
    method: typeof value.method === 'string' ? value.method : '',
    taskKey: typeof value.taskKey === 'string' ? value.taskKey : '',
    generation: Number.isFinite(Number(value.generation)) ? Number(value.generation) : 0,
    error: value.error && typeof value.error === 'object' && typeof value.error.message === 'string'
      ? { message: value.error.message }
      : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  }
}

export function loadHandoff(home, sessionId) {
  if (!safeId(sessionId)) return null
  try {
    return normalizeHandoff(JSON.parse(readFileSync(handoffMetaPath(home, sessionId), 'utf8')), sessionId)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

export function saveHandoff(home, record, now = new Date().toISOString()) {
  if (!record || !safeId(record.childSessionId || record.sessionId)) throw new Error('invalid handoff id')
  const next = normalizeHandoff({
    ...record,
    childSessionId: record.childSessionId || record.sessionId,
    updatedAt: now,
    createdAt: record.createdAt || now,
  }, record.childSessionId || record.sessionId)
  const file = handoffMetaPath(home, next.childSessionId)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, file)
  return next
}

export function persistChildHandoff(home, child, collected) {
  const id = child && child.sessionId
  if (!id) return null
  const info = collected && typeof collected === 'object' ? collected : {}
  return saveHandoff(home, {
    childSessionId: id,
    parentSession: child.parentSession || null,
    parentRoot: info.parentRoot || child.parentRoot || '',
    parentHead: child.parentHead || '',
    path: info.path || handoffPath(home, id),
    files: info.files || [],
    bytes: info.bytes || 0,
    empty: !!info.empty,
    status: info.empty ? 'empty' : 'pending',
    // Persist generation identity so accept can still reject stale after child cleanup.
    taskKey: typeof child.taskKey === 'string' ? child.taskKey : '',
    generation: Number.isFinite(Number(child.generation)) ? Number(child.generation) : 0,
  })
}

export function listHandoffs(home, parentSession) {
  let names
  try {
    names = readdirSync(join(home, 'agent-delegate', 'handoffs'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const row = loadHandoff(home, name.slice(0, -5))
    if (!row) continue
    if (parentSession && row.parentSession !== parentSession) continue
    out.push(row)
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

function patchText(record) {
  try {
    return readFileSync(record.path, 'utf8')
  } catch {
    return ''
  }
}

function tryApply(root, patch, args, runner) {
  const check = runGit(['apply', '--check', ...args], root, runner, { input: patch })
  if (!check || check.status !== 0) {
    return { ok: false, stderr: String((check && (check.stderr || check.stdout)) || 'git apply --check failed') }
  }
  const applied = runGit(['apply', ...args], root, runner, { input: patch })
  if (!applied || applied.status !== 0) {
    return { ok: false, stderr: String((applied && (applied.stderr || applied.stdout)) || 'git apply failed') }
  }
  return { ok: true }
}

export function applyHandoffToParent(home, childSessionId, runner) {
  const record = loadHandoff(home, childSessionId)
  if (!record) return { ok: false, status: 'missing', error: 'handoff not found' }
  if (record.status === 'applied') return { ok: true, status: 'applied', handoff: record }
  if (record.status === 'rejected') return { ok: false, status: 'rejected', error: 'handoff was rejected', handoff: record }
  if (record.status === 'empty' || record.empty) {
    const next = saveHandoff(home, { ...record, status: 'empty' })
    return { ok: true, status: 'empty', handoff: next }
  }
  const root = gitRootOf(record.parentRoot, runner)
  if (!root) return { ok: false, status: record.status, error: 'parent is not a git workspace', handoff: record }
  const patch = patchText(record)
  if (!patch.trim()) {
    const next = saveHandoff(home, { ...record, status: 'empty', empty: true })
    return { ok: true, status: 'empty', handoff: next }
  }
  const plain = tryApply(root, patch, ['--whitespace=nowarn'], runner)
  if (plain.ok) {
    const next = saveHandoff(home, { ...record, status: 'applied', method: 'git-apply', error: null })
    return { ok: true, status: 'applied', method: 'git-apply', handoff: next }
  }
  const three = tryApply(root, patch, ['--3way', '--whitespace=nowarn'], runner)
  if (three.ok) {
    const next = saveHandoff(home, { ...record, status: 'applied', method: 'git-apply-3way', error: null })
    return { ok: true, status: 'applied', method: 'git-apply-3way', handoff: next }
  }
  const next = saveHandoff(home, {
    ...record,
    status: 'conflicted',
    error: { message: (plain.stderr || three.stderr || 'patch does not apply').trim().slice(0, 400) },
  })
  return { ok: false, status: 'conflicted', error: next.error && next.error.message, handoff: next }
}

export function rejectHandoff(home, childSessionId) {
  const record = loadHandoff(home, childSessionId)
  if (!record) return { ok: false, status: 'missing', error: 'handoff not found' }
  if (record.status === 'applied') return { ok: false, status: 'applied', error: 'handoff already applied', handoff: record }
  if (record.status === 'rejected') return { ok: true, status: 'rejected', handoff: record }
  const next = saveHandoff(home, { ...record, status: 'rejected', error: null })
  return { ok: true, status: 'rejected', handoff: next }
}
