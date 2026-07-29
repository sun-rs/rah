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
npm run test:ci
```

If any of these fail, stop the release.

`test:ci` recursively discovers all protocol/Web/runtime test files and runs each file in an isolated
Node test process, then builds the production Web client and runs `npm audit --omit=dev`. Auth and
Council tests are therefore included through the runtime/Web discovery rather than maintained as a
second hand-written list. It also runs `npm run check:repo-hygiene`, which rejects tracked build/test
artifacts, editor/OS junk, and broken local Markdown links. Ignored `test-results/` remains available
for intentional smoke/QA evidence and is not treated as accidental local junk.

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
npm run test:smoke:history-resume
npm run test:smoke:tool-flow
```

Recommended whenever the release changes:

- history/replay logic
- claim/running upgrade logic
- feed rendering
- session selection / restore behavior

### 2.2 Codex

Run when Codex adapter, Codex UI, or shared replay/running semantics changed.

Current practical validation:

- `npm run test:runtime`
- `npm run test:smoke:history-resume`
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
- shared replay/running-upgrade logic

### 2.4 OpenCode

OpenCode is the API-key aggregation entry for lower-frequency model families.

```bash
npm run test:smoke:opencode-browser
```

Current practical validation:

- start an OpenCode session from the workbench new-session control
- send a first prompt and verify Stop appears immediately and clears when idle
- interrupt a long turn and verify the next prompt is not merged with the interrupted prompt
- reopen the session from history/recent and verify assistant markdown keeps line breaks and lists

Run when release touches:

- OpenCode PTY launch/resume behavior
- OpenCode stored history discovery
- OpenCode model launch argument mapping
- shared runtime status or Stop-button semantics
- shared Markdown/projection merge logic

### 2.5 OpenCode Model Families

Model families without a first-class RAH CLI adapter are validated through OpenCode/API-provider
configuration. They do not add provider-specific launch, history, diagnostics, or release gates.

## 3. Recommended Release Order

Use this order unless there is a reason to narrow the scope:

1. Universal gate
2. Shared smoke
3. Provider smoke for each touched provider
4. Manual UI check on `43111`
5. Final release decision

Suggested command flow:

```bash
npm run test:ci
npm run test:smoke:stored-catalog-browser
```

Then selectively run only the provider smokes that match the release environment and change scope.

## 3.1 Cleanup Safety Gate

Smoke/probe cleanup is part of the release safety boundary:

- Test cleanup must move temporary workspaces, provider homes, and RAH homes to the system Trash, not delete them with `rm -rf`, `rmSync`, `shutil.rmtree`, or equivalent hard-delete APIs.
- Cleanup may only target roots created by that test run. It must not scan provider history contents, such as `~/.codex/sessions`, and delete files because their transcript text contains a temp path.
- Provider session-history removal must use the provider adapter archive/trash semantics. File-backed history must be recoverable from Trash.
- Run `npm run test:smoke-cleanup` before release whenever smoke/probe scripts changed.

## 4. Manual Product Checks

Before release, verify these manually on:

- `http://127.0.0.1:43111/`

### 4.1 Workbench shell

- an unpaired browser sees the device pairing screen instead of workbench data
- a paired browser remains trusted after reload
- revoking the current device returns it to the pairing screen and closes live sockets
- app loads on `43111`
- left sidebar opens and closes correctly
- `Session History` dialog opens correctly
- `New session` dialog opens correctly

### 4.2 Session semantics

- opening history opens read-only replay
- `Resume` upgrades the replay in place
- old history is not replayed again after resume
- initial bootstrap requests only bounded Recent metadata; opening All performs one authoritative catalog fetch, while clean reopen uses the stored revision/delta path
- a large stopped session opens from a bounded turn page instead of transferring the raw provider transcript
- `python3 scripts/history-browser-benchmark.py <provider-session-id> --older-pages 3` keeps initial and older-page transfer bounded; add `--resume` to verify the already rendered page is reused
- new turns are not duplicated
- `Stop` / `Close` really moves the running session to stopped without deleting provider history
- the Closing layer disappears when the authoritative close response arrives; background metadata/catalog refresh does not keep the UI blocked
- user-visible lifecycle copy uses `Running` / `Stopped`; `Live` / `Archive` only appears for provider technical names or stored-history archive/trash semantics

### 4.3 Provider presentation

- provider logo appears consistently in:
  - sidebar
  - session history
  - header
  - new session dialog
  - inspector
- `Running` / `Stopped` state badges and phase labels remain understandable

### 4.4 Error and recovery

- replay gap recovery still produces a visible error/recovery message
- missing provider binary shows diagnostics but does not pretend auth is valid
- read-only replay sessions do not expose running-only actions incorrectly
- browser smoke should validate turn counts and resulting side effects, not rely on one historical
  assistant sentence staying constant

## 5. Release Decision Rule

RAH is safe to release when:

- universal gate is green
- all relevant provider smokes for the release environment are green
- manual product checks show no regression in history/replay/claim/running-stopped semantics

RAH is **not** blocked by a provider smoke that cannot run on the current machine because:

- that CLI is not installed
- the account is not authenticated
- the account lacks quota or access

In those cases, move that smoke to a machine or CI runner where that provider is truly available.

## 6. What This Checklist Does Not Claim

This checklist does **not** imply:

- all providers are available on all machines
- provider authentication can be reliably preflighted by RAH
- Kimi CLI is a first-class running launch target

It is specifically for the current workbench boundary: Codex and OpenCode use native local-server
runtimes; Claude use `tui_mux`; Kimi-family models are handled through OpenCode/API-provider
configuration.
