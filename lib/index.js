/**
 * 侧边助理 · host 侧实现。
 *
 * 提供三件事：
 * 1. `side_sessions`：列出其它会话（哪个是主会话、有没有在跑）。
 * 2. `side_peek`：读某个会话最近的对话进展，供「跟进一下」时汇总。
 * 3. `side_deliver`：把整理好的需求投递给主会话，并唤醒它。
 *
 * 投递为什么走 `agent.followup`：跨独立会话写消息没有现成 Service
 * （`ctx.subagents.sendMessage` 只允许同一 subagent tree 的成员），
 * 而 `ctx.agents.get(sessionId)` 拿到 live Agent 后 `followup` 是受支持的
 * 「排队一轮普通 turn 并唤醒」通道。消息 source 用 `agent-message` + `relay`，
 * 与 dsh-subagent 给子 agent 传话的既有约定一致，前端会渲染成「来自会话 xxxx」。
 *
 * @module @local/dsh-side-assistant
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

/**
 * 本插件**不 import 任何 `@deepseek-ai/*` 包**：out-of-tree 插件的裸包名解析基准不在
 * profile 里，`import { defineTool } from '@deepseek-ai/dsh-tools'` 会让整个插件
 * 在 import 阶段失败（症状是模式选择器里那张卡片「加载失败」）。
 * 所以这里自带一个等价的轻量构造器：只做隐式 object 根 + 每属性 `required: true`
 * 到标准 JSON Schema 的转换，产出 `ToolDefinition` 需要的形状
 * （`{ name, description, parameters, output: { schema, render }, execute }`）。
 */
function toSchema(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(toSchema)
  const out = {}
  const required = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && typeof value === 'boolean') continue
    if (key === 'properties' && value !== null && typeof value === 'object') {
      const properties = {}
      for (const [name, child] of Object.entries(value)) {
        const { required: isRequired, ...rest } = child ?? {}
        properties[name] = toSchema(rest)
        if (isRequired === true) required.push(name)
      }
      out.properties = properties
      continue
    }
    if (key === 'items') {
      out.items = toSchema(value)
      continue
    }
    out[key] = toSchema(value)
  }
  if (required.length > 0) out.required = required
  return out
}

/** `defineTool` 的等价物（见上面 toSchema 的说明）。 */
function defineLocalTool({ name, description, parameters, output, execute }) {
  return {
    name,
    description,
    parameters: toSchema({ type: 'object', properties: parameters ?? {}, additionalProperties: false }),
    output: { schema: toSchema(output.schema), render: output.render },
    execute,
  }
}

/**
 * 诊断日志：默认不写任何文件。设置环境变量 `DSH_SIDE_ASSISTANT_DEBUG` 后才启用——
 * 值为 `1` 时写到系统临时目录下的 `dsh-side-assistant-debug.log`，也可以是明确的文件路径。
 */
const DEBUG_TARGET = process.env.DSH_SIDE_ASSISTANT_DEBUG ?? ''

