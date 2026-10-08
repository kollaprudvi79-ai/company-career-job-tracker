"""Career Radar — async Python job-board collector.

Replaces the Node.js collector with an asyncio + aiohttp implementation:
24 concurrent workers, per-board timeouts, TF-IDF near-duplicate detection,
yield-based board prioritization, and weighted 0-100 fit scoring — while
keeping the jobs.json schema byte-compatible for the frontend.
"""
from .collector import Sweep
from .models import Board, BoardStatus, Job

__all__ = ["Sweep", "Board", "BoardStatus", "Job"]
__version__ = "20261007py"
