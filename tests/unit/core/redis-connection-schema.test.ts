import { describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import * as Schema from "effect/Schema";
import {
  redisAuthSchemaFields,
  redisClientSchemaFields,
  redisHostEndpointSchemaFields,
  redisReconnectSchemaFields,
} from "../../../src/core/redis-connection-schema.js";
import { RedisListOutputConfigSchema } from "../../../src/outputs/redis-list-output.js";
import { PipelineConfigSchema } from "../../../src/core/config-schema.js";

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Effect.runSync(Effect.either(Schema.decodeUnknown(schema)(value)));

const leftMessage = (result: Either.Either<unknown, unknown>): string => {
  if (Either.isRight(result)) {
    throw new Error("expected decode failure");
  }
  const left = result.left;
  if (left && typeof left === "object" && "message" in left) {
    return String(left.message);
  }
  return String(left);
};
describe("redis connection schema field groups", () => {
  it("decodes valid and invalid host endpoint fields", () => {
    const schema = Schema.Struct({ ...redisHostEndpointSchemaFields });

    expect(decode(schema, { host: "localhost", port: 6379 })).toEqual(
      Either.right({ host: "localhost", port: 6379 }),
    );

    const invalid = decode(schema, { host: "", port: 0 });
    expect(Either.isLeft(invalid)).toBe(true);
  });

  it("decodes valid and invalid auth fields", () => {
    const schema = Schema.Struct({ ...redisAuthSchemaFields });

    expect(decode(schema, { password: "secret", db: 2 })).toEqual(
      Either.right({ password: "secret", db: 2 }),
    );
    expect(decode(schema, {})).toEqual(Either.right({}));

    const invalid = decode(schema, { password: "", db: -1 });
    expect(Either.isLeft(invalid)).toBe(true);
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
      Either.right({
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
    expect(Either.isLeft(invalid)).toBe(true);
  });

  it("decodes valid and invalid reconnect knobs", () => {
    const schema = Schema.Struct({ ...redisReconnectSchemaFields });

    expect(
      decode(schema, {
        maxReconnectAttempts: 3,
        reconnectBackoffMs: 250,
      }),
    ).toEqual(
      Either.right({
        maxReconnectAttempts: 3,
        reconnectBackoffMs: 250,
      }),
    );

    const invalid = decode(schema, {
      maxReconnectAttempts: -1,
      reconnectBackoffMs: 0,
    });
    expect(Either.isLeft(invalid)).toBe(true);
  });

  it("keeps Redis list output diagnostics in host; port; key; password?; db? order", () => {
    const result = decode(RedisListOutputConfigSchema, {});
    const message = leftMessage(result);

    expect(message).toContain("readonly host: a string matching the pattern");
    expect(message).toMatch(
      /readonly host:.*readonly port:.*readonly key:.*readonly password\?:.*readonly db\?:/s,
    );
    expect(message.indexOf("readonly key:")).toBeLessThan(
      message.indexOf("readonly password?:"),
    );
    expect(message.indexOf("readonly password?:")).toBeLessThan(
      message.indexOf("readonly db?:"),
    );
  });

  it("keeps YAML redis_list diagnostics in url; key; password?; db? order", () => {
    const result = decode(PipelineConfigSchema, {
      input: { generate: { count: 1, template: {} } },
      output: { redis_list: {} },
    });
    const message = leftMessage(result);
    const sliceStart = message.indexOf("redis_list?:");
    const slice = message.slice(sliceStart, sliceStart + 260);

    // List/PubSub YAML now use canonical `url` (issue #72); shared auth group
    // still lands after the resource key so diagnostics stay ordered.
    expect(slice).toContain(
      "readonly url: { string | filter }; readonly key: string",
    );
    expect(slice).toMatch(
      /readonly url: \{ string \| filter \}; readonly key: string(?: \| ReadonlyArray<string>)?; readonly password\?: string \| undefined; readonly db\?: number \| undefined/,
    );
    expect(slice.indexOf("readonly url:")).toBeLessThan(
      slice.indexOf("readonly key:"),
    );
    expect(slice.indexOf("readonly key:")).toBeLessThan(
      slice.indexOf("readonly password?:"),
    );
    expect(slice.indexOf("readonly password?:")).toBeLessThan(
      slice.indexOf("readonly db?:"),
    );
  });
});
