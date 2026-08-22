"""Dependency-free helpers.

The rule that keeps this package worth having: nothing in here may import
from `app.services`, `app.db` or `app.llm`. If a helper needs a model, a
session or a client, it belongs in a service.
"""