function probe(message) {
  if (DEBUG_TARGET === '' || DEBUG_TARGET === '0') return
  try {
    const target = DEBUG_TARGET === '1'
      ? `${process.env.TEMP ?? process.env.TMPDIR ?? '.'}/dsh-side-assistant-debug.log`
      : DEBUG_TARGET
    appendFileSync(target, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

export const name = 'dsh-side-assistant'

/** `sessionQuery` 读会话、`agents` 拿 live Agent、`tools` 注册工具、`webServer` 收绑定。 */
export const inject = ['tools', 'sessionQuery', 'agents', 'agentPresets', 'webServer']

/**
 * 侧边会话 → 它是由哪个主会话打开的。
 *
 * 浏览器侧 `ctx.sessions.create` 只接受 `{ workspaceId, cwd, sessionId, agentPreset }`，
 * 宿主侧 `ApiSessionCreateRequest` 也只读 `cwd`/`agentPreset`，所以「我是从哪个会话点开的」
 * 没有任何现成通道能带到宿主。这里用插件自己的 HTTP 路由接一张绑定表：面板每次打开时
 * POST 一次，工具执行时按自己的会话 id 查这张表。
 */
const bindings = new Map()

/** 已注册过工具的 agent（reload 后 apply 会重跑，避免重复注册报错）。 */
const registered = new WeakSet()

const BIND_PATH = '/api/dsh-side-assistant/bind'

/** 工具返回里给用户看的短 id。 */
function short(id) {
  return String(id).slice(0, 8)
}

/** 把一条消息的 content 压成纯文本；图片和工具调用做占位。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push('[图片]')
    } else if (block.type === 'tool-call' || block.type === 'tool_call') {
      parts.push(`[调用 ${String(block.name ?? block.toolName ?? '?')}]`)
    }
  }
  return parts.join('\n').trim()
}

/** 按字符数截断，避免把整段对话塞进上下文。 */
function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 本地时间 HH:mm。 */
function clockOf(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return '--:--'
  const d = new Date(time)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 取一次「能用的服务」。
 *
 * 插件 reload（profile 里 disable→enable）会销毁旧的 fiber ctx，闭包里那个 `ctx`
 * 立刻变成 inactive，再访问就是
 * `cannot get required service "sessionQuery" in inactive context`。
 * 服务对象本身属于别的插件、跨 reload 一直存活，所以注册时先把它们抓出来；
 * 执行时优先用 `exec.agent.ctx`（agent 活着就一定能解析）现场取，失败再回退到抓下来的那份。
 */
function servicesFor(exec, fallback) {
  try {
    const agentCtx = exec?.agent?.ctx
    if (agentCtx !== undefined && agentCtx !== null) {
      const sessionQuery = agentCtx.sessionQuery
      const agents = agentCtx.agents
      if (sessionQuery !== undefined && agents !== undefined) return { sessionQuery, agents }
    }
  } catch {}
  return fallback
}

/** 某个侧边会话绑定的主会话 id（面板打开时通过路由写入）。 */
function boundSessionOf(sessionId) {
  return sessionId === undefined || sessionId === null ? undefined : bindings.get(sessionId)
}

/** 会话标题；没有标题事件时返回 null。 */
async function titleOf(svc, sessionId) {
  try {
    // readTitleSnapshot → SessionTitleObservation { session, title?: SessionTitleSnapshot }
    const observation = await svc.sessionQuery.readTitleSnapshot(sessionId)
    const title = observation?.title?.title
    return typeof title === 'string' && title.length > 0 ? title : null
  } catch {
    return null
  }
}

/** 会话的一句话标识，方便模型在回话里引用。`bound` = 侧边面板是从这个会话打开的。 */
function describe(record, title, ownCwd, boundSessionId) {
  const sameCwd = ownCwd !== undefined && record.header.cwd === ownCwd
  return {
    sessionId: record.header.id,
    shortId: short(record.header.id),
    title: title ?? '(无标题)',
    live: record.live,
    sameWorkspace: sameCwd,
    cwd: record.header.cwd ?? null,
    createdAt: record.header.createdAt,
    subagent: record.header.origin === 'subagent',
    bound: record.header.id === boundSessionId,
  }
}

/**
 * 解析要操作的目标会话。
 * @param ctx 插件上下文
 * @param exec 工具执行上下文（拿 self session 的 id 与 cwd）
 * @param hint 用户/模型给的会话 id 前缀或标题片段
 */
async function resolveSession(svc, exec, hint) {
  const selfSession = exec.agent?.session
  const selfId = selfSession?.id
  const ownCwd = selfSession?.header?.cwd ?? selfSession?.cwd ?? process.cwd()
  const records = (await svc.sessionQuery.listSessions()).filter(record => record.header.id !== selfId)

  if (typeof hint === 'string' && hint.trim().length > 0) {
    const wanted = hint.trim()
    const byId = records.find(record => record.header.id === wanted)
    if (byId !== undefined) return byId
    const byPrefix = records.filter(record => record.header.id.startsWith(wanted)
      || record.header.id.replaceAll('-', '').startsWith(wanted.replaceAll('-', '')))
    if (byPrefix.length === 1) return byPrefix[0]
    if (byPrefix.length > 1) {
      throw new Error(`会话 id 前缀「${wanted}」匹配到 ${byPrefix.length} 个会话，请给更长的前缀。`)
    }
    const byTitle = []
    for (const record of records.slice(0, 25)) {
      const title = await titleOf(svc, record.header.id)
      if (title !== null && title.includes(wanted)) byTitle.push(record)
    }
    if (byTitle.length > 0) return byTitle[0]
    throw new Error(`没找到匹配「${wanted}」的会话。先调用 side_sessions 看看现有会话的 id 和标题。`)
  }

  // 绑定优先：面板是从哪个会话点开的，就默认操作哪个会话。
  const bound = boundSessionOf(selfId)
  if (bound !== undefined) {
    const owned = records.find(record => record.header.id === bound)
    if (owned !== undefined) return owned
  }

  // 兜底：同工作区、非子会话、正在运行的会话里最新的那个。
  const primary = records.filter(record => record.header.origin !== 'subagent')
  const pool = primary.length > 0 ? primary : records
  const sameWorkspace = pool.filter(record => record.header.cwd === ownCwd)
  const scoped = sameWorkspace.length > 0 ? sameWorkspace : pool
  const live = scoped.filter(record => record.live)
  const picked = (live.length > 0 ? live : scoped)[0]
  if (picked === undefined) {
    throw new Error('没有找到其它会话：请先打开一个主会话，再回到侧边会话重试。')
  }
  return picked
}

/** 深度冻结：消息一经发布就是不可变快照（核心库的 createMessage 同样这么做）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** 构造一条「另一个 agent 发来的消息」。 */
function relayMessage(senderSessionId, note, text) {
  const blocks = []
  if (typeof note === 'string' && note.trim().length > 0) blocks.push({ type: 'text', text: `${note.trim()}\n` })
  blocks.push({ type: 'text', text })
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: blocks,
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  })
}

/**
 * 工具参数预览。`tool/call` 里的 `arguments` 是 JSON 字符串，
 * 这里压成一行、截短，避免把整段 patch 塞进摘要。
 */
function previewOf(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text.length === 0) return ''
    try {
      return JSON.stringify(JSON.parse(text))
    } catch {
      return text
    }
  }
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

/**
 * 本轮结束原因的短标签。`turn/end` 的 reason 是对象
 * （`{kind:'completed'}` / `{kind:'aborted', reason:{kind:'user'}}` / …），不是字符串。
 */
function describeTurnEnd(reason) {
  if (typeof reason === 'string') return reason
  if (reason === null || typeof reason !== 'object') return '?'
  const kind = typeof reason.kind === 'string' ? reason.kind : '?'
  if (kind === 'aborted') {
    const cause = reason.reason
    const causeKind = typeof cause === 'string' ? cause : cause?.kind
    return typeof causeKind === 'string' ? `aborted/${causeKind}` : 'aborted'
  }
  if (kind === 'error') {
    const message = reason.error?.message
    return typeof message === 'string' && message.length > 0 ? `error/${clip(message, 120)}` : 'error'
  }
  return kind
}

/**
 * 把一个会话的原始事件压成「谁说了什么」的进展摘要。
 * 只保留对话主线：用户发言、助手发言、工具调用名、本轮结束原因。
 */
function renderDigest(events, limit) {
  const lines = []
  for (const event of events) {
    const data = event?.data
    switch (event?.type) {
      case 'user/message': {
        const kind = data?.source?.kind
        const text = textOf(data?.content)
        if (text.length === 0) break
        if (kind === 'agent-message') {
          lines.push(`${clockOf(event.time)} 侧边助理 →: ${clip(text, 600)}`)
        } else if (kind === undefined || kind === 'user') {
          lines.push(`${clockOf(event.time)} 我 →: ${clip(text, 600)}`)
        }
        // 其它 source.kind（注入的上下文、技能、快照）不算对话主线，跳过。
        break
      }
      case 'assistant/message': {
        const text = textOf(data?.message?.content)
        if (text.length > 0) lines.push(`${clockOf(event.time)} 主会话: ${clip(text, 600)}`)
        break
      }
      case 'tool/call': {
        const toolName = data?.name ?? data?.call?.name ?? data?.toolName
        if (typeof toolName === 'string') {
          const raw = data?.arguments ?? data?.call?.arguments ?? data?.args
          const preview = raw === undefined ? '' : ` ${clip(previewOf(raw), 160)}`
          lines.push(`${clockOf(event.time)}   · 调用 ${toolName}${preview}`)
        }
        break
      }
      case 'turn/end': {
        lines.push(`${clockOf(event.time)}   · 本轮结束（${describeTurnEnd(data?.reason)}）`)
        break
      }
      default:
        break
    }
  }
  return lines.length <= limit ? lines : lines.slice(-limit)
}

/** 最近一条事件的时间，用作「最后活动」参考。 */
function lastActivityOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const time = events[index]?.time
    if (typeof time === 'number' && Number.isFinite(time)) return time
  }
  return null
}

