import sqlite3
from dateutil import parser
import re

DB_PATH = '../database.sqlite'

# Regex to match ISO datetime with offset
ISO_WITH_OFFSET = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$")

def main():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Select all moods with a datetime containing a timezone offset
    cursor.execute("SELECT id, datetime, timezone FROM moods")
    rows = cursor.fetchall()
    updated = 0

    for row in rows:
        mood_id, dt_str, tz = row
        if dt_str is None:
            continue
        # Only process if datetime has an offset
        if ISO_WITH_OFFSET.search(dt_str):
            dt = parser.isoparse(dt_str)
            # Get local date/time string (no offset)
            local_dt_str = dt.strftime('%Y-%m-%dT%H:%M:%S')
            # Get offset as string (e.g., '-04:00')
            offset = dt.strftime('%z')
            if offset:
                offset = offset[:3] + ':' + offset[3:]
            else:
                offset = None
            # If timezone column is empty, set to offset
            new_tz = tz or offset
            # Update the row
            cursor.execute(
                "UPDATE moods SET datetime = ?, timezone = ? WHERE id = ?",
                (local_dt_str, new_tz, mood_id)
            )
            updated += 1

    conn.commit()
    print(f"Updated {updated} mood rows.")
    conn.close()

if __name__ == '__main__':
    main() 