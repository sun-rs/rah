from __future__ import annotations

import argparse
import os

from rah_smoke_cleanup import cleanup_smoke_workspace, list_temp_workspaces_from_rah


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Remove RAH smoke-test workspaces/sessions that live under the system temp T directory.",
    )
    parser.add_argument("--base-url", default=os.environ.get("RAH_BASE_URL", "http://127.0.0.1:43111"))
    parser.add_argument("--dry-run", action="store_true", help="List matching temp workspaces without deleting them.")
    args = parser.parse_args()

    workspaces = list_temp_workspaces_from_rah(args.base_url)
    if args.dry_run:
        for workspace in workspaces:
            print(workspace)
        print(f"matched={len(workspaces)}")
        return 0

    for workspace in workspaces:
        cleanup_smoke_workspace(args.base_url, workspace)
        print(f"removed {workspace}")
    print(f"removed={len(workspaces)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