export function apply(ctx) {
  probe('apply start')

  // 收绑定：面板打开时把「侧边会话 id → 主会话 id」推到这张表里。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BIND_PATH,
    handler: async (req, res) => {
      const send = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'GET') {
        // 只读回显，供排查「绑定到底有没有生效」。
        let query
        try {
          query = new URL(req.url ?? '', 'http://localhost').searchParams
        } catch {
          query = new URLSearchParams()
        }
        const assistantSessionId = query.get('assistantSessionId')
        const originSessionId = assistantSessionId === null ? undefined : bindings.get(assistantSessionId)
        return send(200, {
          ok: true,
          ...(assistantSessionId === null ? {} : { assistantSessionId }),
          ...(originSessionId === undefined ? {} : { originSessionId }),
        })
      }
      if (req.method !== 'POST') return send(405, { ok: false, error: 'use POST' })
      let raw = ''
      try {
        for await (const chunk of req) raw += chunk
        const parsed = JSON.parse(raw)
        const assistantSessionId = parsed?.assistantSessionId
        const originSessionId = parsed?.originSessionId
        if (typeof assistantSessionId !== 'string' || typeof originSessionId !== 'string') {
          return send(400, { ok: false, error: 'assistantSessionId and originSessionId are required' })
        }
        bindings.set(assistantSessionId, originSessionId)
        return send(200, { ok: true })
      } catch (error) {
        return send(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'side-assistant: binding route')

  const start = (agent) => {
    if (agent === undefined || registered.has(agent)) return
    let preset
    try {
      preset = agent.options?.agentPreset ?? ctx.agentPresets.presetForSession(agent.session)
    } catch (error) {
      probe(`preset lookup failed: ${error?.message ?? error}`)
      return
    }
    probe(`agent/created preset=${String(preset)} id=${agent.session?.header?.id}`)
    if (preset !== PRESET_ID) return
    registered.add(agent)
    try {
      registerTools(agent.ctx, ctx)
    } catch (error) {
      // 同一个 agent 上重复注册会抛错：不影响别的会话，记下来即可。
      probe(`tool registration failed: ${error?.message ?? error}`)
    }
  }

  ctx.on('agent/created', (payload) => { start(payload?.agent) })

  // reload 之后已存在的侧边会话不会再触发 `agent/created`：补注册一遍。
  try {
    for (const agent of ctx.agents.list()) start(agent)
  } catch (error) {
    probe(`rescan failed: ${error?.message ?? error}`)
  }
}

/** 只在侧边助理的会话里注册这三个工具（借用该 agent 自己的 ctx 以限定作用域）。 */
const PRESET_ID = 'side-assistant'

function registerTools(toolsCtx, host) {
  // 见 servicesFor：注册时抓一份服务，reload 后这份仍然是活的。
  const fallback = { sessionQuery: host.sessionQuery, agents: host.agents }
  toolsCtx.tools.register(defineLocalTool({
    name: 'side_sessions',
    description: '列出除当前会话以外的会话（主会话候选），用于确认「发给哪个主会话」。返回每个会话的 id、短 id、标题、是否正在运行、是否同一工作区。',
    parameters: {
      limit: {
        type: 'number',
        description: '最多列几个会话，默认 10。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          currentSessionId: { type: 'string', required: true },
          boundSessionId: { type: 'string' },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                shortId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                live: { type: 'boolean', required: true },
                sameWorkspace: { type: 'boolean', required: true },
                cwd: { type: 'string' },
                createdAt: { type: 'number', required: true },
                subagent: { type: 'boolean', required: true },
                bound: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 30) : 10
      const svc = servicesFor(exec, fallback)
      const selfSession = exec.agent?.session
      const selfId = selfSession?.id ?? ''
      const ownCwd = selfSession?.header?.cwd ?? selfSession?.cwd ?? process.cwd()
      const boundId = boundSessionOf(selfId)
      const records = (await svc.sessionQuery.listSessions()).filter(record => record.header.id !== selfId)
      const picked = records.slice(0, limit)
      const sessions = []
      for (const record of picked) {
        sessions.push(describe(record, await titleOf(svc, record.header.id), ownCwd, boundId))
      }
      return {
        currentSessionId: selfId,
        ...boundId === undefined ? {} : { boundSessionId: boundId },
        sessions,
      }
    },
  }))

  toolsCtx.tools.register(defineLocalTool({
    name: 'side_peek',
    description: '读主会话最近的对话进展：用户说了什么、它答了什么、调用了哪些工具、每轮怎么结束的。用于回答「跟进一下」。不投递任何消息。',
    parameters: {
      session: {
        type: 'string',
        description: '目标会话 id、id 前缀或标题片段；省略时取同一工作区里最近活跃的主会话。',
      },
      limit: {
        type: 'number',
        description: '最多看最近多少条主线（默认 40）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          shortId: { type: 'string', required: true },
          title: { type: 'string' },
          live: { type: 'boolean', required: true },
          lastActivity: { type: 'number' },
          digest: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 40
      const svc = servicesFor(exec, fallback)
      const record = await resolveSession(svc, exec, args.session)
      const snapshot = await svc.sessionQuery.readSession(record.header.id)
      const title = await titleOf(svc, record.header.id)
      return {
        sessionId: record.header.id,
        shortId: short(record.header.id),
        ...title === null ? {} : { title },
        live: record.live,
        ...lastActivityOf(snapshot.events) === null ? {} : { lastActivity: lastActivityOf(snapshot.events) },
        digest: renderDigest(snapshot.events, limit),
      }
    },
  }))

  toolsCtx.tools.register(defineLocalTool({
    name: 'side_deliver',
    description: '把整理好的需求投递给主会话并唤醒它（投递后主会话会当成一条用户消息开始/继续干活）。session 省略时取同一工作区里最近活跃的主会话。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要投递的需求正文。写清楚目标、做到什么程度、哪些东西要保留。',
      },
      note: {
        type: 'string',
        description: '可选的一行抬头，例如「侧边助理转达：用户在侧边会话里整理好的需求」。',
      },
      session: {
        type: 'string',
        description: '目标会话 id、id 前缀或标题片段；省略时自动选。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
          shortId: { type: 'string', required: true },
          title: { type: 'string' },
          running: { type: 'boolean' },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (text.length === 0) throw new Error('text 不能为空：先把要发的话写清楚再投递。')
      const sender = exec.agent?.session
      if (sender === undefined) throw new Error('当前没有会话身份，无法投递。')

      const svc = servicesFor(exec, fallback)
      const record = await resolveSession(svc, exec, args.session)
      const target = svc.agents.get(record.header.id)
      if (target === undefined) {
        throw new Error(`会话「${short(record.header.id)}」当前不是 live 会话（可能已关闭或只是历史记录）。`
          + '请在侧栏打开它，或先用 side_sessions 换一个正在运行的会话。')
      }
      const running = target.status === 'running'
      target.followup(relayMessage(sender.id, args.note, text))
      // Read the title only after the message is on its way: a lookup failure must
      // never make a delivered message look like a failed one.
      const title = await titleOf(svc, record.header.id)
      return {
        delivered: true,
        sessionId: record.header.id,
        shortId: short(record.header.id),
        ...title === null ? {} : { title },
        running,
        summary: running
          ? `已投递给会话「${title ?? short(record.header.id)}」，它当前正在干活，这条会在它这一轮结束后接着处理。`
          : `已投递给会话「${title ?? short(record.header.id)}」，并唤醒它开始处理。`,
      }
    },
  }))
}
