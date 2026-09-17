// Host-plane tests.
//
// 全部跑在**真实**的 @deepseek-ai/dsh-session Session 上，而不是自造的
// 假 session。这一点是刻意的：本插件曾长期带着一个 100% 失败的删除路径
// 发版，原因就是测试用的假 session 只复刻了"我以为是"的宿主协议
// （surfaceOp 读 start/end），而宿主校验的是 startSeq/endSeq。假对象
// 只会确认作者的假设，不会反驳它。
//
// harness 包按精确版本锁在 devDependencies（见 package.json）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Session, SessionId, deriveEventMessage } = require('@deepseek-ai/dsh-session')
const { createUserMessage, createMessage, createToolResultMessage, createSystemMessage, ToolCallId } = require('@deepseek-ai/dsh-llm')
const { TokenMeter } = require('@deepseek-ai/dsh-token-meter')
const plugin = require('../src/index.js')
const {
  countTokens, entryText, groupRuns, projectContext, sessionBusy, deleteEntries,
  expandToPairBoundaries, pricingFor, usageMemo, hostGuards,
} = plugin.__internals

// 宿主固定启发式估计器。TokenMeter 的方法体不依赖 this（已发布包不带 src/）。
const estimateMessage = (message) => TokenMeter.prototype.estimateMessage.call(null, message)

const SURFACE = { surfaceOp: 'append' }

// ── 纯函数 ───────────────────────────────────────────────────────────────

test('countTokens golden values on the cl100k_base ranks', () => {
  assert.deepEqual(countTokens('hello world'), { tokens: 2, mode: 'cl100k' })
  assert.deepEqual(countTokens('自动续跑：会话结束后自动继续执行'), { tokens: 18, mode: 'cl100k' })
  assert.deepEqual(countTokens(''), { tokens: 0, mode: 'cl100k' })
  assert.deepEqual(countTokens(undefined), { tokens: 0, mode: 'cl100k' })
})

test('countTokens memoizes repeated text', () => {
  const text = 'memo probe for the razor token counter'
  usageMemo.delete(text)
  const before = usageMemo.size
  countTokens(text)
  assert.equal(usageMemo.size, before + 1)
  countTokens(text)
  assert.equal(usageMemo.size, before + 1)
})

test('entryText extracts model-facing text from all four surface types', () => {
  assert.equal(entryText({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] } }), 'hello\nworld')
  assert.equal(entryText({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] } } }), 'think\nanswer')
  assert.equal(entryText({
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'tool output' }] }] } },
  }), 'tool output')
  // system/message 与另外三类同构，早先漏了这一支 → 系统提示词恒显示 0 token
  assert.equal(entryText({
    type: 'system/message',
    data: { message: { content: [{ type: 'text', text: 'You are a novel author.' }] } },
  }), 'You are a novel author.')
  // 未知块保守跳过、缺字段不炸
  assert.equal(entryText({ type: 'user/message', data: { content: [{ type: 'image', url: 'x' }] } }), '')
  assert.equal(entryText({ type: 'tool/call', data: { name: 'x' } }), '')
})

test('groupRuns groups by surface adjacency and rejects unknown seqs', () => {
  const nodes = [10, 11, 12, 20, 25, 30, 31]
  assert.deepEqual(groupRuns(nodes, [10, 12, 11]), [[10, 11, 12]])
  assert.deepEqual(groupRuns(nodes, [20, 10, 31, 30]), [[10], [20], [30, 31]])
  assert.deepEqual(groupRuns(nodes, [12]), [[12]])
  assert.throws(() => groupRuns(nodes, [99]), /not on current surface/)
})

test('sessionBusy detects an open turn bracket', () => {
  const at = (events) => ({ snapshotEvents: () => events })
  const idle = at([{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 5 }])
  const busy = at([{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 5 }, { type: 'turn/start', seq: 9 }])
  const fresh = at([])
  assert.equal(sessionBusy(idle), false)
  assert.equal(sessionBusy(busy), true)
  assert.equal(sessionBusy(fresh), false)
})

