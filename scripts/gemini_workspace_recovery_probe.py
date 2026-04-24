#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import re
from collections import defaultdict

ABSOLUTE_PATH_PATTERN = re.compile(r"(?:~|/)(?:[A-Za-z0-9._\-~ ]+/)*[A-Za-z0-9._\-~ ]+")
GENERIC_ANCESTOR_NAMES = {
    "src",
    "lib",
    "bin",
    "source",
    "docs",
    "doc",
    "test",
    "tests",
    "spec",
    "specs",
    "plans",
    "scripts",
    "examples",
    "example",
    "crates",
    "packages",
    "pkg",
    "cmd",
    "chat",
    "chats",
    "tmp",
    "temp",
    "build",
    "dist",
    "out",
    "target",
    "dev",
    "mobile",
}
COMMON_SCAN_ROOTS = [
    pathlib.Path.home() / "Code",
    pathlib.Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Lab",
]


def normalize_directory(value: str | None) -> str | None:
    if not value:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    without_trailing = trimmed.rstrip("/\\")
    if without_trailing.startswith("/private/var/"):
        return without_trailing[len("/private") :]
    return without_trailing


def resolve_rah_home() -> pathlib.Path:
    env = os.environ.get("RAH_HOME")
    if env:
        return pathlib.Path(env).expanduser()
    return pathlib.Path.home() / ".rah" / "runtime-daemon"


def resolve_gemini_home() -> pathlib.Path:
    env = os.environ.get("GEMINI_CLI_HOME")
    if env:
        return pathlib.Path(env).expanduser()
    return pathlib.Path.home() / ".gemini"


