/**
 * dsh-plugin-razor — Host half.
 *
 * 上下文剃刀：把会话上下文的每条消息列出来（角色/预览/≈token），让用户
 * 勾选后精确裁剪。删除不是物理删日志（append-only、深冻结、zstd 校验，
 * 宿主根本不支持），而是走宿主的 surface replace 协议——与官方
 * dsh-compaction-tool-result-pruner 同款：先追加一条 `compaction/prune`
 * 计价事件，再追加一条带 `surfaceOp: {op:'replace', startSeq, endSeq}`
 * 的标记 user/message，`sourceEventSeqs` 覆盖全部被影子化的节点。被删节点
 * 从此不进 `deriveMessages()`（模型视野消失），web UI 也随 mux fold 同步
 * 折叠。全程不经 LLM 总结——删了什么、删了多少，用户逐条可见。
 *
 * 这份实现必须同时满足宿主的两条契约，缺一条就会静默出错：
 *
 * 1. **surfaceOp 形状**：replace 只接受恰好 `{ op, startSeq, endSeq }`
 *    三个键（宿主 `isReplaceOp` + `validateSurfaceMetadata`）。字段名写成
 *    `start`/`end` 会被拒：`carries an invalid replace surfaceOp`。
 * 2. **工具配对**：一个 step 的 `tool-call` 与其 `tool/result` 不可拆开。
 *    宿主把拆开后的状态判为损坏——折叠遇到"没有对应 tool-call 的
 *    tool/result"会 throw（`… has no matching tool-call (corrupt surface)`），
 *    压缩引擎的 `compactRegion` 也拒绝在不平衡切口下刀。判定用宿主自己
 *    导出的 `toolPairingBalancedBefore/After`，不本地重写一份 fold。
 * 3. **系统提示词**：surface node 0 是系统提示词时，宿主只允许它被另一条
 *    `system/message` 覆盖（`assertSystemHeadRewrite`）。剃刀用 user/message
 *    标记替换，所以系统提示词不可删——显式拦住，不留给宿主拒。
 *
 * 另外 `compaction/prune` 的 `shadowedTokenCount` 会被宿主的 surface 折叠
 * 直接相减，所以必须用宿主计量器那一把尺子（见 `pricingFor`）。
 */

const { randomUUID } = require('node:crypto')
const { homedir } = require('node:os')
const { join } = require('node:path')

// ── token 计数（js-tiktoken cl100k_base，与 skills-management 同源同值）──
// 降级模式退回宿主 tokenMeter 同款 chars/4 启发式（token 计数是本插件
// 核心功能，不能像 skills-management 那样直接不显示）。
const RAZOR_PLUGIN_NAME = '@weibaohui/context-razor'
let usageEncoder = null
let usageEncoderFailed = false
function usageEncoderLazy() {
  if (usageEncoderFailed) return null
  if (usageEncoder === null) {
    try {
      const { Tiktoken } = require('js-tiktoken/lite')
      usageEncoder = new Tiktoken(require('js-tiktoken/ranks/cl100k_base'))
    } catch { usageEncoderFailed = true }
  }
  return usageEncoder
}
const USAGE_MEMO_CAP = 30000
const usageMemo = new Map()
/** cl100k_base 估算；词表不可用时退回 chars/4 启发式。返回 { tokens, mode }。 */
function countTokens(text) {
  if (typeof text !== 'string' || text === '') return { tokens: 0, mode: 'cl100k' }
  const enc = usageEncoderLazy()
  if (enc !== null) {
    let tokens = usageMemo.get(text)
    if (tokens === undefined) {
      tokens = enc.encode(text).length
      if (usageMemo.size >= USAGE_MEMO_CAP) usageMemo.clear()
      usageMemo.set(text, tokens)
    }
    return { tokens, mode: 'cl100k' }
  }
  return { tokens: Math.ceil(text.length / 4) + 4, mode: 'heuristic' }
}

