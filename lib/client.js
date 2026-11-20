/**
 * Right-Sidebar chat panel for the side assistant preset.
 *
 * Mirrors the shipped subagent chat tab: one resource protocol, one Sidebar tab
 * type, and a tab body that hosts the shared `sidebar.chat.conversation` seat.
 * The seat's occupant is registered here too, because the shipped subagent
 * plugin that normally provides it is not part of every profile.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-side-assistant',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PROTOCOL = 'sideassistant'
    const ADDRESS_PREFIX = 'dsh-resource://sideassistant/session/'
    const TAB_ID = 'side-assistant-chat'
    const PRESET_ID = 'side-assistant'
    const LABEL = '侧边助理'

    /** The one side-assistant session this browser window reuses once created. */
    let currentSession
    /** Sessions known to run the side-assistant preset, so their header hides the entry. */
    const known = new Set()
    /** The plugin Context captured by `apply`, for handlers outside the Context tree. */
    let root

    /** localStorage key: main Session id -> the side-assistant Session opened beside it. */
    const ORIGIN_MAP_KEY = 'dsh-side-assistant.origins.v1'
    /** Host route that tells the tools which Session the panel was opened from. */
    const BIND_ENDPOINT = '/api/dsh-side-assistant/bind'
    const PANEL_ENDPOINT = '/api/dsh-side-assistant/panel'
    /** id of the stylesheet that hides the finished dot on panel Sessions' rows. */
    const DOT_STYLE_ID = 'dsh-side-assistant-quiet-dots'
    /** localStorage key: '1' shows panel Sessions in the Workspace list; anything else hides them. */
    const SHOW_ROWS_KEY = 'dsh-side-assistant.show-rows.v1'

    /**
     * Whether panel Sessions should appear in the Workspace list.
     *
     * Hiding is the default because these Sessions are an implementation detail of
     * the panel, but the list is the user's surface: a switch in the panel keeps the
     * choice theirs instead of hard-coding it in a stylesheet.
     * @returns {boolean} true when the user asked to see them.
     */
    function showsRows() {
      try {
        return window.localStorage.getItem(SHOW_ROWS_KEY) === '1'
      } catch {
        return false
      }
    }

    /**
     * Record the list-visibility choice and repaint the stylesheet.
     * @param {boolean} show - true to list panel Sessions again.
     */
    function setShowsRows(show) {
      try {
        window.localStorage.setItem(SHOW_ROWS_KEY, show ? '1' : '0')
      } catch {
        // A blocked storage still toggles the current window through the stylesheet.
      }
      syncQuietDots()
    }

    /**
     * Read the remembered "opened from" pairs.
     * @returns {Record<string, string>} main Session id -> panel Session id.
     */
    function readOriginMap() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(ORIGIN_MAP_KEY) ?? '{}')
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    /**
     * Remember one "opened from" pair.
     * @param {string} originSessionId - main Session the panel was opened from.
     * @param {string} assistantSessionId - panel Session id.
     */
    function writeOriginMap(originSessionId, assistantSessionId) {
      const map = readOriginMap()
      map[originSessionId] = assistantSessionId
      try {
        window.localStorage.setItem(ORIGIN_MAP_KEY, JSON.stringify(map))
      } catch {}
    }

    /**
     * Tell the Host which Session the panel belongs to: the tools have no other way
     * to learn it (`sessions.create` carries only cwd and preset).
     * @param {string} assistantSessionId - panel Session id.
     * @param {string} originSessionId - Session the panel was opened from.
     * @returns {Promise<void>} settlement; failures are non-fatal.
     */
    async function bindOnHost(assistantSessionId, originSessionId) {
      try {
        await fetch(BIND_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ assistantSessionId, originSessionId }),
        })
      } catch {}
    }

    /**
     * The main Session this panel Session was opened from, as remembered locally.
     * @param {string} assistantSessionId - panel Session id.
     * @returns {string | undefined} main Session id.
     */
    function originOf(assistantSessionId) {
      for (const [origin, assistant] of Object.entries(readOriginMap())) {
        if (assistant === assistantSessionId) return origin
      }
      return undefined
    }

    /** Every panel Session this browser knows about, current and remembered. */
    function quietSessions() {
      const ids = new Set(known)
      for (const assistant of Object.values(readOriginMap())) ids.add(assistant)
      return [...ids]
    }

    /**
     * Keep the panel Sessions out of the Workspace tree and off its finished dot,
     * unless the user asked to list them.
     *
     * Two problems, one stylesheet. DSH marks a Session `completionUnread` when it
     * stops running while nothing retains it as `mainView`, and the row turns that
     * into the green "done" dot; holding `mainView` from here suppresses the dot but
     * also adds a second candidate to "which Session is current", which froze the
     * main column on the panel Session. So the dot and the row itself are hidden by
     * attribute instead: rows carry `data-row-key="session:<id>"`, the dot is
     * `[data-state="done"]` inside them. Showing the rows drops only the row rule —
     * the dot stays off, since a listed panel Session still is not a conversation
     * the user has to be recalled to.
     */
    function syncQuietDots() {
      if (typeof document === 'undefined') return
      const listed = showsRows()
      const rules = quietSessions()
        .map((id) => (listed
          ? `[data-row-key="session:${id}"] [data-state="done"]{display:none}`
          : `[data-row-key="session:${id}"]{display:none}`))
        .join('\n')
      let node = document.getElementById(DOT_STYLE_ID)
      if (node === null) {
        node = document.createElement('style')
        node.id = DOT_STYLE_ID
        document.head.appendChild(node)
      }
      if (node.textContent !== rules) node.textContent = rules
    }

    /**
     * Drop the row-dot stylesheet; the owning fiber is unloading.
     */
    function disposeQuietDots() {
      if (typeof document === 'undefined') return
      document.getElementById(DOT_STYLE_ID)?.remove()
    }

    /**
     * Parse one side-assistant resource address.
     * @param {string} value - possible resource address.
     * @returns {string | undefined} the encoded session id, or undefined.
     */
    function parseAddress(value) {
      let url
      try {
        url = new URL(value)
      } catch {
        return undefined
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== PROTOCOL) return undefined
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return undefined
      try {
        return decodeURIComponent(parts[1])
      } catch {
        return undefined
      }
    }

    /**
     * Canonical address of one side-assistant session.
     * @param {string} sessionId - session identity.
     * @returns {string} resource address.
     */
    function addressOf(sessionId) {
      return `${ADDRESS_PREFIX}${encodeURIComponent(sessionId)}`
    }

    /**
     * Resolve after the occurrence is cancelled.
     * @param {AbortSignal} signal - occurrence lifetime.
     * @returns {Promise<void>} settlement.
     */
    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve()
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }

    /**
     * Resource provider holding one Session reference per open tab.
     * @param {object} sessions - Client Sessions service.
     * @returns {object} provider.
     */
    function provider(sessions) {
      return {
        protocol: PROTOCOL,
        async *open(resourceAddress, { signal }) {
          const sessionId = parseAddress(resourceAddress)
          if (sessionId === undefined) throw new Error(`side-assistant: invalid address "${resourceAddress}"`)
          if (signal.aborted) return
          known.add(sessionId)
          syncQuietDots()
          const reference = sessions.retain(sessionId, { source: 'sideAssistantChat', signal })
          try {
            yield { ok: true, value: { sessionId, reference } }
            await waitForAbort(signal)
          } finally {
            reference.release()
          }
        },
      }
    }

    /**
     * Workspace that owns a Session, so the panel's Session lands beside it
     * instead of on the Workspace picker.
     * @param {object} ctx - Client root.
     * @param {string} [fromSessionId] - Session whose Workspace is inherited.
     * @returns {{workspaceId: string, path: string} | undefined} owning Workspace.
     */
    function workspaceOf(ctx, fromSessionId) {
      if (fromSessionId === undefined) return undefined
      const workspaces = ctx.get('workspaces')
      if (workspaces === undefined) return undefined
      const items = workspaces.list.getSnapshot().items
      const owner = items.find((item) => item.sessionIds.includes(fromSessionId))
      return owner === undefined ? undefined : { workspaceId: owner.workspaceId, path: owner.path }
    }

    /**
     * Reuse the panel Session remembered for this origin, or create one beside it.
     *
     * One panel per main Session: a Session never borrows the panel of another, so
     * opening the entry beside a fresh Session starts its own blank assistant
     * instead of dragging the previous conversation along.
     * @param {object} ctx - Client root.
     * @param {string} [fromSessionId] - Session whose placement the new one inherits.
     * @returns {Promise<string>} session id.
     */
    async function ensureSession(ctx, fromSessionId) {
      const state = ctx.sessions.list.getSnapshot()
      if (fromSessionId !== undefined) {
        const remembered = readOriginMap()[fromSessionId]
        if (remembered !== undefined && state.byId[remembered] !== undefined) {
          currentSession = remembered
          return remembered
        }
        const created = await createBeside(ctx, fromSessionId)
        known.add(created)
        syncQuietDots()
        writeOriginMap(fromSessionId, created)
        currentSession = created
        await bindOnHost(created, fromSessionId)
        return created
      }
      if (currentSession !== undefined && state.byId[currentSession] !== undefined) return currentSession
      for (const id of state.ids) {
        if (known.has(id)) {
          currentSession = id
          return id
        }
      }
      const created = await createBeside(ctx, fromSessionId)
      known.add(created)
      syncQuietDots()
      currentSession = created
      return created
    }

    /**
     * Ask the Host for the panel's Session.
     *
     * The Host creates it inside its own Workspace (`%USERPROFILE%\.dsh\side-assistant`).
     * That matters: DSH's "new conversation" reuses the first *blank* Session of the
     * Workspace it lands in, so a panel Session living in the user's Workspace would be
     * adopted whenever the user asked for a new conversation — including unsent drafts.
     * @param {object} ctx - Client root.
     * @param {string} [fromSessionId] - Session the panel opens beside.
     * @returns {Promise<string | undefined>} the created Session, or undefined on failure.
     */
    async function createInHostWorkspace(ctx, fromSessionId) {
      try {
        const response = await fetch(PANEL_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ originSessionId: fromSessionId ?? null }),
        })
        if (!response.ok) return undefined
        const payload = await response.json()
        return typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Create (or let the Host reuse) the panel's Session.
     *
     * Prefers the Host's own Workspace; only when that route is unavailable does it
     * fall back to the on-screen Session's Workspace (which costs the reuse caveat
     * documented on {@link createInHostWorkspace}).
     * @param {object} ctx - Client root.
     * @param {string} [fromSessionId] - Session the panel opens beside.
     * @returns {Promise<string>} the panel Session.
     */
    async function createBeside(ctx, fromSessionId) {
      const created = await createInHostWorkspace(ctx, fromSessionId)
      if (created !== undefined && created !== fromSessionId) return created

      const workspace = workspaceOf(ctx, fromSessionId)
      if (workspace !== undefined) {
        const uiWorkspace = ctx.get('uiWorkspace')
        if (uiWorkspace !== undefined) {
          const connected = await uiWorkspace.connectWorkspace(workspace.workspaceId, { agentPreset: PRESET_ID })
          // Never reuse the on-screen Session itself as the panel.
          if (connected !== fromSessionId) return connected
        }
      }
      const cwd = workspace === undefined ? undefined : workspace.path
      return ctx.sessions.create({
        agentPreset: PRESET_ID,
        ...(cwd === undefined ? {} : { cwd }),
      })
    }

    /**
     * Start the panel over: a fresh, blank Session beside the same main Session.
     *
     * DSH offers no way to erase a Session's log, so "clear" means "move the panel
     * to a new Session and rebind it": the conversation empties, and the previous
     * Session stays in the Session list.
     * @param {object} ctx - Client root.
     * @param {string} fromSessionId - main Session the panel belongs to.
     * @param {string} [tabId] - tab replaced in place, so the panel does not duplicate.
     * @returns {Promise<void>} settlement after the replacement is requested.
     */
    async function clearConversation(ctx, fromSessionId, tabId) {
      let fresh = await createBeside(ctx, fromSessionId)
      if (fresh === fromSessionId) {
        // The panel Session itself was still blank, so the Host reused it: create outright.
        const workspace = workspaceOf(ctx, fromSessionId)
        fresh = await ctx.sessions.create({
          agentPreset: PRESET_ID,
          ...(workspace === undefined ? {} : { cwd: workspace.path }),
        })
      }
      known.add(fresh)
      syncQuietDots()
      currentSession = fresh
      writeOriginMap(fromSessionId, fresh)
      await bindOnHost(fresh, fromSessionId)
      ctx.sidebarRight.openResource(addressOf(fresh), {
        kind: PROTOCOL,
        ...(tabId === undefined ? {} : { replaceTab: tabId }),
      })
    }

    /**
     * Open the side-assistant chat beside the on-screen session.
     * @param ctx - Client root captured by `apply`.
     * @param {string} [fromSessionId] - Session the panel opens beside.
     * @returns {Promise<void>} settlement after the tab is requested.
     */
    async function openSideAssistant(ctx, fromSessionId) {
      const id = await ensureSession(ctx, fromSessionId)
      currentSession = id
      if (fromSessionId !== undefined && fromSessionId !== id) {
        writeOriginMap(fromSessionId, id)
        await bindOnHost(id, fromSessionId)
      }
      ctx.sidebarRight.openResource(addressOf(id), { kind: PROTOCOL, revealIfOpened: true })
    }

    /**
     * Sidebar tab body: one toolbar row over the shared Conversation seat.
     *
     * The row is drawn here rather than in a tab header because the Right Sidebar
     * exposes no header slot for chat tabs.
     */
    function SideAssistantTab({ sessionId, useResource, useTabInfo, useWorkspaces, SessionProvider, renderSlot }) {
      const { tab } = useTabInfo()
      const resource = useResource(tab.contentId)
      const panelId = parseAddress(String(tab.contentId ?? ''))
      // The Session whose conversation is on screen: the panel belongs to it, and a
      // tab restored from an older layout may still point at another Session's panel.
      const besideId = sessionId
      const [armed, setArmed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [listed, setListed] = React.useState(() => showsRows())
      const [error, setError] = React.useState(undefined)
      // An archived Session is refused by the Host's archived-session gate: every turn
      // ends `blocked` with no reply. Surface it here, because the panel still accepts
      // typing and the conversation just looks dead otherwise.
      const archivedIds = useWorkspaces((state) => state.archivedSessionIds)
      const archived = panelId !== undefined && Array.isArray(archivedIds) && archivedIds.includes(panelId)
      // Re-announce the binding whenever the panel shows up: a plugin reload empties
      // the Host table, and the host tools fall back to guessing without it.
      React.useEffect(() => {
        if (panelId === undefined) return
        const origin = originOf(panelId)
        if (origin === undefined) return
        void bindOnHost(panelId, origin)
      }, [panelId])
      // One panel per main Session: retarget a tab that belongs to another Session.
      React.useEffect(() => {
        if (panelId === undefined || besideId === undefined) return undefined
        if (originOf(panelId) === besideId) return undefined
        let cancelled = false
        Promise.resolve(ensureSession(root, besideId))
          .then((id) => {
            if (cancelled || id === panelId) return
            root.sidebarRight.openResource(addressOf(id), { kind: PROTOCOL, replaceTab: tab.id })
          })
          .catch((cause) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
          })
        return () => { cancelled = true }
      }, [panelId, besideId, tab.id])
      // A pending confirmation lapses, so a later stray click cannot erase a chat.
      React.useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => { setArmed(false) }, 4000)
        return () => { clearTimeout(timer) }
      }, [armed])
      const onClear = () => {
        if (busy || panelId === undefined) return
        if (!armed) {
          setArmed(true)
          setError(undefined)
          return
        }
        setArmed(false)
        setBusy(true)
        const origin = originOf(panelId) ?? besideId ?? panelId
        Promise.resolve(clearConversation(root, origin, tab.id))
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => { setBusy(false) })
      }
      const onToggleListed = () => {
        const next = !listed
        setListed(next)
        setShowsRows(next)
      }
      const onUnarchive = () => {
        if (busy || panelId === undefined) return
        const workspaces = root.get('workspaces')
        if (workspaces === undefined) {
          setError('workspaces 服务不可用，无法取消归档')
          return
        }
        setBusy(true)
        Promise.resolve(workspaces.unarchiveSession(panelId))
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => { setBusy(false) })
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } },
        archived
          ? h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 10px',
                fontSize: '12px',
                color: 'var(--dsw-alias-state-warn-label)',
                borderBottom: '1px solid var(--dsw-alias-border-l1)',
              },
            },
            h('span', { style: { flex: '1 1 auto' } }, '这个会话已归档，消息会被拒收（回复会显示已完成但没有内容）。'),
            h(
              'button',
              {
                type: 'button',
                title: '取消归档，让这个面板能继续对话',
                style: busy ? { ...buttonStyle, opacity: 0.6 } : buttonStyle,
                onClick: onUnarchive,
                'data-side-assistant-action': 'unarchive',
              },
              '取消归档',
            ),
          )
          : null,
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 10px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
          },
          h('span', {
            style: { flex: '1 1 auto', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
          }, error ?? ''),
          h(
            'button',
            {
              type: 'button',
              title: listed ? '在会话列表里隐藏侧边助理会话' : '在会话列表里显示侧边助理会话',
              style: buttonStyle,
              onClick: onToggleListed,
              'data-side-assistant-action': 'toggle-listed',
            },
            listed ? '隐藏本类会话' : '在列表里显示',
          ),
          h(
            'button',
            {
              type: 'button',
              title: '开一段新的对话；上一段仍留在会话列表里',
              style: armed || busy ? { ...buttonStyle, opacity: busy ? 0.6 : 1, color: 'var(--dsw-alias-state-warn-label)', borderColor: 'var(--dsw-alias-state-warn-label)' } : buttonStyle,
              onClick: onClear,
              'data-side-assistant-action': 'clear',
            },
            armed ? '确认清空？' : '清空对话',
          ),
        ),
        resource.value === undefined
          ? null
          : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
            h(SessionProvider, { session: resource.value.reference }, renderSlot('sidebar.chat.conversation', {})),
          ),
      )
    }

    /** Fixed Chat selection used by the embedded Conversation occurrence. */
    function SideAssistantChatView(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    /**
     * Occupant of the shared Conversation seat: the product's own Conversation body,
     * bound to the Session the surrounding tab body provides. Mirrors the shipped
     * subagent seat, which exists only while that plugin is enabled.
     */
    function SideAssistantConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
      const session = useSession(value => value)
      const conversation = useConversation(value => value)
      const active = conversation.activeTargets.size > 0
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running
      const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
      const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
      const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
      const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
      const phase = settling ? 'settling' : hero ? 'hero' : 'active'
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
        slots: { views: SideAssistantChatView },
      })
    }

    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '24px',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    /**
     * Session header entry: open (or reuse) the side-assistant chat beside the conversation.
     * List entries receive the standard Session props, not an `inject` face.
     * @param props - standard Session props supplied by the header slot.
     */
    function SideAssistantButton({ sessionId }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      if (known.has(sessionId)) return null
      const onClick = () => {
        if (busy) return
        setBusy(true)
        setError(undefined)
        Promise.resolve(openSideAssistant(root, sessionId))
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => { setBusy(false) })
      }
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h(
          'button',
          {
            type: 'button',
            style: busy ? { ...buttonStyle, opacity: 0.6 } : buttonStyle,
            title: error ?? '把需求说清楚，替你转达给主会话',
            onClick,
            'data-side-assistant-action': '',
          },
          LABEL,
        ),
        error === undefined
          ? null
          : h(
            'span',
            { style: { fontSize: '11px', color: 'var(--dsw-alias-state-warn-label)' } },
            error,
          ),
      )
    }

    return {
      inject: ['slots', 'sessions', 'sidebarRight'],
      apply(ctx) {
        root = ctx
        // Hide the header entry inside panels opened earlier in this browser.
        for (const id of Object.values(readOriginMap())) known.add(id)
        syncQuietDots()
        ctx.effect(() => () => disposeQuietDots(), 'side-assistant: quiet dots')
        ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
          scope.effect(() => scope.resources.register(provider(scope.sessions)), 'side-assistant: chat resource')
          scope.effect(() => scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: PROTOCOL,
            patterns: [`${ADDRESS_PREFIX}**`],
            priority: 'extension',
            canOpen: (address) => parseAddress(address) !== undefined,
            title: () => LABEL,
          }), 'side-assistant: chat tab type')
        })
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } },
        }, SideAssistantTab)), 'side-assistant: chat tab body')
        // The seat is declared by the tab body above; occupy it with the product's
        // Conversation body so this tab renders without the subagent UI plugin.
        ctx.effect(() => ctx.slots.inject('sidebar.chat.conversation', () => ctx.slots.register({
          name: 'sidebar.chat.conversation',
        }, SideAssistantConversation)), 'side-assistant: chat conversation seat')
        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'side-assistant',
          // Next to the preset label (-10) and background tasks (20).
          order: 15,
          label: LABEL,
        }, SideAssistantButton)), 'side-assistant: header entry')
      },
    }
  },
})
