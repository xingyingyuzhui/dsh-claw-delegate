import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyPreset } from '../../dsh-session-permissions/perm-schema.mjs'
import { apply, inject, name, _internal } from '../host.js'
import { loadChildSync, saveChildSync } from '../delegate-store.mjs'
import { applyHandoffToParent, loadHandoff } from '../delegate-deliver.mjs'

test('named exports and inject', () => {
  assert.equal(name, 'dsh-agent-delegate')
  assert.deepEqual(inject, ['tools', 'subagents', 'agents'])
})

function mockCtx(overrides = {}) {
  const starts = []
  const creates = []
  const guards = []
  const events = {}
  const disposers = []
  const ctx = {
    subagents: {
      async start(provider, request) {
        starts.push({ provider, request })
        return { id: 'run-1' }
      },
      async startContinuable(spec) {
        starts.push({ continuable: true, spec })
        return { childId: 'child-1' }
      },
    },
    agents: {
      async create(options) {
        creates.push(options)
        return { id: options.sessionId }
      },
      get() { return null },
    },
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    on(event, fn) {
      events[event] = fn
      return () => {}
    },
    effect(factory) {
      disposers.push(factory())
    },
    get() { return undefined },
    ...overrides,
  }
  return { ctx, starts, creates, guards, events, disposers }
}

function parentAgent(depth = 0, id = 'session-parent-aaaaaa', policyPreset = 'developer') {
  return {
    options: { subagentDepth: depth },
    session: {
      id,
      header: { cwd: process.cwd(), delegationDepth: depth, agentPreset: policyPreset },
      events: [],
    },
  }
}

test('delegate_handoff parameters are a JSON Schema object', () => {
  let registered
  const { ctx, events } = mockCtx({
    tools: {
      register() { throw new Error('host tools must not take handoff') },
      guard() { return () => {} },
    },
  })
  apply(ctx)
  events['agent/created']({
    agent: {
      session: { header: { cwd: join(tmpdir(), 'DSclaw', 'bot1') } },
      ctx: {
        tools: {
          register(def) {
            registered = def
            return () => {}
          },
        },
      },
    },
    source: 'startup',
  })
  assert.equal(registered.name, 'delegate_handoff')
  assert.equal(registered.parameters.type, 'object')
  assert.ok(registered.parameters.properties.action)
  assert.ok(registered.parameters.properties.child)
  assert.deepEqual(registered.parameters.required, ['action'])
})

test('workspace sessions do not get delegate_handoff', () => {
  let registered = false
  const { ctx, events } = mockCtx({
    tools: {
      register() { registered = true; return () => {} },
      guard() { return () => {} },
    },
  })
  apply(ctx)
  events['agent/created']({
    agent: {
      session: { header: { cwd: join(tmpdir(), 'Desktop', 'project') } },
      ctx: {
        tools: {
          register() { registered = true; return () => {} },
        },
      },
    },
    source: 'startup',
  })
  assert.equal(registered, false)
})

test('apply wraps start / create, registers guard and events, and restores on dispose', () => {
  const { ctx, guards, events, disposers } = mockCtx()
  const origStart = ctx.subagents.start
  const origCreate = ctx.agents.create
  apply(ctx)
  assert.equal(guards.length, 1)
  assert.ok(events['tools/pre-execute'])
  assert.ok(events['tools/execute'])
  assert.ok(events['subagent/end'])
  assert.notEqual(ctx.subagents.start, origStart)
  assert.notEqual(ctx.agents.create, origCreate)
  for (const stop of disposers) if (typeof stop === 'function') stop()
  assert.equal(ctx.subagents.start, origStart)
  assert.equal(ctx.agents.create, origCreate)
})

test('disposing a wrap leaves a later wrapper in place', async () => {
  const { ctx, disposers } = mockCtx()
  const origStart = ctx.subagents.start
  apply(ctx)
  async function later(provider, request) {
    return { later: true, provider, request }
  }
  ctx.subagents.start = later
  for (const stop of disposers) if (typeof stop === 'function') stop()
  assert.equal(ctx.subagents.start, later)
  assert.notEqual(ctx.subagents.start, origStart)
})

test('start clamps official tool maxDepth 3 down to policy maxDepth 1 and rejects depth 2', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx, starts } = mockCtx()
  apply(ctx)
  const parent = parentAgent(0, 'session-parent-aaaaaa')
  saveChildSync(home, { sessionId: parent.session.id, policy: applyPreset('developer') })
  await ctx.subagents.start('spawn', { parent, maxDepth: 3, prompt: [] })
  assert.equal(starts[0].request.maxDepth, 1)

  const child = parentAgent(1, 'session-child-bbbbbb')
  saveChildSync(home, { sessionId: child.session.id, policy: applyPreset('developer') })
  await assert.rejects(
    () => ctx.subagents.start('spawn', { parent: child, maxDepth: 3, prompt: [] }),
    /depth 2 exceeds maxDepth 1/,
  )
})