// ── 事件 → 模型可见文本 ────────────────────────────────────────────────
// surface 上只有四类事件（dsh-session SURFACE_EVENT_TYPES：system/user/
// assistant/tool-result）；ContentBlock 是 merge-extensible 联合，已知块
// 取字段，未知块（如 image）不贡献文本、按 0 计——它在这条投影里本来就
// 没有可读文本，价格由路由自己算。
function blockText(block) {
  if (block === null || typeof block !== 'object') return ''
  if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string' ? block.text : ''
  if (block.type === 'tool-result') return (Array.isArray(block.content) ? block.content : []).map(blockText).join('\n')
  return ''
}
function blocksText(blocks) {
  return Array.isArray(blocks) ? blocks.map(blockText).filter(Boolean).join('\n') : ''
}
function entryText(event) {
  const data = event.data || {}
  if (event.type === 'user/message') return blocksText(data.content)
  if (event.type === 'system/message') return blocksText(data.message && data.message.content)
  if (event.type === 'assistant/message') return blocksText(data.message && data.message.content)
  if (event.type === 'tool/result') return blocksText(data.message && data.message.content)
  return ''
}
function entryKindOf(type) {
  if (type === 'system/message') return 'system'
  if (type === 'user/message') return 'user'
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  return type
}

/**
 * 会话全部事件的兼容读取：宿主 0.1.5 起 Session 移除了 `events` 属性
 * （`snapshotEvents()` / `eventAt()` 取代），旧宿主仍是数组属性——两个
 * 形状都接住，快照在下次 append 前有缓存，逐遍扫描的开销可接受。
 */
function eventsOf(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return Array.isArray(session.events) ? session.events : []
}

/** 会话是否有未收口的 turn（闲时才允许 surface replace，避免与运行中的 agent 竞态）。 */
function sessionBusy(session) {
  let lastStart = -1
  let lastEnd = -1
  for (const event of eventsOf(session)) {
    if (event.type === 'turn/start') lastStart = event.seq
    else if (event.type === 'turn/end') lastEnd = event.seq
  }
  return lastStart > lastEnd
}

/**
 * 当前 surface 投影成条目列表：seq 有序（模型可见顺序）、逐条文本、token 估算、
 * 时间、工具名（tool/result 按 callId 关联日志里的 tool/call）与注入来源。
 * 被此前 compaction/prune 影子化的节点本就不在 surface.nodes 里——列表即模型
 * 此刻真实可见的上下文。
 */
function projectContext(session) {
  const allEvents = eventsOf(session)
  const bySeq = new Map(allEvents.map((event) => [event.seq, event]))
  const toolNames = new Map()
  for (const event of allEvents) {
    if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') {
      toolNames.set(event.data.callId, typeof event.data.name === 'string' ? event.data.name : undefined)
    }
  }
  const entries = []
  let totalTokens = 0
  let mode = 'cl100k'
  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const text = entryText(event)
    const { tokens, mode: m } = countTokens(text)
    mode = m
    const usage = event.type === 'assistant/message' ? event.data.usage : undefined
    const source = event.type === 'user/message' && event.data.source && typeof event.data.source === 'object' ? event.data.source : undefined
    entries.push({
      seq,
      kind: entryKindOf(event.type),
      time: event.time,
      turn: typeof event.data.turn === 'number' ? event.data.turn : undefined,
      tool: event.type === 'tool/result' ? toolNames.get(event.data.message && event.data.message.source && event.data.message.source.callId) : undefined,
      sourceKind: source ? source.kind : undefined,
      sourceForm: source ? source.form : undefined,
      sourcePlugin: source ? source.plugin : undefined,
      chars: text.length,
      tokens,
      preview: text.length > 220 ? text.slice(0, 220) + '…' : text,
      usage: usage && typeof usage === 'object'
        ? { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens }
        : undefined,
    })
    totalTokens += tokens
  }
  return { entries, totalTokens, mode }
}

