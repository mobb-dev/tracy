#!/usr/bin/env python3
"""
Mobb AI Tracer — Cursor DB Diagnostic Script
=============================================
Run on an affected user's machine to collect raw data about
Cursor's internal database for analysis by the Mobb team.

Usage:
    python3 diagnose_cursor_db.py

Requirements:
    - Python 3.8+
    - sqlite3 (built-in)
    - macOS, Linux, or Windows
"""

import json
import os
import platform
import sqlite3
import sys
import time
from pathlib import Path


BOLD = "\033[1m"
RESET = "\033[0m"


def bold(text: str) -> str:
    if not sys.stdout.isatty():
        return text
    return f"{BOLD}{text}{RESET}"


def resolve_db_path() -> Path | None:
    """Locate Cursor's state.vscdb on the current platform."""
    system = platform.system()
    home = Path.home()

    if system == "Darwin":
        base = home / "Library" / "Application Support" / "Cursor" / "User" / "globalStorage"
    elif system == "Linux":
        xdg = os.environ.get("XDG_CONFIG_HOME", str(home / ".config"))
        base = Path(xdg) / "Cursor" / "User" / "globalStorage"
    elif system == "Windows":
        appdata = os.environ.get("APPDATA", str(home / "AppData" / "Roaming"))
        base = Path(appdata) / "Cursor" / "User" / "globalStorage"
    else:
        return None

    db = base / "state.vscdb"
    return db if db.exists() else None


def collect_file_sizes(db_path: Path) -> list[str]:
    lines: list[str] = []
    lines.append(bold("\n1. File sizes"))

    db_size_mb = db_path.stat().st_size / (1024 * 1024)
    lines.append(f"   state.vscdb:     {db_size_mb:.1f} MB")

    wal_path = db_path.parent / "state.vscdb-wal"
    if wal_path.exists():
        wal_size_mb = wal_path.stat().st_size / (1024 * 1024)
        lines.append(f"   state.vscdb-wal: {wal_size_mb:.1f} MB")
    else:
        lines.append(f"   state.vscdb-wal: not found")

    shm_path = db_path.parent / "state.vscdb-shm"
    if shm_path.exists():
        shm_size_kb = shm_path.stat().st_size / 1024
        lines.append(f"   state.vscdb-shm: {shm_size_kb:.1f} KB")

    return lines


