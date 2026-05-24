# Redis Live-State Migration Sketch

This document sketches the next architectural step after blue-green deploys: moving live session, queue, and encounter state out of the server process and into Redis.

The current server still keeps these structures in memory:

- `sessions`
- `queue`
- `encounters`

That is why deploys can be low-disruption now, but not fully seamless.

## 1. Goals

The Redis migration should make these possible:

- a client can reconnect after a release switch without losing its live session state
- two app releases can safely share the same live state during a drain window
- the app can eventually run more than one server instance behind the same proxy
- deploys no longer depend on waiting for the old process to keep in-memory state alive

## 2. Scope To Move First

Move the minimum live state needed for match flow continuity:

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

## 4. Server Refactor Phases

### Phase 1: Store Abstraction

Split the current server logic so live-state reads and writes go through a dedicated interface instead of directly touching Maps.

The first interface should cover:

- create and fetch session
- update profile
- join and leave queue
- create encounter
- read and write swipe state
- read and write call readiness
- mark session presence

Do not change behavior yet. Just isolate it.

### Phase 2: Dual-Write Shadow Mode

Keep the current in-memory Maps as the source of truth, but write the same mutations into Redis.

This phase is for proving the data model, not for cutover.

Success criteria:

- no behavior change for users
- Redis contains a faithful copy of live state
- logging can compare in-memory and Redis views on critical operations

### Phase 3: Read-From-Redis For Non-Critical Paths

Start reading selected state from Redis where mismatch risk is low, for example:

- health and deployment status counts
- queue visibility checks
- reconnect presence checks

Keep critical match transitions conservative until confidence is higher.

### Phase 4: Redis As Source Of Truth

Switch the match flow to Redis-backed state transitions.

At this phase, all release colors should operate on the same shared state.

You will likely need Redis transactions or Lua scripts around:

- claiming queue partners
- creating encounters atomically
- applying swipes and transitioning to `matched`
- handling disconnect grace windows safely

### Phase 5: Multi-Instance Routing

Once Redis is authoritative, add a small pub/sub layer so one server instance can notify another when a socket-owned session needs an event.

That means:

- release A can update state owned by release B
- signaling events can be forwarded reliably across instances
- deploys no longer require sticky old-release survival for correctness

## 5. Risks To Design Around

The tricky parts are not storage volume. They are concurrency and ownership.

Watch for these failure modes:

- two releases matching the same queued user at the same time
- stale disconnect timers ending encounters after a reconnect already happened elsewhere
- socket id ownership drifting across releases
- relay signaling trying to reach a socket connected to a different release

## 6. Minimal Success Definition

Do not overbuild the first refactor. A good first milestone is simply:

- users can reconnect during a blue-green deployment without losing their live session
- queue state survives a release shutdown
- old and new releases can both observe the same encounter state

If you achieve that, the deployment workflow becomes much more robust even before full horizontal scaling.