/** 选中 seq 按当前 surface 顺序分组成连续段（surface 上相邻才可一个 replace 覆盖）。 */
function groupRuns(surfaceNodes, wanted) {
  const index = new Map(surfaceNodes.map((seq, i) => [seq, i]))
  const unknown = wanted.filter((seq) => !index.has(seq))
  if (unknown.length > 0) throw new Error(`seqs not on current surface: ${unknown.join(', ')}`)
  const sorted = [...wanted].sort((a, b) => index.get(a) - index.get(b))
  const runs = []
  for (const seq of sorted) {
    const last = runs[runs.length - 1]
    if (last && index.get(seq) === index.get(last[last.length - 1]) + 1) last.push(seq)
    else runs.push([seq])
  }
  return runs
}

/**
 * surface node 0 若是系统提示词，宿主只允许它被另一条 `system/message` 单节点
 * 覆写（session `assertSystemHeadRewrite`）；任何以 node 0 起头的替换都会被拒：
 *   surface replace: node 0 holds the system prompt and may be rewritten only
 *   by a system/message over exactly that node
 * 剃刀一律用 user/message 标记来替换，所以系统提示词在这条协议下删不掉。
 *
 * 这条规则宿主只在 append 时才判，本地无法预检，因此必须在这里显式拦住——
 * 且必须排在 append 任何事件之前，否则 prune 先落盘就留下悬空计价。
 */
function assertSystemHeadUntouched(session, nodes, runs) {
  if (runs.length === 0 || runs[0][0] !== nodes[0]) return
  const head = eventsOf(session).find((event) => event.seq === nodes[0])
  if (head === undefined || head.type !== 'system/message') return
  throw new Error(
    '系统提示词（上下文第 1 条）不能删除：宿主只允许它被另一条 system/message 覆写，'
    + '而本插件的删除是以 user/message 标记替换整段。请改选其他条目。',
  )
}

/**
 * 把选中 seq 扩到工具配对边界，返回实际要删的 seq 集与"多选了哪些"。
 *
 * 宿主把"一个 step 的 tool-call 与其 tool/result 不可拆开"当作不变式：
 * 压缩引擎自己挑切口时会回退到平衡位置（compaction-basic 的
 * `compactRegion`），而折叠一个没有对应 tool-call 的 tool/result 会直接
 * 判为损坏。剃刀只按 surface 相邻分组，若用户只勾了 tool/result（本插件
 * 最典型的用法——按工具名筛出大块工具输出），配对就被拆开了。
 *
 * 所以这里向两侧扩到平衡切口，并把"多删了哪些"如实回给调用方，不静默多删。
 */
function expandToPairBoundaries(session, wanted, nodes) {
  const index = new Map(nodes.map((seq, i) => [seq, i]))
  const chosen = new Set()
  for (const seq of wanted) {
    if (!index.has(seq)) throw new Error(`seqs not on current surface: ${seq}`)
    chosen.add(seq)
  }
  const requested = new Set(chosen)
  if (toolPairing === null) {
    return { seqs: [...chosen].sort((a, b) => index.get(a) - index.get(b)), added: [], guard: 'unavailable' }
  }
  const balance = (side, seq) => {
    try {
      return toolPairing[side](session, seq)
    } catch (e) {
      // 宿主判定自身抛错 = surface 已经处在它认定为损坏的状态（多半是旧版
      // 插件拆过配对，或别的写入方越了界）。此时不能继续删除，如实报出。
      throw new Error(`宿主工具配对判定失败，会话 surface 可能已被损坏：${(e && e.message) || e}`)
    }
  }
  // 每次把不平衡的边界向外扩一格，直到所有段都落在平衡切口上。扩进来的
  // 节点可能与相邻段连成一段，所以每轮重新分组；判定收敛看的是"这一轮有没有
  // 真的变大"而不是轮数，所以不会空转。surface 整体是平衡的，因此必然收敛。
  for (let round = 0; round <= nodes.length + 1; round += 1) {
    const sizeAtStart = chosen.size
    for (const run of groupRuns(nodes, [...chosen])) {
      const first = run[0]
      const last = run[run.length - 1]
      if (!balance('before', first)) {
        const at = index.get(first)
        if (at === 0) throw new Error(`工具配对：seq ${first} 之前就是不平衡切口，无法扩到平衡边界`)
        chosen.add(nodes[at - 1])
      }
      if (!balance('after', last)) {
        const at = index.get(last)
        if (at === nodes.length - 1) throw new Error(`工具配对：seq ${last} 之后就是不平衡切口，无法扩到平衡边界`)
        chosen.add(nodes[at + 1])
      }
    }
    if (chosen.size === sizeAtStart) {
      const seqs = [...chosen].sort((a, b) => index.get(a) - index.get(b))
      return { seqs, added: seqs.filter((seq) => !requested.has(seq)), guard: 'host' }
    }
  }
  throw new Error('工具配对：无法把选中项扩到平衡边界（surface 可能已损坏）')
}

