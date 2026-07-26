/**
 * Shared ioredis client construction for Redis inputs and outputs.
 */
import Redis from "ioredis";
import { observeRedisClientErrors } from "./redis-client.js";

/**
 * Connection fields accepted by every Redis component that builds an ioredis client.
 */
export interface RedisClientConnectionOptions {
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

/**
 * Build a Redis client with the project-wide default connection options.
 */
export const createConfiguredRedisClient = (
  config: RedisClientConnectionOptions,
): Redis =>
  new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db || 0,
    connectTimeout: config.connectTimeout ?? 10000,
    commandTimeout: config.commandTimeout,
    keepAlive: config.keepAlive ?? 30000,
    lazyConnect: config.lazyConnect ?? false,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 20,
    enableOfflineQueue: config.enableOfflineQueue ?? true,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

/**
 * Build a Redis client and attach the standard error observer.
 */
export const openConfiguredRedisClient = (
  config: RedisClientConnectionOptions,
  componentLabel: string,
): Redis => {
  const client = createConfiguredRedisClient(config);
  observeRedisClientErrors(client, componentLabel);
  return client;
};

/**
 * Format the standard `redis://host:port/db` connection info string.
 */
export const formatRedisConnectionInfo = (
  config: Pick<RedisClientConnectionOptions, "host" | "port" | "db">,
): string => `redis://${config.host}:${config.port}/${config.db || 0}`;
