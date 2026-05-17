"""Per-signal-type handlers used by `intent_router.dispatch`.

Each module owns its signal kind. Handlers take the raw signals array
(post-extract_signals), the RouterContext, and a RouterResult that they
mutate with what got routed.

Adding a new signal type:
  1. Add the key to extract_signals JSON schema.
  2. Add a handler module here.
  3. Wire it into intent_router.dispatch.

Phase 2 lite: handlers WRAP existing service calls (memory_service,
promise_service, feature_request_tool). Phase 3 will pull reconcile +
write logic into the handlers themselves, leaving services as thin CRUD.
"""