/**
 * prune 事件的计价来源。
 *
 * `shadowedTokenCount` 会被宿主的 surface 折叠（token-meter 的
 * `foldSurfaceProjection`）直接相减，而它给每条消息定价用的是固定的启发式
 * 估计器（chars/4 + 块/角色结构开销）。所以这个数只能是同一把尺子的结果
 * ——喂本插件界面展示用的 cl100k 数字会让宿主的上下文压力计量每次删除都
 * 漂移一截（同一段中文两者能差两位数）。
 *
 * 计量器不可用时（该行被 profile 关掉 / 尚未激活）退回 cl100k：此时也没有
 * 任何消费方会折叠这个数（折叠就写在那个包里），退回无害；所用来源会随
 * 响应回显，不留下"这次用的哪把尺子"的含糊。
 */
function pricingFor(ctx) {
  const meter = ctx && typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined
  if (meter && typeof meter.estimateMessage === 'function' && deriveEventMessage !== null) {
    return {
      source: 'tokenMeter',
      priceEvent(event) {
        const message = deriveEventMessage(event)
        return message === null ? 0 : meter.estimateMessage(message)
      },
    }
  }
  return {
    source: 'cl100k-fallback',
    priceEvent(event) { return countTokens(entryText(event)).tokens },
  }
}

/**
 * 执行一次裁剪：每个连续段一对事件（prune 计价 + notice 替换），协议形状
 * 与官方 dsh-compaction-tool-result-pruner 一致。
 *
 * 顺序有讲究：所有**可能抛错**的步骤（busy 检查、seq 归属、配对扩展、计价、
 * 标记消息构造）都排在第一条 append 之前。否则一旦替换那条被宿主拒掉，前
 * 面已经落盘的 prune 就成了悬空的计价声明——日志 append-only，撤不回来。
 *
 * @param session - 目标会话。
 * @param wantedSeqs - 用户勾选的 seq。
 * @param pricing - 计价来源（见 `pricingFor`）；缺省退回 cl100k。
 * @returns 实际删除条数、计价 token、每段范围，以及为保持工具配对而多删的 seq。
 */
