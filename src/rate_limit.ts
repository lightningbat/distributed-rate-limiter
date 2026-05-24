import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { RedisStore } from './redis_store.js';
import type { RateLimitOptions } from './middleware.js';
import { ipKeyGenerator } from './ip_key_generator.js';
import type { IncrementConfig } from './types.js';

export function rateLimiter(store: RedisStore, options: RateLimitOptions): RequestHandler {
	const ipv6Subnet = options.ipv6Subnet ?? 56;

	const keyGenerator = options.keyGenerator ?? ((req: Request) => ipKeyGenerator(req.ip ?? '', ipv6Subnet));

	const defaultHandler = (_: Request, res: Response) => {
		res.status(429).json({
			status: 429,
			error: 'Too Many Requests',
			message: 'Rate limit quota exceeded. Please slow down.'
		});
	};

	const handler = options.handler ?? defaultHandler;

	const storeConfig = {
		limit: options.limit,
		windowMs: options.windowMs,
		redisTtl: options?.redisTtl || 60000,
		strategy: options.strategy,
		...(options.strategy === 'IN_MEMORY' ? {
			fallbackLimit: options.fallbackLimit,
			fallbackWindowMs: options.fallbackWindowMs,
		} : {})
	} as IncrementConfig;

	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		const key = keyGenerator(req);
		const reqTimeStamp = Date.now()

		try {
			const result = await store.increment(key, storeConfig, reqTimeStamp);

			const activeLimit = result.executionMode === 'IN_MEMORY'
				? options.fallbackLimit
				: options.limit;

			res.setHeader('X-RateLimit-Limit', activeLimit!);
			res.setHeader('X-RateLimit-Remaining', result.remaining);
			res.setHeader('X-RateLimit-Mode', result.executionMode);

			if (!result.allowed) {
				return handler(req, res, next);
			}

			return next();

		} catch (err) {
			// EXCEPTION PATHWAY: Redis is dead/timing out, AND strategy is set to REJECT or FAIL_OPEN
			// (if strategy is IN_MEMORY, the store catches the error internally and handles it)

			if (options.strategy === 'REJECT') {
				res.setHeader('Retry-After', '60');
				res.status(503).json({
					status: 503,
					error: 'Service Temporarily Unavailable',
					message: 'Security protection layer active. Please retry shortly.'
				});
				return;
			}

			if (options.strategy === 'FAIL_OPEN') {
				res.setHeader('X-RateLimit-Fallback', 'FAIL_OPEN');
				return next();
			}

			// If an unhandled edge-case exception bubbles up, pass it down to Express's central error handler
			return next(err);
		}
	};
}
