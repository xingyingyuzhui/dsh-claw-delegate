import { SubagentStaleError } from 'dsh-claw-core/errors'
import { budgetOf } from './delegate-budget.mjs'

export function taskKeyOf(label, role, fallback) {
  const raw = String(label || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const key = raw || String(fallback || '').trim() || 'task'
  return role ? key + '#' + role : key
}

export function nextGeneration(current) {
  const n = Number(current)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) + 1 : 1
}

export function isStaleRecord(record, latest) {
  if (!record || !latest) return false
  if (record.sessionId !== latest.sessionId) return true
  if (Number(record.generation) !== Number(latest.generation)) return true
  return false
}

export function staleDenyReason() {
  return 'Denied: stale subagent result discarded.'
}

/**
 * Shared stale + output-budget gate for child → parent deliveries.
 * @param {object|null} record child delegate record
 * @param {object|null} latest latest task pointer for the same parent+taskKey
 * @param {unknown} content content blocks (or any value passed through trimContentBlocks)
 * @param {number} [maxOutputBytes] optional override; defaults to budgetOf(record.policy, record)
 */
export function prepareChildDelivery(record, latest, content, maxOutputBytes) {
  if (isStaleRecord(record, latest)) {
    throw new SubagentStaleError(staleDenyReason())
  }
  const max = maxOutputBytes != null
    ? maxOutputBytes
    : budgetOf(record && record.policy, record).maxOutputBytes
  return trimContentBlocks(content, max)
}

function cutUtf8(buf, keep) {
  let cut = buf.subarray(0, Math.max(0, keep))
  while (cut.length && (cut[cut.length - 1] & 0xc0) === 0x80) {
    cut = cut.subarray(0, cut.length - 1)
  }
  if (cut.length && (cut[cut.length - 1] & 0xc0) === 0xc0) {
    cut = cut.subarray(0, cut.length - 1)
  }
  return cut
}

export function trimHandoff(text, maxBytes) {
  const limit = Number(maxBytes)
  const value = text == null ? '' : String(text)
  if (!Number.isFinite(limit) || limit <= 0) return { text: value, truncated: false }
  const buf = Buffer.from(value, 'utf8')
  if (buf.length <= limit) return { text: value, truncated: false }
  const suffix = '\n[truncated]'
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  if (limit <= suffixBytes) {
    return { text: cutUtf8(Buffer.from('[truncated]', 'utf8'), limit).toString('utf8'), truncated: true }
  }
  const cut = cutUtf8(buf, limit - suffixBytes)
  return { text: cut.toString('utf8') + suffix, truncated: true }
}

export function trimContentBlocks(blocks, maxBytes) {
  if (!Array.isArray(blocks)) return blocks
  let used = 0
  const out = []
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      const size = Buffer.byteLength(JSON.stringify(block || {}), 'utf8')
      if (used + size > maxBytes) {
        out.push({ type: 'text', text: '[truncated]' })
        break
      }
      out.push(block)
      used += size
      continue
    }
    const remain = maxBytes - used
    if (remain <= 0) {
      out.push({ type: 'text', text: '[truncated]' })
      break
    }
    const next = trimHandoff(block.text, remain)
    out.push({ ...block, text: next.text })
    used += Buffer.byteLength(next.text, 'utf8')
    if (next.truncated) break
  }
  return out
}
