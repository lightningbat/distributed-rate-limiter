import { EventEmitter } from 'events';
import { type RedisClientType } from 'redis';
import lua_script from './lua_script.js'
import { LRUCache } from 'lru-cache';

import type {
	CircuitState,
	RedisStoreOptions,
	IncrementConfig,
	RateLimitResult,
	InMemoryBucket
} from './types.js';

interface RedisStoreEvents {
	info: (msg: string) => void;
	warning: (msg: string) => void;
	error: (err: Error) => void;
}

export class RedisStore extends EventEmitter {
	private client: RedisClientType;
	private timeoutMs: number;
	private sha!: Promise<string>;

	// --- HARDWARE CONNECTIONS GUARD ---
	private isRedisConnected: boolean = true;

	// --- LATENCY CIRCUIT BREAKER STATE ---
	private circuitState: CircuitState = 'CLOSED';
	private failureCount: number = 0;
	private failureThreshold: number;
	private failureWindowMs: number;
	private windowStartTime: number = 0;

	// Cooldown & Jitter Parameters
	private baseCooldownMs: number;
	private maxCooldownMs: number;
	private consecutiveTrips: number = 0;
	private cooldownUntil: number = 0;

	// Local Memory Trackers
	private localFallbackCache: LRUCache<string, InMemoryBucket>;

	constructor(client: RedisClientType, options: RedisStoreOptions = {}) {
		super();
		this.client = client;
		this.timeoutMs = options.timeoutMs ?? 2000;
		this.failureThreshold = options.failureThreshold ?? 3;
		this.failureWindowMs = options.failureWindowMs ?? 10000;
		this.baseCooldownMs = options.minCooldownMs ?? 5000;
		this.maxCooldownMs = options.maxCooldownMs ?? 30000;

		this._initializeScript()
		this._attachClientListeners();


		const defaultSizeCalculator = (_: InMemoryBucket, key: string) => {
			// Each bucket object contains two 64-bit floating numbers (~16 bytes) 
			// + string key length footprint in V8 heap memory namespaces
			return 16 + key.length;
		};

		this.localFallbackCache = new LRUCache<string, InMemoryBucket>({
			max: options.localCacheOptions?.max || 5000,
			ttl: options.localCacheOptions?.ttl || 60000,
			maxSize: options.localCacheOptions?.maxSize || 30 * 1024 * 1024,
			sizeCalculation: options.localCacheOptions?.sizeCalculation || defaultSizeCalculator
		});

	}

	override emit<K extends keyof RedisStoreEvents>(event: K, ...args: Parameters<RedisStoreEvents[K]>): boolean {
		return super.emit(event, ...args);
	}

	override on<K extends keyof RedisStoreEvents>(event: K, listener: RedisStoreEvents[K]): this {
		return super.on(event, listener);
	}

	private _attachClientListeners(): void {
		this.client.on('connect', () => {
			this.isRedisConnected = true;
			this.emit('info', 'Redis client socket connected.');
		});

		this.client.on('ready', () => {
			this.isRedisConnected = true;
			if (this.circuitState !== 'CLOSED') {
				this.circuitState = 'CLOSED';
				this.failureCount = 0;
				this.consecutiveTrips = 0;
				this.emit('info', 'Redis client ready: Full circuit tracking restored.');
			}
		});

		this.client.on('reconnecting', () => {
			this.isRedisConnected = false;
			this.emit('warning', 'Redis client reporting reconnection attempt. Fast-failing active traffic.');
		});

		this.client.on('end', () => {
			this.isRedisConnected = false;
			this.emit('error', new Error('Redis connection ended completely. Core pipeline offline.'));
		});

		this.client.on('error', (err) => {
			this.emit('error', err);
		});
	}

	private _initializeScript(): void {
		this.sha = this.client.scriptLoad(lua_script).catch((err) => {
			this.emit('error', new Error(`Failed to prime Lua footprint on startup: ${err.message}`));
			// Return an empty string so the runtime pipeline can catch the failure 
			// via NOSCRIPT rather than crashing the constructor process loop completely
			return '';
		});
	}

