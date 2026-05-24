# Resilient Rate Limiter

A Redis-backed Express rate-limiting middleware written in TypeScript with automatic degraded-mode fallback handling.

Under normal operation, request quotas are coordinated through a Redis Lua token bucket. If Redis becomes unavailable or request latency exceeds a configured timeout threshold, the middleware can automatically reroute requests through configurable fallback execution paths instead of blocking the Express request pipeline.

**Supported fallback behaviors:**

* in-memory token bucket enforcement
* fail-open request bypass
* immediate HTTP 503 rejection

The in-memory fallback implementation uses a memory-bounded LRU cache to prevent unbounded key growth during Redis outages.


## Failure Handling

The middleware contains two independent protection layers for degraded Redis conditions.

### Connection-State Circuit

The Redis client connection listener acts as the first circuit layer.

When the Redis connection drops:

* Redis execution attempts are bypassed entirely
* requests immediately transition into fallback handling
* no additional network calls are attempted

The circuit automatically closes once Redis connectivity is restored.

### Execution Timeout Circuit

A second circuit layer protects against Redis latency spikes rather than complete disconnection.

Each Redis operation is wrapped in a timeout guard using `Promise.race`.

If execution exceeds the configured timeout threshold:

```ts id="t9rjlwm"
timeoutMs: 50
```

the request is treated as failed even if Redis eventually responds later.

Sequential failures are tracked inside a rolling time window:

```ts id="pqqq3v"
failureThreshold: 3
failureWindowMs: 5000
```

Once the threshold is exceeded, requests transition into fallback execution paths.

This prevents Express request handlers from remaining blocked behind slow infrastructure dependencies.


## Fallback Strategies

### IN_MEMORY

Requests are rerouted into a local token bucket implementation.

The fallback limiter can use an independent quota configuration:

```ts id="y2z4eq"
fallbackLimit: 5,
fallbackWindowMs: 60000
```

### FAIL_OPEN

Infrastructure failures are ignored and requests continue directly to route execution.

This strategy prioritizes endpoint availability over rate enforcement consistency.

### REJECT

Requests are immediately terminated with HTTP `503 Service Unavailable`.

This strategy can be used to reduce additional downstream load during infrastructure instability.


## Rate Limiting Strategy

The middleware uses the token bucket algorithm for both Redis-backed and local fallback enforcement.

Under normal operation, quota state is coordinated through a Redis Lua script executed via `EVALSHA`.


## IP Address Normalization

The default key generator normalizes incoming client IPs before bucket generation.

### IPv6 Subnet Grouping

IPv6 clients are grouped using a `/56` subnet mask to reduce key cardinality caused by temporary interface rotation.

Without subnet grouping, clients rotating IPv6 addresses could generate excessive unique bucket keys inside memory stores.

### IPv4-Mapped IPv6 Handling

Addresses in the following format:

```text id="v0t3n1"
::ffff:x.x.x.x
```

are normalized back into standard IPv4 notation before key generation.


## Example Usage

```ts id="9x5ll2"
import express from 'express';
import { createClient } from 'redis';
import { RedisStore, rateLimiter } from 'resilient-rate-limiter';

const app = express();

app.set('trust proxy', 1);

const redisClient = createClient({
  url: 'redis://localhost:6379'
});

await redisClient.connect();

const store = new RedisStore(redisClient, {
  timeoutMs: 50,
  failureThreshold: 3,
  failureWindowMs: 5000,

  localCacheOptions: {
    max: 5000
  }
});

app.use('/api/v1/resource', rateLimiter(store, {
  strategy: 'IN_MEMORY',

  limit: 100,
  windowMs: 60000,

  fallbackLimit: 5,
  fallbackWindowMs: 60000,

  redisTtlSec: 60
}));
```
