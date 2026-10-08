"""Remove dead boards (zero jobs) from directory-sources.json."""
import json
from pathlib import Path

repo = Path(".")
with open(repo / "directory-sources.json") as f:
    boards = json.load(f)

with open(repo / "jobs.json") as f:
    jobs_data = json.load(f)

jobs = jobs_data.get("jobs", [])
active_keys = set(j.get("boardKey") for j in jobs if j.get("boardKey"))

alive = []
for b in boards:
    key = f"{b.get('type')}:{b.get('token')}"
    if key in active_keys:
        alive.append(b)

print(f"Before: {len(boards)}, After: {len(alive)}, Removed: {len(boards)-len(alive)}")

with open(repo / "directory-sources.json", "w") as f:
    json.dump(alive, f, indent=1)

print("Cleaned directory written")