def collect_journal_mode(conn: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    lines.append(bold("\n2. Journal mode"))

    mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
    lines.append(f"   journal_mode: {mode}")

    return lines


def collect_row_counts(conn: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    lines.append(bold("\n3. Row counts"))

    total = conn.execute("SELECT COUNT(*) FROM cursorDiskKV;").fetchone()[0]
    lines.append(f"   Total rows:            {total:,}")

    bubble_count = conn.execute(
        "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';"
    ).fetchone()[0]
    lines.append(f"   bubbleId:* rows:       {bubble_count:,}")

    composer_count = conn.execute(
        "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';"
    ).fetchone()[0]
    lines.append(f"   composerData:* rows:   {composer_count:,}")

    content_count = conn.execute(
        "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'composer.content.%';"
    ).fetchone()[0]
    lines.append(f"   composer.content.* rows: {content_count:,}")

    return lines


def collect_query_timing(conn: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    lines.append(bold("\n4. Poll query timing"))

    sql = """
        SELECT COUNT(*) FROM cursorDiskKV
        WHERE key LIKE 'bubbleId:%'
        AND json_extract(value, '$.toolFormerData.name') IN
          ('search_replace','apply_patch','write','edit_file','edit_file_v2','MultiEdit')
    """

    # Warm up
    conn.execute(sql).fetchone()

    # Timed runs
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        count = conn.execute(sql).fetchone()[0]
        elapsed_ms = (time.perf_counter() - t0) * 1000
        times.append(elapsed_ms)

    avg_ms = sum(times) / len(times)
    lines.append(f"   Matching file-edit bubbles: {count:,}")
    lines.append(f"   Query time (avg of 3):      {avg_ms:.1f} ms")
    lines.append(f"   Query times (individual):   {', '.join(f'{t:.1f}' for t in times)} ms")

    # composerData scan
    t0 = time.perf_counter()
    composer_count = conn.execute(
        "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
    ).fetchone()[0]
    elapsed_ms = (time.perf_counter() - t0) * 1000
    lines.append(f"   composerData scan:          {composer_count:,} rows in {elapsed_ms:.1f} ms")

    return lines


def collect_conversation_sizes(conn: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    lines.append(bold("\n5. Conversation sizes (top 10)"))

    rows = conn.execute(
        """
        SELECT key, value FROM cursorDiskKV
        WHERE key LIKE 'composerData:%'
        ORDER BY length(value) DESC
        LIMIT 20
        """
    ).fetchall()

    if not rows:
        lines.append("   No composer data found")
        return lines

    conversations: list[tuple[str, int]] = []
    for key, value in rows:
        try:
            data = json.loads(value)
            headers = data.get("fullConversationHeadersOnly", [])
            size = len(headers) if headers else 0
            conversations.append((key, size))
        except (json.JSONDecodeError, TypeError):
            continue

    conversations.sort(key=lambda x: x[1], reverse=True)
    for key, size in conversations[:10]:
        composer_id = key.split(":", 1)[1] if ":" in key else key
        lines.append(f"   {composer_id[:40]}: {size} bubbles")

    return lines


def collect_large_content(conn: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    lines.append(bold("\n6. Largest content blobs (top 10)"))

    rows = conn.execute(
        """
        SELECT key, length(value) as size FROM cursorDiskKV
        WHERE key LIKE 'composer.content.%'
        ORDER BY size DESC
        LIMIT 10
        """
    ).fetchall()

    if not rows:
        lines.append("   No composer.content entries found")
        return lines

    for key, size in rows:
        content_id = key.split(".", 2)[2] if key.count(".") >= 2 else key
        lines.append(f"   {content_id[:40]}: {size / 1024:.1f} KB")

    return lines


def collect_indexes(conn: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    lines.append(bold("\n7. Indexes on cursorDiskKV"))

    indexes = conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='cursorDiskKV';"
    ).fetchall()

    if not indexes:
        lines.append("   No indexes found")
    else:
        for name, sql in indexes:
            lines.append(f"   {name}: {sql}")

    return lines


def collect_bubble_sizes(conn: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    lines.append(bold("\n8. Bubble data sizes"))

    total_bubble_size = conn.execute(
        "SELECT SUM(length(value)) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';"
    ).fetchone()[0] or 0

    lines.append(f"   Total bubble data: {total_bubble_size / (1024 * 1024):.1f} MB")

    rows = conn.execute(
        """
        SELECT key, length(value) as size FROM cursorDiskKV
        WHERE key LIKE 'bubbleId:%'
        ORDER BY size DESC
        LIMIT 5
        """
    ).fetchall()

    lines.append(f"   Top 5 largest:")
    for key, size in rows:
        lines.append(f"     {key[:60]}: {size / 1024:.0f} KB")

    return lines


def main() -> None:
    print(bold("\nMobb AI Tracer — Cursor DB Diagnostic Report"))
    print(f"Date:     {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Platform: {platform.system()} {platform.release()}")

    db_path = resolve_db_path()
    if not db_path:
        print("\nCould not locate Cursor's state.vscdb")
        print("Expected locations:")
        print("  macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")
        print("  Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb")
        print("  Windows: %APPDATA%/Cursor/User/globalStorage/state.vscdb")
        sys.exit(1)

    print(f"DB path:  {db_path}")

    for line in collect_file_sizes(db_path):
        print(line)

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.OperationalError as e:
        print(f"\nCannot open database: {e}")
        sys.exit(1)

    try:
        for collect in [
            collect_journal_mode,
            collect_row_counts,
            collect_query_timing,
            collect_conversation_sizes,
            collect_large_content,
            collect_indexes,
            collect_bubble_sizes,
        ]:
            try:
                for line in collect(conn):
                    print(line)
            except sqlite3.OperationalError as e:
                print(f"   Error: {e}")
    finally:
        conn.close()

    print(bold("\n---\n"))


if __name__ == "__main__":
    main()
