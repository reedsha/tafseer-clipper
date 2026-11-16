"""Shared service exceptions (kept dependency-free to avoid import cycles)."""

from __future__ import annotations


class LLMError(RuntimeError):
    """Raised when the configured provider cannot be reached or misbehaves."""