// ── 真实会话骨架 ─────────────────────────────────────────────────────────

/**
 * 一个配对平衡的真实会话：
 *   seq 1 system / 2 user / 3 assistant(文本, usage) /
 *   4 assistant(tool-call Read) / 5 tool/call / 6 tool/result / 7 user
 *   surface = [1, 2, 3, 4, 6, 7]
 */
function demoSession(id = 's-demo', { open = false } = {}) {
  const s = Session.create(SessionId(id))
  s.append('turn/start', { turn: 1 })
  s.append('system/message', {
    turn: 1, step: 0,
    message: createSystemMessage('You are a helpful software engineer assistant.', '@deepseek-ai/dsh-persona'),
  }, SURFACE)
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'please help me refactor the parser module' }],
    source: { kind: 'user' },
  }), SURFACE)
  s.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'I will read the parser sources first.' }],
      source: { kind: 'model', provider: 'deepseek', model: 'v4' },
    }),
    usage: { inputTokens: 1200, outputTokens: 40 },
  }, SURFACE)
  s.append('assistant/message', {
    stream: [], turn: 1, step: 2,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'Read', arguments: '{"path":"parser.ts"}' }],
      source: { kind: 'model', provider: 'deepseek', model: 'v4' },
    }),
  }, SURFACE)
  s.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('c1'), name: 'Read', arguments: '{"path":"parser.ts"}' })
  s.append('tool/result', {
    turn: 1, step: 2,
    message: createToolResultMessage({
      callId: ToolCallId('c1'),
      content: [{ type: 'text', text: 'search results: parser.ts line 12 referenced everywhere' }],
      isError: false,
    }),
  }, SURFACE)
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'second prompt' }],
    source: { kind: 'user' },
  }), SURFACE)
  if (!open) s.append('turn/end', { turn: 1, reason: 'completed' })
  return s
}

const NODES = { system: 1, user: 2, say: 3, call: 4, result: 6, second: 7 }

function setupPlugin({ sessions, tokenMeter } = {}) {
  let handler
  const ctx = {
    sessions: {
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
    },
    webServer: { register: (route) => { handler = route.handler } },
    effect: (fn) => fn(),
    get: (name) => (name === 'tokenMeter' ? tokenMeter : undefined),
    logger: { warn: () => {} },
  }
  plugin.apply(ctx, {})
  const call = async (method, url, body) => {
    const { EventEmitter } = require('node:events')
    const req = new EventEmitter()
    req.method = method
    req.url = url
    const chunks = []
    const res = {
      writeHead(status) { chunks.status = status },
      end(chunk) { chunks.body = chunk === undefined ? '' : String(chunk) },
    }
    setTimeout(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    }, 5)
    await handler(req, res)
    return { status: chunks.status, payload: chunks.body ? JSON.parse(chunks.body) : undefined }
  }
  return { call }
}

const one = (session) => setupPlugin({ sessions: new Map([[session.id, session]]) })

// ── 宿主护栏可用性 ───────────────────────────────────────────────────────

test('host-exported guards resolve (tool pairing + event→message derivation)', () => {
  assert.deepEqual(hostGuards, { toolPairing: true, deriveEventMessage: true })
  assert.equal(pricingFor(one(demoSession()).ctx).source, 'cl100k-fallback')
})

// ── HTTP 路由 ────────────────────────────────────────────────────────────

test('GET /sessions lists sessions with light metadata', async () => {
  const s = demoSession('s-abc')
  const { call } = one(s)
  const res = await call('GET', '/context-razor/api/sessions')
  assert.equal(res.status, 200)
  assert.equal(res.payload.sessions.length, 1)
  const row = res.payload.sessions[0]
  assert.equal(row.id, 's-abc')
  assert.equal(row.nodes, 6)
  assert.equal(row.busy, false)
})

