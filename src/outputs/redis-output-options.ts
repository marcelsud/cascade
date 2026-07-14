import type { RedisOptions } from "ioredis";

export interface RedisOutputConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db?: number;
  readonly connectTimeout?: number;
  readonly commandTimeout?: number;
  readonly keepAlive?: number;
  readonly lazyConnect?: boolean;
  readonly maxRetriesPerRequest?: number;
  readonly enableOfflineQueue?: boolean;
}

export const redisOutputOptions = (
  config: RedisOutputConnectionConfig,
): RedisOptions => ({
  host: config.host,
  port: config.port,
  password: config.password,
  db: config.db ?? 0,
  connectTimeout: config.connectTimeout ?? 10_000,
  commandTimeout: config.commandTimeout,
  keepAlive: config.keepAlive ?? 30_000,
  lazyConnect: config.lazyConnect ?? false,
  maxRetriesPerRequest: config.maxRetriesPerRequest ?? 20,
  enableOfflineQueue: config.enableOfflineQueue ?? false,
  retryStrategy: (times) => Math.min(times * 50, 2_000),
});
