# RAH Zellij Mux Backend Manual QA

Date: 2026-05-08
Branch: `experiment/zellij-mux-backend`

This checklist is the remaining gate for deciding whether zellij can become the default live TUI backend. Automated tests already cover the code-level MVP; this file covers the real provider, browser, and iPad/PWA evidence that cannot be proven by fake providers.

## Preconditions

1. Start from the zellij branch:

```bash
cd /Users/sun/Code/repos/rah
git status --short --branch
```

Expected branch:

```text
## experiment/zellij-mux-backend
```

2. Restart RAH from this checkout:

```bash
node bin/rah.mjs restart --no-open
```

3. Open the workbench:

```text
http://127.0.0.1:43111/
```

For iPad/PWA, use the Mac LAN IP with port `43111`.

4. Optional automatic preflight:

```bash
npm run typecheck
npm run test:runtime
npm run test:web
npm run build:web
npm run test:smoke:zellij-real-tui-exit
```

The exit smoke proves only that real Codex / Claude / OpenCode can exit and be cleaned up through zellij. It does not prove model response, real Stop, Web/PWA UX, or Chat mirror correctness.

## Evidence To Record

For every provider test, record:

- provider: `codex`, `claude`, or `opencode`
- launch command
- CLI version shown in TUI
- RAH session id
- zellij session name and pane id if visible in Settings
- local terminal result
- Web TUI result
- Chat mirror result
- Stop result
- `/exit` or exit result
- browser/device used
- pass/fail plus notes

## Test 1: Desktop Terminal Launch

Run each provider from a normal desktop terminal:

```bash
node bin/rah.mjs codex --mux zellij
node bin/rah.mjs claude --mux zellij
node bin/rah.mjs opencode --mux zellij
```

Expected:

- The local terminal attaches to the zellij-backed TUI.
- Colors, cursor, transient status lines, and keyboard input are usable.
- Codex should show `--no-alt-screen` compatible behavior, including usable scrollback.
- OpenCode should remain close to its native smoothness.
- Exiting the terminal attach should not corrupt the shell input mode.

Failure conditions:

- obvious lag compared with native TUI,
- broken colors or unreadable selected menu item,
- stale transient lines that do not clear,
- terminal input mode remains broken after exit,
- session remains live after provider process exits.

## Test 2: Web Attach To Existing Terminal Session

1. Start a provider from desktop terminal with `--mux zellij`.
2. Open `http://127.0.0.1:43111/`.
3. Select the live session from Sessions.
4. Open TUI view.
5. Claim control from Web if needed.

Expected:

- Web shows the same live zellij pane, not a resumed or duplicated provider session.
- The desktop terminal and Web TUI refer to the same provider process.
- Switching Chat/TUI does not gray out Send permanently.
- Browser reload reconnects to the same pane and can replay missed output.

Failure conditions:

- Web creates another provider session,
- Chat shows another session's output,
- TUI output disappears after browser reload,
- Send remains disabled after switching to/from TUI.

## Test 3: Web Input And Chat Mirror

Use a unique marker per provider, for example:

```text
RAH_ZELLIJ_QA_CODEX_YYYYMMDD_HHMM
RAH_ZELLIJ_QA_CLAUDE_YYYYMMDD_HHMM
RAH_ZELLIJ_QA_OPENCODE_YYYYMMDD_HHMM
```

For each provider:

1. Send the marker from the desktop TUI.
2. Confirm Web TUI shows the same input/output.
3. Confirm Chat mirror shows the user message and assistant response exactly once.
4. Send a second marker from Web Chat.
5. Confirm the native TUI receives it and the Chat mirror still shows no duplicate.

Expected:

- TUI input and Web Chat input both enter the same provider process.
- Structured Chat is populated from provider history files/DB.
- No duplicate user message.
- No duplicate assistant response.
- No cross-session output.

Failure conditions:

- first user question appears twice,
- assistant response appears as many tiny bubbles instead of one coherent message,
- Chat shows text from a different session,
- Web Chat input is lost or stuck queued when TUI prompt is clean.

