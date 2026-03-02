import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { RedisClientType } from 'redis'
import lua_script from './lua_script.js'

class Store {
	private sha: Promise<string>;

	constructor(public client: RedisClientType) {
		this.sha = this.loadScript()
	}

	async loadScript() {
		return await this.client.scriptLoad(lua_script)
	}

	async increment(key: string, limit: number, refill_rate: number, now: number) {
		const evalCommand = (async () => this.client.evalSha(await this.sha, {
			keys: [`rl:user:${key}`],
			arguments: [
				limit.toString(),
				refill_rate.toString(),
				now.toString()
			]
		}))

		try {
			return await evalCommand()
		} catch (err) {
			if ((err as Error).message.includes('NOSCRIPT')) {
				await this.loadScript()
			}
			return await evalCommand()
		}
	}
}

function rateLimit(options: { store: Store, limit: number, window: number }): RequestHandler {
	const { store, limit, window } = options

	return async (req: Request, res: Response, next: NextFunction) => {
		const key = req.ip || "";
		const now = Date.now()
		const result = await store.increment(key, limit, limit / window, now)

		if (!result) {
			return res.status(429).send()
		}

		next()
	}
}

export {
	Store,
	rateLimit,
};
