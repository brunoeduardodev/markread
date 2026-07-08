# Valkey in TypeScript: An Invisible, Type-Safe Cache Layer

> The goal: caching so seamless your business logic never knows it exists. No `JSON.parse` scattered around, no stringly-typed keys, no cache-invalidation folklore — just functions that happen to be fast.

This guide builds a small wrapper around [Valkey](https://valkey.io) (the open-source Redis fork) that gives you:

- **Type-safe reads and writes** — values round-trip through schemas, not `any`
- **Invisible caching** — wrap any async function; callers can't tell it's cached
- **Typed key builders** — no more `` `user:${id}:profile` `` typos
- **Sane invalidation** — tag-based, batched, and explicit

Estimated setup time: about 15 minutes.

## Why Valkey?

Valkey is the Linux Foundation fork of Redis 7.2, created after the 2024 license change. Same protocol, same commands, same performance profile — but permissively licensed (BSD-3) and community-governed.

| Concern | Valkey answer |
| --- | --- |
| Protocol | RESP2/RESP3 — any Redis client works |
| License | BSD-3-Clause |
| Client we'll use | `iovalkey` (maintained ioredis fork) |
| Typical latency | sub-millisecond for GET/SET in-region |

Because the wire protocol is unchanged, everything in this guide also works against Redis, KeyDB, or Dragonfly. The wrapper is the point — the backend is a detail.

## Installation

```bash
npm install iovalkey zod
```

Two dependencies, deliberately:

1. `iovalkey` — the connection and commands
2. `zod` — runtime validation so cached JSON can't lie about its type

## Step 1 — A connection that behaves

```typescript
// cache/connection.ts
import Valkey from 'iovalkey';

export const valkey = new Valkey({
  host: process.env.VALKEY_HOST ?? 'localhost',
  port: Number(process.env.VALKEY_PORT ?? 6379),
  // Fail fast in dev, retry gently in prod
  maxRetriesPerRequest: 2,
  retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  // Don't buffer commands while disconnected — surface problems immediately
  enableOfflineQueue: false,
});

valkey.on('error', (err) => {
  console.warn('[valkey] connection error:', err.message);
});
```

> A cache must be allowed to fail. Every design decision downstream assumes Valkey can disappear and the app keeps working — slower, but working.

## Step 2 — Typed keys

Stringly-typed keys are where cache bugs are born. Make the compiler own them:

```typescript
// cache/keys.ts
export const keys = {
  userProfile: (userId: string) => `user:${userId}:profile` as const,
  userOrders: (userId: string) => `user:${userId}:orders` as const,
  productBySlug: (slug: string) => `product:${slug}` as const,
  searchResults: (query: string, page: number) =>
    `search:${encodeURIComponent(query)}:p${page}` as const,
} satisfies Record<string, (...args: never[]) => string>;
```

Every key in the codebase now lives in one file, is discoverable by autocomplete, and can't be misspelled.

## Step 3 — The schema-validated cell

The core primitive: a `cell` couples a key pattern with a Zod schema. Reading returns `T | null` — never `any`, never a surprise shape.

```typescript
// cache/cell.ts
import { z } from 'zod';
import { valkey } from './connection.js';

export interface Cell<T> {
  get(): Promise<T | null>;
  set(value: T, ttlSeconds?: number): Promise<void>;
  delete(): Promise<void>;
}

export function cell<T>(key: string, schema: z.ZodType<T>, defaultTtl = 300): Cell<T> {
  return {
    async get() {
      try {
        const raw = await valkey.get(key);
        if (raw === null) return null;
        const parsed = schema.safeParse(JSON.parse(raw));
        // A stale or corrupt entry is a miss, not a crash
        return parsed.success ? parsed.data : null;
      } catch {
        return null; // cache down = cache miss
      }
    },
    async set(value, ttlSeconds = defaultTtl) {
      try {
        await valkey.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      } catch {
        // Writing to a dead cache is a no-op, not an error
      }
    },
    async delete() {
      try {
        await valkey.del(key);
      } catch {
        /* same philosophy */
      }
    },
  };
}
```

Three properties worth noticing:

- [x] Corrupt JSON → miss (schema rejects it)
- [x] Valkey outage → miss (try/catch converts to `null`)
- [x] Type parameter flows from the schema — `cell(k, UserSchema)` *is* a `Cell<User>`

## Step 4 — The invisible layer: `cached()`

Now the piece that makes caching disappear. `cached()` takes any async function and returns a function with the **identical signature**:

```typescript
// cache/cached.ts
import { z } from 'zod';
import { cell } from './cell.js';

interface CachedOptions<Args extends unknown[], T> {
  key: (...args: Args) => string;
  schema: z.ZodType<T>;
  ttl?: number;
  tags?: (...args: Args) => string[];
}

export function cached<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
  options: CachedOptions<Args, T>,
): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    const slot = cell(options.key(...args), options.schema, options.ttl);

    const hit = await slot.get();
    if (hit !== null) return hit;

    const fresh = await fn(...args);
    await slot.set(fresh);
    if (options.tags) await registerTags(options.key(...args), options.tags(...args));
    return fresh;
  };
}
```

### Using it

```typescript
// services/users.ts
import { z } from 'zod';
import { cached } from '../cache/cached.js';
import { keys } from '../cache/keys.js';
import { db } from '../db.js';

const UserProfile = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  plan: z.enum(['free', 'pro', 'team']),
});

export const getUserProfile = cached(
  async (userId: string) => db.users.findProfile(userId),
  {
    key: keys.userProfile,
    schema: UserProfile,
    ttl: 600,
    tags: (userId) => [`user:${userId}`],
  },
);
```

And the call site — this is the whole trick — looks like the cache doesn't exist:

```typescript
const profile = await getUserProfile('u_42');
//    ^? { id: string; name: string; email: string; plan: "free" | "pro" | "team" }
```

No `.getOrSet()`, no cache client in scope, no serialization in sight. Swap `cached(fn, …)` for plain `fn` and nothing else in the codebase changes.

## Step 5 — Invalidation without folklore

Tag-based invalidation: when a user changes, kill everything tagged with them.

```typescript
// cache/tags.ts
import { valkey } from './connection.js';

export async function registerTags(key: string, tags: string[]): Promise<void> {
  const pipeline = valkey.pipeline();
  for (const tag of tags) pipeline.sadd(`tag:${tag}`, key);
  await pipeline.exec();
}

export async function invalidateTag(tag: string): Promise<void> {
  const keys = await valkey.smembers(`tag:${tag}`);
  if (keys.length === 0) return;
  await valkey.del(...keys, `tag:${tag}`);
}
```

```typescript
// After a profile update:
await db.users.update(userId, patch);
await invalidateTag(`user:${userId}`);
```

The write path names *what changed*, not *which keys to delete*. The mapping lives with the cached function definitions, where it belongs.

## The complete picture

```typescript
// One import for consumers:
export { getUserProfile } from './services/users.js';

// The entire cache layer, from the caller's perspective:
const profile = await getUserProfile('u_42'); // fast, typed, invisible
```

| Failure mode | Behavior |
| --- | --- |
| Valkey down | Functions fall through to source, app stays up |
| Corrupt/stale JSON shape | Schema rejects → treated as miss → refetched |
| Key typo | Impossible — keys are functions, not strings |
| Forgotten invalidation | TTL is the backstop; tags are the tool |

## Footguns to avoid

1. **Don't cache nulls without deciding to.** `null` means "miss" in this design — if "user not found" is cacheable for you, wrap results in `{ found: boolean; value?: T }`.
2. **Don't share one giant schema.** Cache the shape you *read*, not the whole DB row — smaller payloads, fewer invalidations.
3. **Don't stampede.** If a hot key expires under load, every request refetches at once. Add a soft-TTL refresh or a per-key mutex before it matters.[^1]
4. **Don't use `KEYS` in production.** Tag sets (as above) exist precisely so you never scan the keyspace.

[^1]: A simple approach: store `expiresAt` inside the payload, serve stale-while-revalidating in a `setTimeout(0)`, and let exactly one caller refresh.

---

*Written as a markread demo document — long-form, code-heavy, structured the way AI-generated technical docs tend to be.*
