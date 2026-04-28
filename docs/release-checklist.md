# RAH Release Checklist

This checklist defines the practical release gate for RAH `1.0` releases.

It is intentionally split into:

- universal checks
- provider-specific smoke
- manual product checks

RAH should **not** assume that every release machine has every provider CLI installed, authenticated,
and authorized.

## 1. Universal Gate

These checks should pass in any normal development or release environment:

```bash
npm run typecheck
npm run test:web
npm run test:runtime
npm run build:web
```

If any of these fail, stop the release.

## 2. Provider Smoke Policy

Provider smoke is **conditional**, not universal.

Run a provider smoke only when all of the following are true:

- the matching CLI is installed
- the CLI can actually launch
- the account is already authenticated
- the account has permission/quota to complete a real session

Do **not** treat “binary exists” as proof that the provider is usable.

### 2.1 Shared smoke

These validate the workbench behavior rather than a single provider:

```bash
npm run test:smoke:history-claim
npm run test:smoke:tool-flow
```

Recommended whenever the release changes:

- history/replay logic
- claim/live upgrade logic
- feed rendering
- session selection / restore behavior

### 2.2 Codex

Run when Codex adapter, Codex UI, or shared replay/live semantics changed.

Current practical validation:

- `npm run test:runtime`
- `npm run test:smoke:history-claim`
- `npm run test:smoke:tool-flow`

If you have a dedicated Codex-enabled release machine, use it here.

### 2.3 Claude

```bash
npm run test:smoke:claude-flow
npm run test:smoke:claude-browser
```

Run when release touches:

- Claude adapter
- Claude replay/history logic
- Claude live permission bridge
- shared replay/live-upgrade logic

### 2.4 Gemini

```bash
npm run test:smoke:gemini-flow
npm run test:smoke:gemini-browser
```

Run when release touches:

- Gemini adapter
- Gemini replay/history logic
- Gemini browser workbench behavior

### 2.5 Kimi

```bash
npm run test:smoke:kimi-flow
npm run test:smoke:kimi-browser
```

Run when release touches:

- Kimi adapter
- Kimi approval flow
- Kimi replay/history logic

### 2.6 OpenCode

Current practical validation:

- start an OpenCode session from the workbench new-session control
- send a first prompt and verify Stop appears immediately and clears when idle
- interrupt a long turn and verify the next prompt is not merged with the interrupted prompt
- reopen the session from history/recent and verify assistant markdown keeps line breaks and lists

Run when release touches:

- OpenCode ACP/server adapter logic
- OpenCode replay/history discovery
- shared runtime status or Stop-button semantics
- shared Markdown/projection merge logic

## 3. Recommended Release Order

Use this order unless there is a reason to narrow the scope:

1. Universal gate
2. Shared smoke
3. Provider smoke for each touched provider
4. Manual UI check on `43111`
5. Final release decision

Suggested command flow:

```bash
npm run typecheck
npm run test:web
npm run test:runtime
npm run build:web
```

Then selectively run only the provider smokes that match the release environment and change scope.

## 4. Manual Product Checks

Before release, verify these manually on:

- `http://127.0.0.1:43111/`

### 4.1 Workbench shell

- app loads on `43111`
- left sidebar opens and closes correctly
- `Session History` dialog opens correctly
- `New session` dialog opens correctly

### 4.2 Session semantics

- opening history opens read-only replay
- `Claim control` upgrades the replay in place
- old history is not replayed again after claim
- new turns are not duplicated
- `Close` really removes the live session

### 4.3 Provider presentation

- provider logo appears consistently in:
  - sidebar
  - session history
  - header
  - new session dialog
  - inspector
- `Live` / `History` state badges remain understandable

### 4.4 Error and recovery

- replay gap recovery still produces a visible error/recovery message
- missing provider binary shows diagnostics but does not pretend auth is valid
- read-only replay sessions do not expose live-only actions incorrectly
- browser smoke should validate turn counts and resulting side effects, not rely on one historical
  assistant sentence staying constant

## 5. Release Decision Rule

RAH is safe to release when:

- universal gate is green
- all relevant provider smokes for the release environment are green
- manual product checks show no regression in history/replay/claim/live semantics

RAH is **not** blocked by a provider smoke that cannot run on the current machine because:

- that CLI is not installed
- the account is not authenticated
- the account lacks quota or access

In those cases, move that smoke to a machine or CI runner where that provider is truly available.

## 6. What This Checklist Does Not Claim

This checklist does **not** imply:

- all providers are available on all machines
- provider authentication can be reliably preflighted by RAH
- PTY host takeover parity is part of the current `1.0` promise

It is specifically for the current structured multi-provider workbench boundary.