	public async increment(key: string, config: IncrementConfig, isRetry = false): Promise<RateLimitResult> {
		const now = Date.now();

		// LAYER 1: Hard Connection Check (Instant 0ms Fast-Fail Bypass)
		if (!this.isRedisConnected) {
			return this._handleFallbackRouting(key, config);
		}

		// LAYER 2: Software High-Latency Open State Lock
		if (this.circuitState === 'OPEN') {
			if (now >= this.cooldownUntil) {
				this.circuitState = 'HALF-OPEN';
				this.emit('info', 'Circuit HALF-OPEN: Sending a single latency probe request to Redis.');
			} else {
				return this._handleFallbackRouting(key, config);
			}
		}

		// LAYER 3: The Stopwatch Race against Hidden Congestion
		try {
			const result = await Promise.race([
				this._executeRedis(key, config.limit, config.windowMs, config.redisTtl!),
				this._createTimeout(this.timeoutMs)
			]);

			// If we made it here, a live Redis call completed in time!
			if (this.circuitState === 'HALF-OPEN') {
				this.circuitState = 'CLOSED';
				this.failureCount = 0;
				this.consecutiveTrips = 0;
				this.emit('info', 'Circuit CLOSED: Redis latency profile has normalized.');
			}

			return result;

		} catch (err) {
			if ((err as Error).message.includes('NOSCRIPT')) {
				if (isRetry) {
					this.emit('error', new Error('NOSCRIPT loop detected. Script storage failing inside Redis pool.'));
				} else {

					this.emit('warning', 'Redis script cache cleared or missing. Re-uploading footprint...');

					this._initializeScript();
					await this.sha;

					return await this.increment(key, config, true);
				}
			}
			this._handleFailure(err as Error);
			return this._handleFallbackRouting(key, config);
		}
	}

	private _handleFailure(err: Error): void {
		const now = Date.now();

		// If our single testing probe request times out, slam the door immediately
		if (this.circuitState === 'HALF-OPEN') {
			this._tripCircuit(`Probe request failed/timed out: ${err.message}`);
			return;
		}

		// Rolling time window failure tracking
		if (now - this.windowStartTime > this.failureWindowMs) {
			this.windowStartTime = now;
			this.failureCount = 1;
		} else {
			this.failureCount++;
		}

		this.emit('warning', `Redis performance exception recorded (${this.failureCount}/${this.failureThreshold}): ${err.message}`);

		if (this.failureCount >= this.failureThreshold) {
			this._tripCircuit(`${this.failureThreshold} latency timeouts observed within a ${this.failureWindowMs / 1000}s sliding window`);
		}
	}

	private _tripCircuit(reason: string): void {
		this.consecutiveTrips++;
		this.circuitState = 'OPEN';

		// Dynamic exponential backoff calculation with a full random jitter
		const exponentialCalculated = this.baseCooldownMs * Math.pow(2, this.consecutiveTrips);
		const baseFloor = Math.min(exponentialCalculated, this.maxCooldownMs);

		const maxJitterBuffer = 3000;
		const addedJitter = Math.random() * maxJitterBuffer;

		const finalCooldownMs = baseFloor + addedJitter;

		this.cooldownUntil = Date.now() + finalCooldownMs;
		this.failureCount = 0;

		this.emit('error', new Error(
			`Circuit blown to OPEN due to slow database performance. Reason: ${reason}. ` +
			`Bypassing Redis network calls for ${(finalCooldownMs / 1000).toFixed(2)}s`
		));
	}

	private _handleFallbackRouting(key: string, config: IncrementConfig): RateLimitResult {
		if (config.strategy === 'REJECT' || config.strategy === 'FAIL_OPEN') {
			throw new Error('Redis store infrastructure currently offline or congested');
		}
		return this._executeInMemoryFallback(
			key,
			config as Extract<IncrementConfig, { strategy: 'IN_MEMORY' }>
		);
	}

	private _createTimeout(ms: number): Promise<never> {
		return new Promise((_, reject) =>
			setTimeout(() => reject(new Error('Redis command execution timed out')), ms)
		);
	}

	private async _executeRedis(key: string, limit: number, windowMs: number, ttl: number): Promise<RateLimitResult> {
		const resolvedSha = await this.sha;

		if (!resolvedSha) {
			throw new Error('NOSCRIPT: Script token allocation empty');
		}
		const rawResult = await this.client.evalSha(resolvedSha, {
			keys: [key],
			arguments: [String(limit), String(windowMs), String(ttl)]
		}) as [number, number];

		return {
			allowed: rawResult[0] === 1,
			remaining: Math.floor(rawResult[1])
		};
	}

	private _executeInMemoryFallback(
		key: string,
		config: Extract<IncrementConfig, { strategy: 'IN_MEMORY' }>
	): RateLimitResult {
		const now = Date.now();

		const refillRatePerMs = config.fallbackLimit / config.fallbackWindowMs;
		let bucket = this.localFallbackCache.get(key);

		if (!bucket) {
			bucket = {
				tokens: config.fallbackLimit,
				lastFill: now
			};
		} else {
			const elapsedMs = Math.max(0, now - bucket.lastFill);

			bucket.tokens = Math.min(
				config.fallbackLimit,
				bucket.tokens + (elapsedMs * refillRatePerMs)
			);
			bucket.lastFill = now;
		}

		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			this.localFallbackCache.set(key, bucket);
			return { allowed: true, remaining: Math.floor(bucket.tokens) };
		}

		this.localFallbackCache.set(key, bucket);
		return { allowed: false, remaining: 0 };
	}
}