def load_json(path: pathlib.Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def iter_raw_session_files(gemini_home: pathlib.Path):
    tmp_root = gemini_home / "tmp"
    if not tmp_root.is_dir():
        return
    for project_dir in sorted(tmp_root.iterdir()):
        chats_dir = project_dir / "chats"
        if not chats_dir.is_dir():
            continue
        for file_path in sorted(chats_dir.iterdir()):
            if not file_path.is_file():
                continue
            name = file_path.name
            if not name.startswith("session-"):
                continue
            if not (name.endswith(".json") or name.endswith(".jsonl")):
                continue
            yield file_path


def parse_session_metadata(file_path: pathlib.Path) -> dict[str, str | None]:
    project_hash = file_path.parent.parent.name
    session_id = None
    kind = None
    try:
        if file_path.suffix == ".json":
            parsed = load_json(file_path)
            if isinstance(parsed, dict):
                if isinstance(parsed.get("sessionId"), str):
                    session_id = parsed["sessionId"]
                if isinstance(parsed.get("projectHash"), str):
                    project_hash = parsed["projectHash"]
                if isinstance(parsed.get("kind"), str):
                    kind = parsed["kind"]
        else:
            with file_path.open("r", encoding="utf-8") as f:
                for raw_line in f:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        parsed = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(parsed, dict):
                        continue
                    if isinstance(parsed.get("sessionId"), str):
                        session_id = parsed["sessionId"]
                    if isinstance(parsed.get("projectHash"), str):
                        project_hash = parsed["projectHash"]
                    if isinstance(parsed.get("kind"), str):
                        kind = parsed["kind"]
                    if session_id and project_hash:
                        break
    except Exception:
        pass
    return {
        "session_id": session_id,
        "project_hash": project_hash,
        "kind": kind,
    }


def add_root(root_sources: dict[str, set[str]], root: str | None, source: str) -> None:
    normalized = normalize_directory(root)
    if not normalized:
        return
    root_sources[normalized].add(source)

    try:
        real = normalize_directory(os.path.realpath(normalized))
    except Exception:
        real = None
    if real and real != normalized:
        root_sources[real].add(f"{source}+realpath")

    if normalized.startswith("/var/"):
        root_sources[f"/private{normalized}"].add(f"{source}+private-var")
    if normalized.startswith("/private/var/"):
        root_sources[normalized[len('/private') :]].add(f"{source}+var")


def iter_candidate_ancestors(path_text: str):
    normalized = normalize_directory(path_text)
    if not normalized:
        return
    current = pathlib.Path(normalized)
    for _ in range(8):
        current_text = normalize_directory(str(current))
        if not current_text:
            break
        name = current.name.lower()
        if len(current.parts) >= 4 and name and not name.startswith(".") and name not in GENERIC_ANCESTOR_NAMES:
            yield current_text
        if current.parent == current:
            break
        current = current.parent


def collect_candidate_roots_base(rah_home: pathlib.Path, gemini_home: pathlib.Path):
    root_sources: dict[str, set[str]] = defaultdict(set)

    projects_json = gemini_home / "projects.json"
    if projects_json.is_file():
        try:
            projects = load_json(projects_json).get("projects", {})
            if isinstance(projects, dict):
                for raw_root in projects.keys():
                    add_root(root_sources, str(raw_root), "projects.json")
        except Exception:
            pass

    workbench_state = rah_home / "workbench-state.json"
    if workbench_state.is_file():
        try:
            parsed = load_json(workbench_state)
            for field in ("workspaces", "hiddenWorkspaces"):
                values = parsed.get(field, [])
                if isinstance(values, list):
                    for raw_root in values:
                        if isinstance(raw_root, str):
                            add_root(root_sources, raw_root, f"workbench:{field}")
            active = parsed.get("activeWorkspaceDir")
            if isinstance(active, str):
                add_root(root_sources, active, "workbench:activeWorkspaceDir")
        except Exception:
            pass

    stored_cache_dir = rah_home / "stored-session-cache"
    if stored_cache_dir.is_dir():
        for cache_file in sorted(stored_cache_dir.glob("*.json")):
            provider = cache_file.stem
            try:
                parsed = load_json(cache_file)
            except Exception:
                continue
            entries = parsed.get("entries", {})
            if not isinstance(entries, dict):
                continue
            for entry in entries.values():
                if not isinstance(entry, dict):
                    continue
                ref = entry.get("ref", {})
                if not isinstance(ref, dict):
                    continue
                for field in ("cwd", "rootDir"):
                    value = ref.get(field)
                    if isinstance(value, str):
                        add_root(root_sources, value, f"stored-cache:{provider}:{field}")

    return root_sources


def parse_shell_history_candidates():
    roots: set[str] = set()
    history_files = [pathlib.Path.home() / ".zsh_history", pathlib.Path.home() / ".bash_history"]
    for history_file in history_files:
        if not history_file.is_file():
            continue
        try:
            text = history_file.read_text("utf-8", errors="ignore")
        except Exception:
            continue
        for line in text.splitlines():
            if ";" in line and line.startswith(": "):
                line = line.split(";", 1)[1]
            line = line.strip()
            if not line:
                continue
            cd_match = re.search(r"(?:^|[;&|]\s*)cd\s+((?:~|/)[^;&|]+)", line)
            if cd_match:
                path_text = cd_match.group(1).strip().strip("'\"")
                expanded = normalize_directory(os.path.expanduser(path_text))
                if expanded:
                    roots.add(expanded)
            for raw in ABSOLUTE_PATH_PATTERN.findall(line):
                expanded = normalize_directory(os.path.expanduser(raw))
                if not expanded:
                    continue
                if not expanded.startswith("/Users/sun/"):
                    continue
                roots.add(expanded)
                for ancestor in iter_candidate_ancestors(expanded):
                    roots.add(ancestor)
    return roots


def scan_common_roots():
    roots: set[str] = set()
    for base in COMMON_SCAN_ROOTS:
        if not base.is_dir():
            continue
        queue: list[tuple[pathlib.Path, int]] = [(base, 0)]
        while queue:
            current, depth = queue.pop()
            normalized = normalize_directory(str(current))
            if normalized:
                roots.add(normalized)
            if depth >= 4:
                continue
            try:
                for child in current.iterdir():
                    if not child.is_dir():
                        continue
                    if child.name.startswith("."):
                        continue
                    queue.append((child, depth + 1))
            except Exception:
                continue
    return roots


def build_hash_index(root_sources: dict[str, set[str]]):
    hash_to_roots: dict[str, set[str]] = defaultdict(set)
    for root in root_sources:
        hash_to_roots[sha256_text(root)].add(root)
    return hash_to_roots


def extract_session_content_candidates(file_path: pathlib.Path):
    candidates: set[str] = set()
    texts: list[str] = []
    try:
        texts.append(file_path.read_text("utf-8", errors="ignore")[:512 * 1024])
    except Exception:
        pass
    logs_path = file_path.parent.parent / "logs.json"
    if logs_path.is_file():
        try:
            texts.append(logs_path.read_text("utf-8", errors="ignore")[:256 * 1024])
        except Exception:
            pass

    for text in texts:
        for raw in ABSOLUTE_PATH_PATTERN.findall(text):
            expanded = normalize_directory(os.path.expanduser(raw))
            if not expanded or not expanded.startswith("/Users/sun/"):
                continue
            candidates.add(expanded)
            hinted = pathlib.Path(expanded)
            if hinted.suffix or hinted.name.startswith("."):
                candidates.add(normalize_directory(str(hinted.parent)) or "")
            for ancestor in iter_candidate_ancestors(str(hinted)):
                candidates.add(ancestor)
    return {candidate for candidate in candidates if candidate}


def build_unresolved_entries(rah_home: pathlib.Path):
    gemini_cache_file = rah_home / "stored-session-cache" / "gemini.json"
    if not gemini_cache_file.is_file():
        raise SystemExit(f"Missing {gemini_cache_file}")

    parsed_cache = load_json(gemini_cache_file)
    entries = parsed_cache.get("entries", {})
    if not isinstance(entries, dict):
        raise SystemExit("gemini.json entries is not a dict")

    unresolved_entries: list[dict] = []
    current_session_ids: set[str] = set()
    for raw_file_path, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        ref = entry.get("ref", {})
        if not isinstance(ref, dict):
            continue
        session_id = ref.get("providerSessionId")
        if isinstance(session_id, str):
            current_session_ids.add(session_id)
        if ref.get("cwd") or ref.get("rootDir"):
            continue
        unresolved_entries.append(
            {
                "file_path": raw_file_path,
                "provider_session_id": session_id,
            }
        )
    return unresolved_entries, current_session_ids


def main() -> int:
    rah_home = resolve_rah_home()
    gemini_home = resolve_gemini_home()
    unresolved_entries, current_session_ids = build_unresolved_entries(rah_home)

    raw_file_digest_map: dict[str, pathlib.Path] = {}
    raw_file_metadata: dict[str, dict[str, str | None]] = {}
    for raw_file in iter_raw_session_files(gemini_home):
        raw_text = str(raw_file)
        raw_file_digest_map[sha256_text(raw_text)] = raw_file
        raw_file_metadata[raw_text] = parse_session_metadata(raw_file)

    base_root_sources = collect_candidate_roots_base(rah_home, gemini_home)
    expanded_root_sources: dict[str, set[str]] = defaultdict(set)
    for root, sources in base_root_sources.items():
        expanded_root_sources[root].update(sources)
    for root in parse_shell_history_candidates():
        add_root(expanded_root_sources, root, "shell-history")
    for root in scan_common_roots():
        add_root(expanded_root_sources, root, "common-root-scan")

    base_hash_index = build_hash_index(base_root_sources)
    expanded_hash_index = build_hash_index(expanded_root_sources)

    stats = {
        "total_no_dir": len(unresolved_entries),
        "raw_file_still_exists": 0,
        "with_project_hash": 0,
        "base_candidate_match": 0,
        "expanded_candidate_match": 0,
        "content_hint_exact_match": 0,
        "final_union_match": 0,
    }
    recovered_examples: list[dict] = []

    for entry in unresolved_entries:
        file_path = pathlib.Path(entry["file_path"])
        if not file_path.is_file():
            continue
        stats["raw_file_still_exists"] += 1
        metadata = raw_file_metadata.get(str(file_path)) or parse_session_metadata(file_path)
        project_hash = metadata.get("project_hash")
        if not isinstance(project_hash, str) or not project_hash:
            continue
        stats["with_project_hash"] += 1

        base_matches = sorted(base_hash_index.get(project_hash, set()))
        expanded_matches = sorted(expanded_hash_index.get(project_hash, set()))

        content_matches: list[str] = []
        for candidate in sorted(extract_session_content_candidates(file_path)):
            if sha256_text(candidate) == project_hash:
                content_matches.append(candidate)

        if base_matches:
            stats["base_candidate_match"] += 1
        if expanded_matches:
            stats["expanded_candidate_match"] += 1
        if content_matches:
            stats["content_hint_exact_match"] += 1
        if base_matches or expanded_matches or content_matches:
            stats["final_union_match"] += 1

        if len(recovered_examples) < 20 and (expanded_matches or content_matches):
            recovered_examples.append(
                {
                    "provider_session_id": entry["provider_session_id"],
                    "project_hash": project_hash,
                    "file_path": str(file_path),
                    "base_matches": base_matches,
                    "expanded_matches": expanded_matches,
                    "content_matches": content_matches,
                }
            )

    cache_stats = {
        "cache_dirs": 0,
        "cache_dirs_matching_raw_file": 0,
        "cache_only_orphan_sessions": 0,
        "cache_only_orphan_project_hash_matched": 0,
    }
    gemini_cache_dir = rah_home / "gemini-history-cache"
    if gemini_cache_dir.is_dir():
        for cache_entry in sorted(gemini_cache_dir.iterdir()):
            if not cache_entry.is_dir() or len(cache_entry.name) != 64:
                continue
            cache_stats["cache_dirs"] += 1
            raw_file = raw_file_digest_map.get(cache_entry.name)
            if not raw_file:
                continue
            cache_stats["cache_dirs_matching_raw_file"] += 1
            metadata = raw_file_metadata.get(str(raw_file)) or parse_session_metadata(raw_file)
            session_id = metadata.get("session_id")
            if not isinstance(session_id, str) or session_id in current_session_ids:
                continue
            cache_stats["cache_only_orphan_sessions"] += 1
            project_hash = metadata.get("project_hash")
            if isinstance(project_hash, str) and (
                expanded_hash_index.get(project_hash) or any(
                    sha256_text(candidate) == project_hash
                    for candidate in extract_session_content_candidates(raw_file)
                )
            ):
                cache_stats["cache_only_orphan_project_hash_matched"] += 1

    print("Gemini workspace recovery probe")
    print(f"RAH_HOME={rah_home}")
    print(f"GEMINI_HOME={gemini_home}")
    print()
    print("Candidate roots")
    print(f"  base roots: {len(base_root_sources)}")
    print(f"  expanded roots: {len(expanded_root_sources)}")
    print()
    print("NO_DIR recovery")
    print(f"  total NO_DIR: {stats['total_no_dir']}")
    print(f"  raw file still exists: {stats['raw_file_still_exists']}")
    print(f"  with projectHash: {stats['with_project_hash']}")
    print(f"  base candidate hash match: {stats['base_candidate_match']}")
    print(f"  expanded candidate hash match: {stats['expanded_candidate_match']}")
    print(f"  session-content exact hash match: {stats['content_hint_exact_match']}")
    print(f"  final union match: {stats['final_union_match']}")
    if recovered_examples:
        print("  sample recovered sessions:")
        for item in recovered_examples[:10]:
            preferred = (
                item["content_matches"][0]
                if item["content_matches"]
                else item["expanded_matches"][0]
                if item["expanded_matches"]
                else item["base_matches"][0]
                if item["base_matches"]
                else "(none)"
            )
            print(f"    - {item['provider_session_id']} -> {preferred}")
    print()
    print("Cache reverse-match")
    print(f"  cache dirs scanned: {cache_stats['cache_dirs']}")
    print(f"  cache dirs matching raw file: {cache_stats['cache_dirs_matching_raw_file']}")
    print(f"  cache-only orphan sessions: {cache_stats['cache_only_orphan_sessions']}")
    print(
        "  cache-only orphan sessions with project match: "
        f"{cache_stats['cache_only_orphan_project_hash_matched']}"
    )

    report = {
        "base_root_count": len(base_root_sources),
        "expanded_root_count": len(expanded_root_sources),
        "stats": stats,
        "cache_stats": cache_stats,
        "recovered_examples": recovered_examples,
    }
    print()
    print("JSON summary:")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