function deleteEntries(session, wantedSeqs, pricing) {
  if (sessionBusy(session)) throw new Error('session is busy: wait for the running turn to finish')
  const nodes = [...session.surface.nodes]
  groupRuns(nodes, wantedSeqs)                       // 先做一次归属校验，错误信息保持原样
  const expanded = expandToPairBoundaries(session, wantedSeqs, nodes)
  const runs = groupRuns(nodes, expanded.seqs)       // 扩展后重新分段（相邻段会合并）
  assertSystemHeadUntouched(session, nodes, runs)    // 系统提示词不可删（宿主硬规则）
  const bySeq = new Map(eventsOf(session).map((event) => [event.seq, event]))
  const priceEvent = pricing && typeof pricing.priceEvent === 'function'
    ? pricing.priceEvent
    : (event) => countTokens(entryText(event)).tokens

  // 先把每一段要落的两个事件都算好，再统一 append——见上面的顺序说明。
  const planned = runs.map((run) => {
    const start = run[0]
    const end = run[run.length - 1]
    let runTokens = 0
    for (const seq of run) {
      const event = bySeq.get(seq)
      if (event !== undefined) runTokens += priceEvent(event)
    }
    return {
      run, start, end, runTokens,
      marker: createUserMessage({
        content: [{ type: 'text', text: `[context-razor] 此处原有 ${run.length} 条历史消息（约 ${runTokens} token）已被用户删除以保持上下文聚焦；如后续对话需要被删部分的细节，请向用户确认。` }],
        source: {
          kind: 'plugin',
          plugin: RAZOR_PLUGIN_NAME,
          form: 'notice',
          summary: `已删除 ${run.length} 条历史（约 ${runTokens} token）`,
        },
      }),
    }
  })

  const done = []
  let removed = 0
  let tokensRemoved = 0
  for (const { run, start, end, runTokens, marker } of planned) {
    session.append('compaction/prune', {
      shadowedRange: { start, end },
      shadowedSeqs: run,
      shadowedTokenCount: runTokens,
    })
    const replacement = session.append('user/message', marker, {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: run,
    })
    done.push({ start, end, count: run.length, tokens: runTokens, replacement: replacement.seq })
    removed += run.length
    tokensRemoved += runTokens
  }
  return {
    removed,
    tokensRemoved,
    runs: done,
    expanded: { seqs: expanded.added, guard: expanded.guard },
    pricing: (pricing && pricing.source) || 'cl100k-fallback',
  }
}

// ── 宿主包解析 ──────────────────────────────────────────────────────────
// 宿主的依赖装在它自己的 node_modules 里，从插件真实路径未必解析得到
// （pnpm 软链布局），故先沿 dsh 全局安装探测（skills-management 的
// schemastery 同款模式），再退标准 require。
function loadHostPackage(name) {
  const { createRequire } = require('node:module')
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, homedir()].filter(Boolean)) {
    const hostCopy = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')
    try {
      return createRequire(hostCopy)(hostCopy)
    } catch { /* 下一个来源 */ }
  }
  try {
    return require(`@deepseek-ai/${name}`)
  } catch { return null }
}

/** 替换消息构造优先用官方 createUserMessage（id/冻结与宿主一致），失败则手搓等价形状。 */
const hostLlm = loadHostPackage('dsh-llm')
const createUserMessage = typeof hostLlm?.createUserMessage === 'function'
  ? hostLlm.createUserMessage
  : (input) => ({ ...input, id: randomUUID(), role: 'user' })

/** 事件 → 派生消息（宿主实现）。仅用于给 prune 计价，缺则退回 cl100k。 */
const hostSession = loadHostPackage('dsh-session')
const deriveEventMessage = typeof hostSession?.deriveEventMessage === 'function'
  ? hostSession.deriveEventMessage
  : null

/**
 * 工具配对平衡判定。用宿主自己的实现（压缩引擎 `compactRegion` 用的是同一份），
 * 而不是本地重写一份 fold——重写就会随宿主演进漂移。
 * 解析不到时为 null，删除路径会跳过护栏并把这个事实回显给调用方。
 */
const hostCompaction = loadHostPackage('dsh-compaction')
const toolPairing = typeof hostCompaction?.toolPairingBalancedBefore === 'function'
  && typeof hostCompaction?.toolPairingBalancedAfter === 'function'
  ? { before: hostCompaction.toolPairingBalancedBefore, after: hostCompaction.toolPairingBalancedAfter }
  : null

