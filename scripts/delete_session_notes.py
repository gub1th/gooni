"""Delete all session_summary notes from the Sessions space.

Usage:
    # dry run (prints what it WOULD delete):
    GOONI_URL=https://<prod> GOONI_AUTH_PASSWORD=<pw> \
        python scripts/delete_session_notes.py

    # actually delete:
    GOONI_URL=https://<prod> GOONI_AUTH_PASSWORD=<pw> \
        python scripts/delete_session_notes.py --execute
"""

import argparse
import hashlib
import os
import sys

import httpx

BASE = os.getenv("GOONI_URL", "http://localhost:8000").rstrip("/")
PASSWORD = os.getenv("GOONI_AUTH_PASSWORD", "")
TOKEN = hashlib.sha256(PASSWORD.encode()).hexdigest() if PASSWORD else ""
HEADERS = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}


def main(execute: bool) -> None:
    client = httpx.Client(headers=HEADERS, timeout=30)

    # Find the Sessions space
    spaces = client.get(f"{BASE}/spaces").json()
    sessions_space = next((s for s in spaces if s.get("name") == "Sessions"), None)
    if not sessions_space:
        print("No 'Sessions' space found — nothing to delete.")
        return

    space_id = sessions_space["id"]
    print(f"Found Sessions space id={space_id}")

    # Fetch all notes in it
    notes = client.get(f"{BASE}/spaces/{space_id}/notes").json()
    if not notes:
        print("Sessions space is empty — nothing to delete.")
        return

    print(f"Found {len(notes)} session notes to delete.")
    for n in notes:
        nid = n["id"]
        title = n.get("title") or "(untitled)"
        if execute:
            resp = client.delete(f"{BASE}/notes/{nid}")
            status = "DELETED" if resp.status_code == 200 else f"ERROR {resp.status_code}"
        else:
            status = "DRY RUN"
        print(f"  [{status}] #{nid}: {title[:80]}")

    if execute:
        print(f"\nDeleted {len(notes)} session notes.")
        # Delete the now-empty Sessions space too
        resp = client.delete(f"{BASE}/spaces/{space_id}")
        if resp.status_code == 200:
            print("Deleted Sessions space.")
        else:
            print(f"Could not delete Sessions space: {resp.status_code} {resp.text}")
    else:
        print(f"\nDry run — pass --execute to actually delete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    main(execute=args.execute)
