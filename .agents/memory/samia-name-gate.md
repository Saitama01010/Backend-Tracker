---
name: Samia name-gate displayName
description: When Samia chat should use the real account name vs the typed name
---
- Samia chat (`POST /samia/chat`) accepts an optional `displayName` from a name-gate prompt; for general replies it prefers `displayName?.trim() || req.user.username`.
- **Rule:** any logic that asserts *who the user actually is* (e.g. the curse "fuck you {name}" reply, audit/identity) must use `req.user.username`, NOT `displayName`.
- **Why:** `displayName` is cached per-device (localStorage). A shared/borrowed device keeps the previous person's name, so a cursed user "jenna" was getting "fuck you Youssef" (the app owner's cached name).
- **How to apply:** treat `displayName` as a cosmetic greeting only; never as identity.