## Test 4: Real Stop During A Provider Turn

For each provider, start a turn that takes long enough to interrupt. Prefer a harmless request such as:

```text
请执行一个简单测试：先 sleep 20 秒，然后只输出 RAH_ZELLIJ_STOP_DONE
```

Then click Stop in Web Chat/TUI while the provider is still running.

Expected:

- Stop sends the provider-native interrupt key, not a process-killing signal.
- The TUI process stays alive.
- RAH leaves `stopping` and returns to idle after the provider releases control.
- A follow-up question can be sent from Web Chat and from TUI.
- Chat mirror shows an aborted/canceled/partial state if the provider records one.

Failure conditions:

- provider process exits,
- session stays forever in Stop/running state,
- Send remains disabled after stop,
- follow-up question is dropped,
- Web and TUI disagree about whether the turn is active.

## Test 5: Provider Exit And Archive

For each provider:

1. Exit from inside the TUI using the provider's own UI. For Codex, explicitly test `/exit` manually because the automatic smoke only proves `Ctrl-D`.
2. Confirm the Web session becomes stopped/closed and does not remain controllable.
3. Start another zellij session and use Web Archive.
4. Confirm the provider process and zellij `rah-*` session disappear.
5. Check Settings -> Zellij mux sessions for stale managed sessions.

Expected:

- Native TUI exit and Web Archive converge on the same lifecycle cleanup.
- No orphan zellij sessions for managed live sessions.
- Unmanaged stale `rah-*` sessions can be diagnosed and closed from Settings.

Failure conditions:

- provider exits but RAH still shows live,
- Archive hides the Web card but leaves zellij/provider alive,
- Settings shows stale managed session after expected cleanup.

## Test 6: Browser/PWA Reconnect

1. Start a zellij-backed provider session.
2. Begin a turn that produces visible output.
3. Close or background the browser/PWA.
4. Continue or finish activity from the desktop TUI.
5. Reopen the browser/PWA and select the same session.

Expected:

- Web TUI replays missed zellij output.
- Chat mirror catches up from provider history.
- No duplicate output after reconnect.
- The session is not resumed or restarted.

Failure conditions:

- browser must select another session to refresh state,
- output repeats,
- Chat mirror remains stale,
- provider was restarted/resumed rather than continued.

## Test 7: iPad/Safari/PWA

Run at least one provider on iPad Safari and PWA installed mode.

Required checks:

- keyboard opens without hiding the active prompt,
- Chinese IME composition does not corrupt terminal input,
- shortcut buttons remain reachable,
- scrolling inside TUI is predictable,
- orientation change does not lose TUI replay,
- app background/foreground catches up to the latest state,
- unsupported iPhone/small layouts degrade safely.

Failure conditions:

- keyboard causes unusable drift,
- IME sends partial or duplicated text,
- TUI cannot be operated after background/foreground,
- canvas/split opens into a blank or unrecoverable state.

## Test 8: Multi-Client And Resize

1. Attach desktop terminal and Web to the same session.
2. Resize desktop terminal.
3. Resize browser window.
4. If possible, attach iPad at the same time.

Expected:

- Input ownership remains understandable.
- TUI remains readable after resize changes.
- No resize loop or constant redraw storm.
- zellij pane is not destroyed or duplicated.

Known risk:

zellij 0.44.2 does not expose a clean absolute target-pane rows/cols API. If multi-client resize is bad, record it as a product limitation rather than papering it over in RAH.

## Pass Criteria

The zellij backend can be considered for default only if all of these are true:

- Codex, Claude, and OpenCode are usable from desktop terminal through zellij.
- Web/PWA can continue the same non-resumed session.
- Real Stop does not kill the provider.
- Provider exit and Web Archive both clean up live state and zellij sessions.
- Chat mirror has no duplicate or cross-session output.
- iPad/Safari is usable enough for mobile continuation.
- Remaining resize limitations are understood and acceptable.

If any provider fails Stop, Web attach, or Chat mirror uniqueness, keep zellij as experimental.