module.exports = {
  name: 'context-razor',
  inject: ['sessions', 'webServer'],
  __internals: {
    countTokens, entryText, groupRuns, projectContext, sessionBusy, deleteEntries,
    expandToPairBoundaries, assertSystemHeadUntouched, pricingFor, usageMemo,
    hostGuards: { toolPairing: toolPairing !== null, deriveEventMessage: deriveEventMessage !== null },
  },

  apply(ctx) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/context-razor/api',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')
          const query = url.searchParams

          const sendJson = (status, payload) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(payload))
          }
          const readJsonBody = () => new Promise((resolve, reject) => {
            const chunks = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8')
              try { resolve(raw === '' ? {} : JSON.parse(raw)) } catch (e) { reject(e) }
            })
            req.on('error', reject)
          })
          const fail = (status, error) => sendJson(status, { error })

          // GET /context-razor/api/sessions → 会话清单（轻量，不算 token）
          if (req.method === 'GET' && apiPath.endsWith('/context-razor/api/sessions')) {
            const sessions = (ctx.sessions.list() || [])
              .map((session) => {
                const evs = eventsOf(session)
                return {
                  id: session.id,
                  cwd: session.header && session.header.cwd,
                  createdAt: session.header && session.header.createdAt,
                  lastTime: evs.length > 0 ? evs[evs.length - 1].time : undefined,
                  nodes: session.surface.nodes.length,
                  busy: sessionBusy(session),
                }
              })
              .sort((a, b) => String(b.lastTime || '').localeCompare(String(a.lastTime || '')))
            sendJson(200, { sessions })
            return
          }

          // GET /context-razor/api/context?session= → 逐条投影
          if (req.method === 'GET' && apiPath.endsWith('/context-razor/api/context')) {
            const session = ctx.sessions.get(query.get('session') || '')
            if (session === undefined) { fail(404, 'session not found'); return }
            const { entries, totalTokens, mode } = projectContext(session)
            sendJson(200, {
              id: session.id,
              cwd: session.header && session.header.cwd,
              busy: sessionBusy(session),
              encoder: mode,
              totalTokens,
              nodes: session.surface.nodes.length,
              entries,
              // 计价尺子与配对护栏各用了哪一份，随响应回显，便于事后核对。
              guards: {
                pricing: pricingFor(ctx).source,
                pairing: toolPairing === null ? 'unavailable' : 'host',
              },
            })
            return
          }

          // GET /context-razor/api/entry?session=&seq= → 单条全文
          if (req.method === 'GET' && apiPath.endsWith('/context-razor/api/entry')) {
            const session = ctx.sessions.get(query.get('session') || '')
            if (session === undefined) { fail(404, 'session not found'); return }
            const seq = Number(query.get('seq'))
            const event = eventsOf(session).find((candidate) => candidate.seq === seq)
            if (event === undefined) { fail(404, 'entry not found'); return }
            const text = entryText(event)
            const toolName = event.type === 'tool/result' && event.data.message
              ? eventsOf(session).find((candidate) => candidate.type === 'tool/call' && candidate.data.callId === event.data.message.source.callId)
              : undefined
            const source = event.type === 'user/message' && event.data.source && typeof event.data.source === 'object' ? event.data.source : undefined
            sendJson(200, {
              seq,
              kind: entryKindOf(event.type),
              time: event.time,
              tokens: countTokens(text).tokens,
              text,
              tool: toolName && typeof toolName.data.name === 'string' ? toolName.data.name : undefined,
              sourceKind: source ? source.kind : undefined,
              sourceForm: source ? source.form : undefined,
              sourcePlugin: source ? source.plugin : undefined,
            })
            return
          }

          // POST /context-razor/api/delete { session, seqs } → 精确裁剪
          if (req.method === 'POST' && apiPath.endsWith('/context-razor/api/delete')) {
            const body = await readJsonBody()
            const session = ctx.sessions.get(typeof body.session === 'string' ? body.session : '')
            if (session === undefined) { fail(404, 'session not found'); return }
            if (!Array.isArray(body.seqs) || body.seqs.length === 0 || !body.seqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)) {
              fail(400, 'body must provide seqs: non-empty safe-integer array'); return
            }
            try {
              const result = deleteEntries(session, body.seqs, pricingFor(ctx))
              sendJson(200, result)
            } catch (e) {
              fail(409, (e && e.message) || 'delete failed')
            }
            return
          }

          fail(404, `no route for ${req.method} ${apiPath}`)
        } catch (e) {
          const payload = JSON.stringify({ error: (e && e.message) || 'internal error' })
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(payload)
        }
      },
    }), 'context-razor: web api')
  },
}