test('GET /context projects every surface entry with tokens, tool name and source', async () => {
  const s = demoSession('s-ctx')
  const { call } = one(s)
  const res = await call('GET', '/context-razor/api/context?session=s-ctx')
  assert.equal(res.status, 200)
  assert.equal(res.payload.nodes, 6)
  assert.equal(res.payload.entries.length, 6)
  assert.equal(res.payload.encoder, 'cl100k')
  assert.ok(res.payload.totalTokens > 0)
  // 计价尺子与配对护栏各用了哪一份，随响应回显
  assert.deepEqual(res.payload.guards, { pricing: 'cl100k-fallback', pairing: 'host' })

  const sys = res.payload.entries.find((e) => e.kind === 'system')
  assert.ok(sys, '系统提示词出现在条目里')
  assert.ok(sys.tokens > 0, '系统提示词有真实 token 数（曾恒为 0）')
  assert.match(sys.preview, /helpful software engineer/)

  const tool = res.payload.entries.find((e) => e.kind === 'tool')
  assert.equal(tool.tool, 'Read')                       // tool/result ← tool/call 按 callId 关联
  const assistantWithUsage = res.payload.entries.find((e) => e.usage !== undefined)
  assert.equal(assistantWithUsage.usage.input, 1200)
  assert.equal(assistantWithUsage.usage.output, 40)

  const unknown = await call('GET', '/context-razor/api/context?session=nope')
  assert.equal(unknown.status, 404)
})

test('GET /context echoes source kind/form/plugin for injected messages', async () => {
  const s = demoSession('s-inj')
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'injected context' }],
    source: { kind: 'plugin', plugin: '@weibaohui/dsh-continue', form: 'notice', summary: 'injected' },
  }), SURFACE)
  const { call } = one(s)
  const res = await call('GET', '/context-razor/api/context?session=s-inj')
  const injected = res.payload.entries.find((e) => e.sourceKind === 'plugin')
  assert.equal(injected.sourcePlugin, '@weibaohui/dsh-continue')
  assert.equal(injected.sourceForm, 'notice')
})

test('POST /delete shadows one contiguous run via prune + replace', async () => {
  const s = demoSession('s-del')
  const { call } = one(s)
  const res = await call('POST', '/context-razor/api/delete', { session: 's-del', seqs: [NODES.user, NODES.say] })
  assert.equal(res.status, 200)
  assert.equal(res.payload.removed, 2)
  assert.equal(res.payload.runs.length, 1)
  const run = res.payload.runs[0]
  assert.deepEqual([run.start, run.end, run.count], [NODES.user, NODES.say, 2])
  assert.ok(run.tokens > 0)

  // 日志：prune 先行，replace 随后且 sourceEventSeqs 覆盖被影子节点
  const events = s.snapshotEvents()
  const replace = events[run.replacement]
  const prune = events[run.replacement - 1]
  assert.equal(prune.type, 'compaction/prune')
  assert.deepEqual(prune.data.shadowedSeqs, [NODES.user, NODES.say])
  assert.deepEqual(prune.data.shadowedRange, { start: NODES.user, end: NODES.say })
  assert.equal(prune.data.shadowedTokenCount, run.tokens)
  assert.equal(replace.type, 'user/message')
  // 这正是曾经写错、导致 100% 删除失败的那一行：宿主只认 {op,startSeq,endSeq}
  assert.deepEqual(replace.surfaceOp, { op: 'replace', startSeq: NODES.user, endSeq: NODES.say })
  assert.deepEqual(replace.sourceEventSeqs, [NODES.user, NODES.say])
  assert.equal(replace.data.source.kind, 'plugin')
  assert.equal(replace.data.source.plugin, '@weibaohui/context-razor')
  assert.equal(replace.data.source.form, 'notice')
  assert.match(replace.data.source.summary, /已删除 2 条/)
  assert.match(replace.data.content[0].text, /已被用户删除/)

  // 模型可见视图：被删内容消失，标记补位
  const after = await call('GET', '/context-razor/api/context?session=s-del')
  assert.equal(after.payload.entries.length, 5)
  assert.ok(!after.payload.entries.some((e) => e.preview.includes('please help me refactor')))
  assert.ok(after.payload.entries.some((e) => e.sourcePlugin === '@weibaohui/context-razor'))
  assert.ok(!s.deriveMessages().some((m) => JSON.stringify(m).includes('please help me refactor')))
})

