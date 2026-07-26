/**
 * Shared Effect Schema fields for Redis component configs (host/port clients).
 *
 * Endpoint and auth groups are separate so callers can spread them at the
 * original field positions (host/port, then resource key/channel/stream, then
 * password/db). Effect Schema embeds Struct key order in validation diagnostics.
 */
import * as Schema from "effect/Schema";
import { Hostname, NonEmptyString, Port, PositiveInt } from "./validation.js";

/** Host/port endpoint fields shared by Redis host-form configs. */
export const redisHostEndpointSchemaFields = {
  host: Schema.Union(Hostname, NonEmptyString),
  port: Port,
} as const;

/** Optional password/db auth fields shared by Redis host-form configs. */
export const redisAuthSchemaFields = {
  password: Schema.optional(NonEmptyString),
  db: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
} as const;

/** ioredis connection knobs shared by Redis inputs and outputs. */
export const redisClientSchemaFields = {
  connectTimeout: Schema.optional(PositiveInt),
  commandTimeout: Schema.optional(PositiveInt),
  keepAlive: Schema.optional(PositiveInt),
  lazyConnect: Schema.optional(Schema.Boolean),
  maxRetriesPerRequest: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  enableOfflineQueue: Schema.optional(Schema.Boolean),
} as const;

/** Reconnect knobs shared by blocking Redis inputs. */
export const redisReconnectSchemaFields = {
  maxReconnectAttempts: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  reconnectBackoffMs: Schema.optional(PositiveInt),
} as const;
