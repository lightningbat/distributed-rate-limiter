import type { Request, Response, NextFunction } from 'express';
import type { IncrementConfig } from './types.js';

export type RateLimitOptions = IncrementConfig & {
  /** Custom key generator logic. Defaults to checking the client's remote IP address. */
  keyGenerator?: (req: Request) => string;
  /** 
   * The CIDR block mask to cluster IPv6 clients. Defaults to 56.
   * Set to false to isolate clients strictly by individual unique IPv6 strings.
   */
  ipv6Subnet?: number | false;
  /** Custom handler for blocked clients. Defaults to an HTTP 429 response. */
  handler?: (req: Request, res: Response, next: NextFunction) => void;
}