test('write child create pins a worktree cwd and persists attenuated policy', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-delegate-repo-'))
  execFileSync('git', ['init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  await writeFile(join(repo, 'README'), 'root\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx, creates } = mockCtx({
    agents: {
      get() {
        return {
          session: {
            id: 'session-parent-bbbbbb',
            header: { cwd: repo, agentPreset: 'developer' },
            events: [],
          },
        }
      },
      async create(options) {
        creates.push(options)
        return { id: options.sessionId }
      },
    },
  })
  apply(ctx)
  const childId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  await ctx.agents.create({
    sessionId: childId,
    meta: { origin: 'subagent', parentSession: 'session-parent-bbbbbb', cwd: repo, delegationDepth: 1 },
  })
  assert.equal(creates.length, 1)
  assert.notEqual(creates[0].meta.cwd, repo)
  assert.match(creates[0].meta.cwd, /agent-delegate\/worktrees/)
  const record = loadChildSync(home, childId)
  assert.ok(record)
  assert.equal(record.policy.files.write, 'workspace')
  assert.equal(record.worktree, creates[0].meta.cwd)
  assert.ok(record.baseCommit)
  assert.ok(record.parentRoot)
})

test('subagent end keeps a child patch and deletes the worktree', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-delegate-repo-'))
  execFileSync('git', ['init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  await writeFile(join(repo, 'README'), 'root\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx, events } = mockCtx({
    agents: {
      get() {
        return {
          session: {
            id: 'session-parent-eeeeee',
            header: { cwd: repo, agentPreset: 'developer' },
            events: [],
          },
        }
      },
      async create(options) { return { id: options.sessionId } },
    },
  })
  apply(ctx)
  const childId = 'cccccccc-dddd-eeee-ffff-000000000001'
  await ctx.agents.create({
    sessionId: childId,
    meta: { origin: 'subagent', parentSession: 'session-parent-eeeeee', cwd: repo, delegationDepth: 1 },
  })
  const record = loadChildSync(home, childId)
  await writeFile(join(record.worktree, 'shipped.txt'), 'from-child\n')
  events['subagent/end']({ id: childId })
  const patch = await readFile(join(home, 'agent-delegate', 'handoffs', childId + '.patch'), 'utf8')
  assert.match(patch, /shipped\.txt/)
  assert.match(patch, /from-child/)
  await assert.rejects(() => readFile(join(record.worktree, 'shipped.txt'), 'utf8'))
  await assert.rejects(() => readFile(join(repo, 'shipped.txt'), 'utf8'))
  assert.equal(loadChildSync(home, childId), null)
  const pending = loadHandoff(home, childId)
  assert.equal(pending.status, 'pending')
  const applied = applyHandoffToParent(home, childId)
  assert.equal(applied.ok, true)
  assert.equal(applied.status, 'applied')
  assert.equal(await readFile(join(repo, 'shipped.txt'), 'utf8'), 'from-child\n')
})

test('pre-execute denies a grandchild subagent and a partial file read for research', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const sandbox = { confine() { return { enforcement: 'partial' } } }
  const { ctx, events } = mockCtx({ get: () => sandbox })
  apply(ctx)
  const child = {
    options: { subagentDepth: 1 },
    session: {
      id: 'session-child-cccccc',
      header: { cwd: process.cwd(), delegationDepth: 1, agentPreset: 'research' },
      events: [],
    },
  }
  saveChildSync(home, { sessionId: child.session.id, policy: applyPreset('research') })
  const pre = events['tools/pre-execute']
  const depth = pre({ agent: child, name: 'subagent', arguments: {} }, () => ({ kind: 'allow' }))
  assert.equal(depth.kind, 'deny')
  assert.match(depth.reason, /depth 2/)

  const file = pre({ agent: child, name: 'read', arguments: { path: 'README' } }, () => ({ kind: 'allow' }))
  assert.equal(file.kind, 'deny')
  assert.match(file.reason, /partial/)
})

test('failed agents.create rolls back child record and worktree', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-delegate-repo-'))
  execFileSync('git', ['init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  await writeFile(join(repo, 'README'), 'root\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx } = mockCtx({
    agents: {
      get() {
        return {
          session: {
            id: 'session-parent-ffffff',
            header: { cwd: repo, agentPreset: 'developer' },
            events: [],
          },
        }
      },
      async create() {
        throw new Error('provider failed')
      },
    },
  })
  apply(ctx)
  const childId = 'ffffffff-1111-2222-3333-444444444444'
  await assert.rejects(
    () => ctx.agents.create({
      sessionId: childId,
      meta: { origin: 'subagent', parentSession: 'session-parent-ffffff', cwd: repo, delegationDepth: 1 },
    }),
    /provider failed/,
  )
  assert.equal(loadChildSync(home, childId), null)
})

test('explicit unknown role is denied before create', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx, guards } = mockCtx()
  apply(ctx)
  const parent = parentAgent(0, 'session-parent-roleee')
  saveChildSync(home, { sessionId: parent.session.id, policy: applyPreset('developer') })
  const reason = guards[0]({ agent: parent, name: 'subagent', arguments: { role: 'administrator' } })
  assert.match(reason, /unknown/)
})