test('POST /delete splits non-contiguous selection into one replace per run', async () => {
  const s = demoSession('s-multi')
  const { call } = one(s)
  const baseline = s.snapshotEvents().length
  const res = await call('POST', '/context-razor/api/delete', { session: 's-multi', seqs: [NODES.user, NODES.second] })
  assert.equal(res.status, 200)
  assert.equal(res.payload.runs.length, 2)
  assert.equal(res.payload.removed, 2)
  assert.deepEqual(res.payload.expanded.seqs, [])
  const fresh = s.snapshotEvents().slice(baseline)
  assert.deepEqual(fresh.map((e) => e.type), ['compaction/prune', 'user/message', 'compaction/prune', 'user/message'])
})

test('POST /delete refuses busy sessions, unknown seqs and the system head', async () => {
  const busy = demoSession('s-busy', { open: true })
  const ok = demoSession('s-ok')
  const { call } = setupPlugin({ sessions: new Map([[busy.id, busy], [ok.id, ok]]) })

  const busyRes = await call('POST', '/context-razor/api/delete', { session: 's-busy', seqs: [NODES.user] })
  assert.equal(busyRes.status, 409)
  assert.match(busyRes.payload.error, /busy/)

  const badSeq = await call('POST', '/context-razor/api/delete', { session: 's-ok', seqs: [999] })
  assert.equal(badSeq.status, 409)
  assert.match(badSeq.payload.error, /not on current surface/)

  const badBody = await call('POST', '/context-razor/api/delete', { session: 's-ok', seqs: [] })
  assert.equal(badBody.status, 400)
})

// ── 工具配对 ─────────────────────────────────────────────────────────────

test('deleting a tool/result alone pulls its assistant call in (host pairing guard)', () => {
  const s = demoSession('s-pair-r')
  const before = s.snapshotEvents().length
  const r = deleteEntries(s, [NODES.result])
  assert.deepEqual(r.expanded.seqs, [NODES.call])        // 多删了发起调用的助手消息
  assert.equal(r.expanded.guard, 'host')
  assert.deepEqual(r.runs.map((x) => [x.start, x.end]), [[NODES.call, NODES.result]])
  assert.equal(r.removed, 2)
  // 不能再留下悬空的 compaction/prune
  assert.ok(s.snapshotEvents().length > before)
})

test('deleting the assistant tool-call alone pulls its result in', () => {
  const s = demoSession('s-pair-c')
  const r = deleteEntries(s, [NODES.call])
  assert.deepEqual(r.expanded.seqs, [NODES.result])
  assert.deepEqual(r.runs.map((x) => [x.start, x.end]), [[NODES.call, NODES.result]])
})

test('a selection that already covers the pair is not extended', () => {
  const s = demoSession('s-pair-whole')
  const r = deleteEntries(s, [NODES.call, NODES.result])
  assert.deepEqual(r.expanded.seqs, [])
  assert.equal(r.removed, 2)
})

test('expandToPairBoundaries reports "unavailable" only when the host export is missing', () => {
  const s = demoSession('s-pair-api')
  const nodes = [...s.surface.nodes]
  const r = expandToPairBoundaries(s, [nodes[0]], nodes)
  assert.deepEqual(r.seqs, [nodes[0]])
  assert.deepEqual(r.added, [])
  assert.equal(r.guard, 'host')     // 真实环境下宿主导出可用
})

// ── 系统提示词 ───────────────────────────────────────────────────────────

test('the system head cannot be deleted and is refused before anything is appended', () => {
  const s = demoSession('s-head')
  const before = s.snapshotEvents().length
  assert.throws(
    () => deleteEntries(s, [NODES.system]),
    /系统提示词.*不能删除/,
  )
  // 关键：prune 不能在替换被拒之后留在日志里
  assert.equal(s.snapshotEvents().length, before, '拒绝时必须一条事件都没写')
  assert.equal(s.snapshotEvents().filter((e) => e.type === 'compaction/prune').length, 0)
})

