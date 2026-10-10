import assert from 'node:assert/strict'
import test from 'node:test'
import { isStaleRecord, nextGeneration, taskKeyOf, trimHandoff } from '../delegate-handoff.mjs'

test('task keys and generations', () => {
  assert.equal(taskKeyOf('Review PR', 'research'), 'review pr#research')
  assert.equal(taskKeyOf('  ', null, 'session-abc'), 'session-abc')
  assert.equal(taskKeyOf('  '), 'task')
  assert.equal(nextGeneration(undefined), 1)
  assert.equal(nextGeneration(2), 3)
})

test('stale when generation or child id moved on', () => {
  const rec = { sessionId: 'a', generation: 1 }
  assert.equal(isStaleRecord(rec, { sessionId: 'a', generation: 1 }), false)
  assert.equal(isStaleRecord(rec, { sessionId: 'b', generation: 2 }), true)
  assert.equal(isStaleRecord(rec, null), false)
})

test('prepareChildDelivery rejects stale and trims output', async () => {
  const { prepareChildDelivery } = await import('../delegate-handoff.mjs')
  const record = { sessionId: 'a', generation: 1, policy: { delegation: { maxOutputBytes: 1024 } } }
  assert.throws(
    () => prepareChildDelivery(record, { sessionId: 'b', generation: 2 }, [{ type: 'text', text: 'x' }]),
    (err) => err && err.name === 'SubagentStaleError',
  )
  const trimmed = prepareChildDelivery(
    record,
    { sessionId: 'a', generation: 1 },
    [{ type: 'text', text: 'h'.repeat(50) }],
    16,
  )
  assert.equal(trimmed.length, 1)
  assert.ok(trimmed[0].text.endsWith('[truncated]'))
  assert.ok(Buffer.byteLength(trimmed[0].text, 'utf8') <= 16)
})

test('handoff is byte-capped', () => {
  const long = 'h'.repeat(50)
  const cut = trimHandoff(long, 16)
  assert.equal(cut.truncated, true)
  assert.ok(cut.text.endsWith('[truncated]'))
  assert.ok(Buffer.byteLength(cut.text, 'utf8') <= 16)
  assert.deepEqual(trimHandoff('ok', 16), { text: 'ok', truncated: false })
})
