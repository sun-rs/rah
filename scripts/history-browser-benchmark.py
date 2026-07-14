from __future__ import annotations

import argparse
import json
import time
from typing import Any
from urllib import request

from playwright.sync_api import expect, sync_playwright


def request_json(base_url: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if payload is None:
        req = request.Request(f"{base_url}{path}")
    else:
        req = request.Request(
            f"{base_url}{path}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
    with request.urlopen(req, timeout=240) as response:
        return json.load(response)


def live_session_ids(base_url: str) -> set[str]:
    return {
        summary["session"]["id"]
        for summary in request_json(base_url, "/api/sessions").get("sessions", [])
        if isinstance(summary, dict)
        and isinstance(summary.get("session"), dict)
        and isinstance(summary["session"].get("id"), str)
    }


def close_replay_session(base_url: str, session_id: str) -> None:
    try:
        summary = request_json(base_url, f"/api/sessions/{session_id}")["session"]
        attached_clients = summary.get("attachedClients", [])
        client_id = next(
            (
                client.get("id")
                for client in attached_clients
                if isinstance(client, dict) and isinstance(client.get("id"), str)
            ),
            "history-browser-benchmark",
        )
        request_json(
            base_url,
            f"/api/sessions/{session_id}/close",
            {"clientId": client_id},
        )
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure read-only RAH history first-paint latency and transfer size."
    )
    parser.add_argument("provider_session_id")
    parser.add_argument("--base-url", default="http://127.0.0.1:43111")
    parser.add_argument("--tab", choices=("Recent", "All"), default="Recent")
    parser.add_argument("--older-pages", type=int, default=0)
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume after history hydration and verify the visible page is reused without reloading turns.",
    )
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    listing_mode = "recent" if args.tab == "Recent" else "all"
    session_listing = request_json(base_url, f"/api/sessions?storedSessions={listing_mode}")
    stored = next(
        (
            item
            for item in session_listing.get("storedSessions", [])
            if item.get("providerSessionId") == args.provider_session_id
        ),
        None,
    )
    if stored is None:
        raise SystemExit(
            f"Stored session {args.provider_session_id} is not present in the {args.tab} tab."
        )

    before_ids = live_session_ids(base_url)
    created_replay_ids: set[str] = set()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            api_request_urls: list[str] = []
            page.on(
                "request",
                lambda next_request: api_request_urls.append(next_request.url)
                if "/api/" in next_request.url
                else None,
            )
            page.add_init_script(
                """
                (() => {
                  try {
                    window.localStorage.removeItem('rah.lastHistorySelection');
                    window.sessionStorage.removeItem('rah.lastHistorySelection');
                  } catch {}
                })();
                """
            )
            page.set_default_timeout(120_000)
            try:
                page.goto(base_url, wait_until="domcontentloaded")
                page.locator('button[aria-label="Chats"]:visible').first.click()
                page.get_by_role("tab", name=args.tab, exact=True).click()
                if args.tab == "All":
                    page.get_by_placeholder(
                        "Search chats by title, id, provider, agent, or workspace..."
                    ).fill(args.provider_session_id)
                    workspace_label = stored.get("rootDir") or stored.get("cwd")
                    if not isinstance(workspace_label, str) or not workspace_label:
                        raise AssertionError("Stored session has no workspace label for Chats All.")
                    page.get_by_role("button").filter(has_text=workspace_label).first.click()

                started_at = time.perf_counter()
                with page.expect_response(
                    lambda response: "/conversation/turns?limit=20" in response.url,
                    timeout=120_000,
                ) as initial_history_response_info:
                    page.locator(
                        f'button[data-provider-session-id="{args.provider_session_id}"]:visible'
                    ).first.click()
                initial_history_response = initial_history_response_info.value
                initial_history_page = initial_history_response.json()
                next_cursor = initial_history_page.get("nextCursor")
                expect(page.get_by_text("History only", exact=True)).to_be_visible(timeout=120_000)
                page.wait_for_function(
                    """
                    () => document.querySelectorAll(
                      '[data-testid="chat-user-message"], [data-testid="chat-assistant-message"]'
                    ).length > 0
                    """,
                    timeout=120_000,
                )
                first_readable_ms = round((time.perf_counter() - started_at) * 1000, 1)
                older_page_loads: list[dict[str, Any]] = []
                scroll_container = page.locator('[data-testid="chat-thread-scroll-container"]')
                if args.older_pages > 0:
                    scroll_container.evaluate(
                        """
                        (element) => {
                          element.scrollTop = element.scrollHeight;
                          element.dispatchEvent(new Event('scroll'));
                        }
                        """
                    )
                    page.wait_for_timeout(250)
                for page_index in range(max(0, args.older_pages)):
                    if not next_cursor:
                        break
                    page_started_at = time.perf_counter()
                    with page.expect_response(
                        lambda response: "/conversation/turns" in response.url
                        and ("cursor=" in response.url or "before=" in response.url),
                        timeout=120_000,
                    ) as history_response_info:
                        scroll_container.evaluate(
                            """
                            (element) => {
                              element.scrollTop = 0;
                              element.dispatchEvent(new Event('scroll'));
                            }
                            """
                        )
                    history_response = history_response_info.value
                    history_page = history_response.json()
                    next_cursor = history_page.get("nextCursor")
                    page.wait_for_timeout(500)
                    rendered_after_prepend = page.locator(
                        '[data-testid="chat-user-message"], [data-testid="chat-assistant-message"]'
                    ).count()
                    if rendered_after_prepend < 1:
                        raise AssertionError(
                            f"History page {page_index + 1} left the chat viewport blank."
                        )
                    scroll_metrics = scroll_container.evaluate(
                        """
                        (element) => ({
                          scrollTop: element.scrollTop,
                          scrollHeight: element.scrollHeight,
                          clientHeight: element.clientHeight,
                        })
                        """
                    )
                    older_page_loads.append(
                        {
                            "page": page_index + 1,
                            "durationMs": round(
                                (time.perf_counter() - page_started_at) * 1000, 1
                            ),
                            "decodedBodyBytes": len(history_response.body()),
                            "renderedMessageCount": rendered_after_prepend,
                            "scrollMetricsAfterPrepend": scroll_metrics,
                            "requestUrl": history_response.url,
                        }
                    )
                resume_result: dict[str, Any] | None = None
                if args.resume:
                    resume_button = page.get_by_role("button", name="Resume", exact=True)
                    expect(resume_button).to_be_visible(timeout=30_000)
                    expect(resume_button).to_be_enabled(timeout=30_000)
                    resume_request_start = len(api_request_urls)
                    messages_before_resume = page.locator(
                        '[data-testid="chat-user-message"], [data-testid="chat-assistant-message"]'
                    ).count()
                    resume_started_at = time.perf_counter()
                    with page.expect_response(
                        lambda response: response.url.endswith("/api/sessions/resume"),
                        timeout=120_000,
                    ) as resume_response_info:
                        resume_button.click()
                    resume_response = resume_response_info.value
                    if resume_response.status >= 400:
                        response_text = resume_response.text()
                        if "attach instead of resume" not in response_text:
                            raise AssertionError(
                                f"Resume failed with HTTP {resume_response.status}: {response_text}"
                            )
                    composer = page.locator("textarea:visible").last
                    expect(composer).to_be_visible(timeout=120_000)
                    expect(composer).to_be_enabled(timeout=120_000)
                    expect(page.get_by_text("History only", exact=True)).not_to_be_visible(
                        timeout=30_000
                    )
                    messages_after_resume = page.locator(
                        '[data-testid="chat-user-message"], [data-testid="chat-assistant-message"]'
                    ).count()
                    if messages_before_resume > 0 and messages_after_resume == 0:
                        raise AssertionError("Resume hid the already-visible history page.")
                    resume_history_requests = [
                        url
                        for url in api_request_urls[resume_request_start:]
                        if "/conversation/turns" in url
                    ]
                    if resume_history_requests:
                        raise AssertionError(
                            "Resume reloaded already-visible history: "
                            + json.dumps(resume_history_requests)
                        )
                    resume_result = {
                        "durationMs": round((time.perf_counter() - resume_started_at) * 1000, 1),
                        "messagesBefore": messages_before_resume,
                        "messagesAfter": messages_after_resume,
                        "historyReloadRequestCount": len(resume_history_requests),
                    }
                page.wait_for_timeout(750)

                resource_entries = page.evaluate(
                    """
                    () => performance.getEntriesByType('resource')
                      .filter((entry) => entry.name.includes('/api/'))
                      .map((entry) => ({
                        name: entry.name,
                        durationMs: Math.round(entry.duration * 10) / 10,
                        transferSize: entry.transferSize,
                        encodedBodySize: entry.encodedBodySize,
                        decodedBodySize: entry.decodedBodySize,
                      }))
                    """
                )
                history_resources = [
                    entry for entry in resource_entries if "/conversation/turns" in entry["name"]
                ]
                slow_api_resources = [
                    entry for entry in resource_entries if entry["durationMs"] >= 100
                ]
                rendered_items = page.locator(
                    '[data-testid="chat-user-message"], [data-testid="chat-assistant-message"]'
                ).count()
                visible_text_bytes = len(
                    page.locator('[data-testid="chat-thread-scroll-container"]').inner_text().encode()
                )

                print(
                    json.dumps(
                        {
                            "ok": True,
                            "provider": stored.get("provider"),
                            "providerSessionId": args.provider_session_id,
                            "title": stored.get("title"),
                            "sourceHistory": stored.get("historyMeta"),
                            "firstReadableMs": first_readable_ms,
                            "renderedMessageCount": rendered_items,
                            "visibleTextBytes": visible_text_bytes,
                            "initialTurnCount": len(initial_history_page.get("turns", [])),
                            "initialNextCursor": initial_history_page.get("nextCursor"),
                            "historyExhausted": not bool(next_cursor),
                            "olderPageLoads": older_page_loads,
                            "resume": resume_result,
                            "historyRequestCount": len(history_resources),
                            "historyTransferBytes": sum(
                                entry["transferSize"] for entry in history_resources
                            ),
                            "historyEncodedBodyBytes": sum(
                                entry["encodedBodySize"] for entry in history_resources
                            ),
                            "historyDecodedBodyBytes": sum(
                                entry["decodedBodySize"] for entry in history_resources
                            ),
                            "historyResources": history_resources,
                            "slowApiResources": slow_api_resources,
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                )
            finally:
                browser.close()
    finally:
        created_replay_ids = live_session_ids(base_url) - before_ids
        for session_id in created_replay_ids:
            close_replay_session(base_url, session_id)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
