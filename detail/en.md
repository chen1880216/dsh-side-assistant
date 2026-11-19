# Side assistant

A Chinese-speaking helper that lives in a session's right sidebar. It does not do the work itself: it clears up the request, then hands it to the main session.

## What it adds

- **A `side-assistant` session preset**: pick it when starting a session. The preset has no shell and no file tools.
- **Three tools**, registered only for sessions running that preset:

  | Tool | Purpose |
  |---|---|
  | `side_sessions` | List the other sessions of this workspace, their state, and which one is the main session |
  | `side_peek` | Read a session's recent thread: prompts, answers, tool calls, and how each turn ended |
  | `side_deliver` | Deliver the drafted request to the main session and wake it; the target shows "from session …" |

- **A right-sidebar panel**: press **侧边助理** in any session header to open the assistant's chat beside it.

## Usage

1. Open a session and press **侧边助理** in its header.
2. Describe what you need in plain Chinese; it narrows the goal and constraints first.
3. Say "发给主会话" and it delivers the drafted request.
4. Say "跟进一下" and it reports the main session's progress: conclusion first, then what is verified, what is blocked, and anything needing your decision.

**The default target is the session you opened the panel from.** The header entry records that pair in the browser and pushes it to a small binding table on the host, so `side_peek` / `side_deliver` aim there unless you name a `session` explicitly.

**Clear chat**: the button in the panel's top row turns into "Clear?" on the first click; the second click moves the panel to a fresh blank conversation and repoints the binding. The old conversation is not deleted — DSH has no session-delete API — so it stays in your session list.

**List these Sessions / Hide these Sessions**: assistant sessions are kept out of the session list by default so history stays scannable; this button lists them, still without the finished dot.

**Unarchive**: shown only while the panel's session is archived. An archived session is refused by the host, which looks like "sent, finished, but no reply"; one click lifts the archive.

## Design notes

- The assistant is a real Session; the panel is only one view of it, so closing the panel keeps the conversation.
- Delivery uses `agent.followup`, so only a live session can be woken; a stopped one reports an error instead of pretending.
- The plugin is a profile-level row and registers its tools per Agent through `agent/created`, so ordinary sessions never see them.
- The plugin imports no `@deepseek-ai/*` package: tool schemas are assembled locally.
- The origin session travels over `POST /api/dsh-side-assistant/bind`, because `sessions.create` cannot carry it.
- Tools re-resolve their services through `exec.agent.ctx`, so they keep working after the plugin reloads.