test('research role child inherits read-only policy and no worktree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx, creates } = mockCtx()
  apply(ctx)
  const parent = parentAgent(0, 'session-parent-role01')
  saveChildSync(home, {
    sessionId: parent.session.id,
    policy: applyPreset('developer'),
    roles: ['research', 'reviewer'],
  })
  const { runWithBag } = await import('../delegate-context.mjs')
  const childId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
  await runWithBag({ role: 'research', label: 'survey', taskKey: 'survey#research' }, () => ctx.agents.create({
    sessionId: childId,
    meta: { origin: 'subagent', parentSession: parent.session.id, cwd: process.cwd(), delegationDepth: 1 },
  }))
  assert.equal(creates[0].meta.cwd, process.cwd())
  const record = loadChildSync(home, childId)
  assert.equal(record.role, 'research')
  assert.equal(record.policy.files.write, 'none')
  assert.deepEqual(record.roles, [])
})

test('pre-execute denies an unauthorized role and a budget overflow', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx, events } = mockCtx()
  apply(ctx)
  const parent = parentAgent(0, 'session-parent-role02')
  saveChildSync(home, {
    sessionId: parent.session.id,
    policy: { ...applyPreset('developer'), delegation: { maxDepth: 1, maxChildren: 1 } },
    roles: ['research'],
  })
  saveChildSync(home, {
    sessionId: 'session-live-child01',
    parentSession: parent.session.id,
    policy: applyPreset('research'),
  })
  const pre = events['tools/pre-execute']
  const role = pre({ agent: parent, name: 'subagent', arguments: { role: 'release' } }, () => ({ kind: 'allow' }))
  assert.equal(role.kind, 'deny')
  assert.match(role.reason, /allowlist/)
  const budget = pre({ agent: parent, name: 'subagent', arguments: { role: 'research' } }, () => ({ kind: 'allow' }))
  assert.equal(budget.kind, 'deny')
  assert.match(budget.reason, /budget exceeded/)
})

test('reportFrom rejects a stale generation after a newer same-task start', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const reports = []
  const { ctx } = mockCtx({
    subagents: {
      async start() { return { id: 'run' } },
      async startContinuable() { return { childId: 'x' } },
      async reportFrom(child, content) {
        reports.push({ child, content })
        return 'msg-1'
      },
    },
  })
  apply(ctx)
  const { runWithBag } = await import('../delegate-context.mjs')
  const parent = parentAgent(0, 'session-parent-stale1')
  saveChildSync(home, { sessionId: parent.session.id, policy: applyPreset('developer'), roles: ['research'] })
  await runWithBag({ role: 'research', label: 'survey', taskKey: 'survey#research' }, () => ctx.agents.create({
    sessionId: 'cccccccc-dddd-eeee-ffff-000000000001',
    meta: { origin: 'subagent', parentSession: parent.session.id, cwd: process.cwd(), delegationDepth: 1 },
  }))
  await runWithBag({ role: 'research', label: 'survey', taskKey: 'survey#research' }, () => ctx.agents.create({
    sessionId: 'cccccccc-dddd-eeee-ffff-000000000002',
    meta: { origin: 'subagent', parentSession: parent.session.id, cwd: process.cwd(), delegationDepth: 1 },
  }))
  const oldChild = {
    session: { id: 'cccccccc-dddd-eeee-ffff-000000000001', header: {} },
  }
  await assert.rejects(
    () => ctx.subagents.reportFrom(oldChild, [{ type: 'text', text: 'old' }], {}),
    /stale subagent result/,
  )
  assert.equal(reports.length, 0)
})

test('background bash resolve is pinned to a job worktree', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-delegate-repo-'))
  execFileSync('git', ['init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  await writeFile(join(repo, 'README'), 'root\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const resolved = []
  const { ctx, events } = mockCtx({
    shell: {
      resolve(request) {
        resolved.push(request)
        return request
      },
    },
  })
  apply(ctx)
  const parent = {
    options: {},
    session: {
      id: 'session-parent-job001',
      header: { cwd: repo, delegationDepth: 0, agentPreset: 'developer' },
      events: [],
    },
  }
  saveChildSync(home, { sessionId: parent.session.id, policy: applyPreset('developer') })
  const exec = {
    agent: parent,
    name: 'bash',
    arguments: { command: 'echo hi', description: 'bg', run_in_background: true },
  }
  await events['tools/execute'](exec, () => {
    const next = ctx.shell.resolve({ command: 'echo hi' })
    return { kind: 'background', jobId: 'bash-1' }
  })
  assert.equal(resolved.length, 1)
  assert.notEqual(resolved[0].workdir, repo)
  assert.match(resolved[0].workdir, /agent-delegate\/worktrees\/job-/)
})

test('main session create is not given a worktree', async () => {
  const { ctx, creates } = mockCtx()
  apply(ctx)
  await ctx.agents.create({
    sessionId: 'session-main-dddddd',
    meta: { cwd: process.cwd() },
  })
  assert.equal(creates[0].meta.cwd, process.cwd())
})
