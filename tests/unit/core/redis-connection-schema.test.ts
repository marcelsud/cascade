import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import * as Schema from "effect/Schema";
import {
  redisAuthSchemaFields,
  redisClientSchemaFields,
  redisHostEndpointSchemaFields,
  redisReconnectSchemaFields,
} from "../../../src/core/redis-connection-schema.js";
import { RedisListOutputConfigSchema } from "../../../src/outputs/redis-list-output.js";
import { PipelineConfigSchema } from "../../../src/core/config-schema.js";

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
  Effect.runSync(
    Effect.result(Schema.decodeUnknownEffect(schema, { errors: "all" })(value)),
  );

const leftMessage = (result: Result.Result<unknown, unknown>): string => {
  if (Result.isSuccess(result)) {
    throw new Error("expected decode failure");
  }
  const left = result.failure;
  if (left && typeof left === "object" && "message" in left) {
    return String(left.message);
  }
  return String(left);
};
describe("redis connection schema field groups", () => {
  it("decodes valid and invalid host endpoint fields", () => {
    const schema = Schema.Struct({ ...redisHostEndpointSchemaFields });

    expect(decode(schema, { host: "localhost", port: 6379 })).toEqual(
      Result.succeed({ host: "localhost", port: 6379 }),
    );

    const invalid = decode(schema, { host: "", port: 0 });
    expect(Result.isFailure(invalid)).toBe(true);
  });

  it("decodes valid and invalid auth fields", () => {
    const schema = Schema.Struct({ ...redisAuthSchemaFields });

    expect(decode(schema, { password: "secret", db: 2 })).toEqual(
      Result.succeed({ password: "secret", db: 2 }),
    );
    expect(decode(schema, {})).toEqual(Result.succeed({}));

    const invalid = decode(schema, { password: "", db: -1 });
    expect(Result.isFailure(invalid)).toBe(true);
  });

  it("decodes valid and invalid client connection knobs", () => {
    const schema = Schema.Struct({ ...redisClientSchemaFields });

    expect(
      decode(schema, {
        connectTimeout: 1000,
        commandTimeout: 2000,
        keepAlive: 3000,
        lazyConnect: true,
        maxRetriesPerRequest: 5,
        enableOfflineQueue: false,
      }),
    ).toEqual(
      Result.succeed({
        connectTimeout: 1000,
        commandTimeout: 2000,
        keepAlive: 3000,
        lazyConnect: true,
        maxRetriesPerRequest: 5,
        enableOfflineQueue: false,
      }),
    );

    const invalid = decode(schema, {
      connectTimeout: 0,
      maxRetriesPerRequest: -1,
    });
    expect(Result.isFailure(invalid)).toBe(true);
  });

  it("decodes valid and invalid reconnect knobs", () => {
    const schema = Schema.Struct({ ...redisReconnectSchemaFields });

    expect(
      decode(schema, {
        maxReconnectAttempts: 3,
        reconnectBackoffMs: 250,
      }),
    ).toEqual(
      Result.succeed({
        maxReconnectAttempts: 3,
        reconnectBackoffMs: 250,
      }),
    );

    const invalid = decode(schema, {
      maxReconnectAttempts: -1,
      reconnectBackoffMs: 0,
    });
    expect(Result.isFailure(invalid)).toBe(true);
  });

  it("keeps Redis list output diagnostic paths in host; port; key; password?; db? order", () => {
    const message = leftMessage(
      decode(RedisListOutputConfigSchema, {
        host: "",
        port: 0,
        key: "",
        password: "",
        db: -1,
      }),
    );
    const paths = ["host", "port", "key", "password", "db"];
    for (const key of paths) expect(message).toContain('["' + key + '"]');
    const positions = paths.map((key) => message.indexOf('["' + key + '"]'));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps YAML redis_list diagnostic paths in url; key; password?; db? order", () => {
    const message = leftMessage(
      decode(PipelineConfigSchema, {
        input: { generate: { count: 1, template: {} } },
        output: {
          redis_list: { url: "bad", key: undefined, password: 1, db: "bad" },
        },
      }),
    );
    const paths = ["url", "key", "password", "db"];
    for (const key of paths)
      expect(message).toContain('["output"]["redis_list"]["' + key + '"]');
    const positions = paths.map((key) => message.indexOf('["' + key + '"]'));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