test('a run that merely starts at the system head is refused too', () => {
  const s = demoSession('s-head-run')
  assert.throws(() => deleteEntries(s, [NODES.system, NODES.user]), /系统提示词.*不能删除/)
})

test('later system nodes are deletable (only node 0 is protected)', () => {
  const s = demoSession('s-head-later')
  s.append('system/message', {
    turn: 1, step: 3,
    message: createSystemMessage('late runtime context snapshot', '@deepseek-ai/dsh-something'),
  }, SURFACE)
  const tail = s.surface.nodes.at(-1)
  const r = deleteEntries(s, [tail])
  assert.equal(r.removed, 1)
  assert.deepEqual(r.runs.map((x) => [x.start, x.end]), [[tail, tail]])
})

// ── 计价 ─────────────────────────────────────────────────────────────────

test('prune prices the shadowed range with the host estimator, not cl100k', () => {
  const s = demoSession('s-price')
  const meter = { estimateMessage }
  const pricing = pricingFor({ get: (name) => (name === 'tokenMeter' ? meter : undefined) })
  assert.equal(pricing.source, 'tokenMeter')

  const r = deleteEntries(s, [NODES.user, NODES.say], pricing)
  const prune = s.snapshotEvents().find((e) => e.type === 'compaction/prune')
  const expected = [NODES.user, NODES.say].reduce((sum, seq) => {
    const event = s.snapshotEvents()[seq]
    const message = deriveEventMessage(event)
    return sum + (message === null ? 0 : estimateMessage(message))
  }, 0)
  assert.equal(prune.data.shadowedTokenCount, expected)
  assert.equal(prune.data.shadowedTokenCount, r.tokensRemoved)

  // 两把尺子确实不同：cl100k 给的是另一个数
  const cl100k = [NODES.user, NODES.say]
    .reduce((sum, seq) => sum + countTokens(entryText(s.snapshotEvents()[seq])).tokens, 0)
  assert.notEqual(cl100k, expected)
})

test('the route reports which pricing ruler it used', async () => {
  const s = demoSession('s-price-route')
  const { call } = setupPlugin({ sessions: new Map([[s.id, s]]), tokenMeter: { estimateMessage } })
  const res = await call('GET', '/context-razor/api/context?session=s-price-route')
  assert.equal(res.payload.guards.pricing, 'tokenMeter')
  const del = await call('POST', '/context-razor/api/delete', { session: 's-price-route', seqs: [NODES.user] })
  assert.equal(del.payload.pricing, 'tokenMeter')
})

// ── 真实会话形状 ─────────────────────────────────────────────────────────

test('host 0.1.5 shape: snapshotEvents() with no events property drives the full flow', async () => {
  const s = demoSession('s-shape')
  assert.equal(s.events, undefined)          // 新宿主已移除该属性，插件不得依赖
  const { call } = one(s)
  const listed = await call('GET', '/context-razor/api/sessions')
  assert.equal(listed.payload.sessions[0].nodes, 6)
  assert.equal(listed.payload.sessions[0].busy, false)

  const deleted = await call('POST', '/context-razor/api/delete', { session: 's-shape', seqs: [NODES.user, NODES.say] })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.payload.removed, 2)

  const after = await call('GET', '/context-razor/api/context?session=s-shape')
  assert.equal(after.payload.entries.length, 5)
  const marker = after.payload.entries.find((e) => e.sourcePlugin === '@weibaohui/context-razor')
  assert.ok(marker, 'replacement marker visible on the surface')
})

test('projectContext stays consistent with the surface after a delete', () => {
  const s = demoSession('s-proj')
  const before = projectContext(s)
  assert.equal(before.entries.length, s.surface.nodes.length)
  deleteEntries(s, [NODES.call, NODES.result])
  const after = projectContext(s)
  assert.equal(after.entries.length, s.surface.nodes.length)
  assert.equal(after.entries.length, 5)          // 6 个节点删 2 个、补 1 个标记
  assert.deepEqual(after.entries.map((e) => e.seq), s.surface.nodes)
})
