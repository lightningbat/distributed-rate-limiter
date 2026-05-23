import { LRUCache } from 'lru-cache';

/**
 * Represents the current operational posture of the database circuit.
 * - CLOSED: Healthy. Traffic routes directly through Redis.
 * - OPEN: Degraded. Redis is timing out; traffic bypasses Redis to safeguard latency.
 * - HALF-OPEN: Testing. Allows a single canary probe to check if Redis has recovered.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF-OPEN';

/**
 * The fallback strategy applied when the Redis communication layer is compromised.
 * - 'FAIL_OPEN': Unchecked access. Bypasses rate-limiting altogether to preserve uptime.
 * - 'IN_MEMORY': Degraded isolation. Falls back to individual server RAM tracking pools.
 * - 'REJECT': Strict lock. Instantly returns an HTTP 503 error to protect backend security/costs.
 */
export type FailureStrategy = 'FAIL_OPEN' | 'IN_MEMORY' | 'REJECT';

/**
 * Global configurations managing connection tolerances and circuit-breaker behavior inside the Store.
 */
export interface RedisStoreOptions {
	/**
	 * Maximum duration (in milliseconds) to wait for a Redis response before forcing a timeout failure.
	 * @default 2000
	 */
	timeoutMs?: number;

	/**
	 * The number of continuous latency timeouts required within the `failureWindowMs` to trip the circuit open.
	 * @default 3
	 */
	failureThreshold?: number;

	/**
	 * The rolling timeframe window (in milliseconds) where failures are tracked for threshold checks.
	 * @default 10000 (10 seconds)
	 */
	failureWindowMs?: number;

	/**
	 * The foundational rest duration (in milliseconds) applied on the first circuit trip before attempting a probe.
	 * @default 5000 (5 seconds)
	 */
	minCooldownMs?: number;

	/**
	 * The maximum cap (in milliseconds) for exponential backoff during prolonged outages.
	 * @default 30000 (30 seconds)
	 */
	maxCooldownMs?: number;

	localCacheOptions?: {
		/**
		* Absolute maximum number of unique items allowed in the cached
		* @default 5000
		*/
		max?: number;
		/** 
		* The upper limit bound for total calculated item size weights combined 
		* @default 31457280 (30 MB)
		*/
		maxSize?: number;
		/** Function used to calculate the specific size weight value of individual cached entries */
		sizeCalculation: LRUCache.SizeCalculator<string, InMemoryBucket>;
		/**
		* How long (in ms) to preserve an idle item in the local cache loop
		* @default 60000 (60 sec)
		*/
		ttl?: number;
	};
}

/**
 * Contextual route details passed down by the Express middleware factory during an execution pass.
 */
interface BaseIncrementConfig {
	/** The global token volume maximum configured for healthy runtime operations inside Redis. */
	limit: number;
	/** The timeframe scope window (in milliseconds) across which the global token allocation resets. */
	windowMs: number;
	/**
	* How long (in ms) to preserve an idle item in the Reids databseloop
	* @default 60000 (60 sec)
	*/
	redisTtl?: number;
}


export type IncrementConfig =
	| (BaseIncrementConfig & {
		strategy: 'IN_MEMORY';
		/**
		 * The token capacity limit assigned strictly to an individual server's local RAM loop if `strategy` is 'IN_MEMORY'.
		 * Allows you to clamp quotas down tightly during network splits to protect downstream servers.
		 */
		fallbackLimit: number;
		/**
		 * The token capacity limit assigned strictly to an individual server's local RAM loop if `strategy` is 'IN_MEMORY'.
		 * Allows you to clamp quotas down tightly during network splits to protect downstream servers.
		 */
		fallbackWindowMs: number;
	})
	| (BaseIncrementConfig & {
		strategy: 'FAIL_OPEN' | 'REJECT';
		// Make them entirely optional or force them to be omitted
		fallbackLimit?: never;
		fallbackWindowMs?: never;
	});

/**
 * The unified return signature passed back from data tracking to the HTTP routing layer.
 */
export interface RateLimitResult {
	/** Indicates if the client request fell within their allocated token threshold and is safe to execute. */
	allowed: boolean;

	/** The remaining integer value of whole tokens current to this client identifier inside this active scope window. */
	remaining: number;
}

/**
 * Structural frame holding real-time metrics inside local server RAM loops.
 */
export interface InMemoryBucket {
	/** Current residual floating decimal count of active tokens available for this key. */
	tokens: number;

	/** Timestamp (Unix Epoch ms) showing when the local memory track was last updated or hit with a token drain. */
	lastFill: number;
}
