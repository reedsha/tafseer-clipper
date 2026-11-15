"""Cooperative cancellation for long-running sidecar jobs.

The REST surface is fixed (six routes, AGENTS.md §3), so cancellation rides on
the HTTP client disconnect: the request handlers race the long work against
``await request.is_disconnected()``, set the shared :class:`threading.Event`
below, and the services raise :class:`JobCancelled` at their natural
boundaries (transcription segment loop, discovery window loop). Async work
additionally gets the task cancelled, which aborts in-flight provider calls.
"""

from __future__ import annotations

import threading


class JobCancelled(Exception):
    """Raised by a service when the HTTP client disconnected mid-job.

    The handlers swallow it (the client is gone; no response can be delivered)
    after cleaning up any partial artifacts.
    """


def raise_if_cancelled(cancel_event: threading.Event | None) -> None:
    """Raise :class:`JobCancelled` when ``cancel_event`` is set (or None-safe)."""
    if cancel_event is not None and cancel_event.is_set():
        raise JobCancelled("The client disconnected; the job was cancelled.")
