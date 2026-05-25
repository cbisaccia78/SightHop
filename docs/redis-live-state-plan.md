# Redis Live-State Notes

This document records the live-state architecture used by the server after the Redis migration for blue-green deploys.

The server now stores these structures in Redis:

- `sessions`
- `queue`
- `encounters`
- `presence`

That lets two release colors share live matchmaking state during a drain window and lets clients reconnect through a release switch without losing their session record.

## 1. Current Goals

The Redis migration should make these possible:

- a client can reconnect after a release switch without losing its live session state
- two app releases can safely share the same live state during a drain window
- the app can eventually run more than one server instance behind the same proxy
- deploys no longer depend on waiting for the old process to keep in-memory state alive

## 2. Data Stored In Redis

The current live-state layer stores the minimum state needed for match flow continuity:

1. session records
2. queue entries
3. encounters and swipe state
4. socket-to-session presence information

Keep metrics, reports, and blocks where they already are for now.

## 3. Redis Data Model Sketch

Suggested first-pass keys:

- `session:{sessionId}`
  - hash or JSON
  - fields: profile, blocked ids, active encounter id, current socket id, updated at

- `queue:{matchMode}`
  - sorted set keyed by `joinedAt`
  - value: `sessionId`

- `encounter:{encounterId}`
  - hash or JSON
  - fields: session ids, state, swipes, room id, ready session ids, created at

- `presence:{sessionId}`
  - short-lived key with TTL
  - value: socket id or release id

- `release:{releaseName}:sessions`
  - set of session ids currently connected to a given release
  - useful during drain and cutover analysis

## 4. Next Phases

### Phase 1: Hardening

Keep the live-state abstraction narrow and add stronger operational safeguards.

Useful hardening work includes:

- TTL review for long-running calls and reconnect windows
- stronger cleanup for abandoned encounter keys
- explicit metrics around cross-instance event forwarding

### Phase 2: Stronger Atomicity

The current implementation serializes match-making through a Redis lock. If contention rises, move the critical transitions behind Redis transactions or Lua scripts around:

- claiming queue partners
- creating encounters atomically
- applying swipes and transitioning to `matched`
- handling disconnect grace windows safely

### Phase 3: Multi-Instance Routing

The server already uses a small pub/sub layer so one server instance can notify another when a socket-owned session needs an event.

Useful follow-up work here is:

- delivery acknowledgements for critical forwarded events
- optional replay or recovery for reconnect races
- richer release-level observability

## 5. Risks To Design Around

The tricky parts are not storage volume. They are concurrency and ownership.

Watch for these failure modes:

- two releases matching the same queued user at the same time
- stale disconnect timers ending encounters after a reconnect already happened elsewhere
- socket ownership drifting across releases
- relay signaling trying to reach a socket connected to a different release

## 6. Minimal Success Definition

The current migration is successful if:

- users can reconnect during a blue-green deployment without losing their live session
- queue state survives a release shutdown
- old and new releases can both observe the same encounter state

Those properties make the deployment workflow much more robust even before full horizontal scaling.