---
"statswhatshesaid": minor
---

Second-pass hardening found via a targeted re-audit. These fixes all sit inside the existing v0.1.0 window (still unreleased), so they roll into the first published release.

**Length-prefixed visitor hash construction.** `computeVisitorHash` now prepends a big-endian length header for each variable-length component (ip, ua) before feeding them into SHA-256. The previous `ip + ":" + ua + ":" + salt` encoding was input-ambiguous: with IPv6 addresses containing colons, two distinct `(ip, ua)` pairs could produce the same pre-image and therefore the same hash. Length-prefixing makes the pre-image unambiguous.

**Snapshot load is now crash-proof.** `VisitorStore.fromSnapshot` wraps both the same-day and cross-day branches in try/catch and degrades gracefully:

- Decoded salt length is validated (must be exactly 32 bytes) before use.
- Decoded HLL register length is validated (must be exactly `HLL_REGISTER_COUNT` bytes) before use. `Buffer.from(x, 'base64')` silently ignores malformed characters, so the base64 string-length check in `isValidSnapshot` alone was insufficient.
- On any decode/validation failure, the store starts fresh for the current day rather than throwing out of init. Up to a few minutes of same-day dedupe state is lost; the process stays up.

**Strict history validation.** `sanitizeHistory` drops any entry that isn't a real `YYYY-MM-DD` calendar date (validated via `Date.UTC` round-trip, rejecting `2026-02-30` and `2025-02-29`) mapped to a non-negative integer count. Entries for `currentDate` itself are dropped (today's count is owned by the live HLL). Protects against snapshot files poisoned by whoever has write access.

**Snapshot validator rejects arrays.** `isValidSnapshot` now explicitly rejects arrays for the `history` field. Previously `typeof [] === 'object'` let arrays through, which would then be iterated with numeric-string keys.

**Config sanity checks.** `resolveConfig` now validates:

- `flushIntervalMs` must be a positive integer ≥ 1000 ms (prevents `setInterval(tick, 0)` hot loops from a bad config).
- `historyDays` and `maxHistoryDays` must be non-negative integers.
- `endpointPath` must match `^/[A-Za-z0-9\-._~/]*$` — no whitespace, CR/LF, or shell metacharacters.

All throw loud, clear errors at config resolution time.

**New `isValidUtcDate` helper.** Shared between snapshot validation and history sanitization. Rejects calendrically-impossible dates like `2026-02-30` via `Date.UTC` round-trip, not just via regex.

**Tests.** 23 new hardening tests across four describe blocks covering the hash input-ambiguity fix, date validation, config validation, and graceful snapshot-load degradation. Total test count: 76 → 99, all green.
