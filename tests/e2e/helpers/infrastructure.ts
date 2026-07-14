import { ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import Redis from "ioredis";

export const SQS_ENDPOINT =
  process.env.CASCADE_E2E_SQS_ENDPOINT ?? "http://127.0.0.1:4566";
export const REDIS_URL =
  process.env.CASCADE_E2E_REDIS_URL ?? "redis://127.0.0.1:6379";

export const createSqsClient = (): SQSClient =>
  new SQSClient({
    region: "us-east-1",
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 1_000,
      requestTimeout: 2_000,
    }),
  });

export const createRedisClient = (): Redis =>
  new Redis(REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  }).on("error", () => undefined);

const withTimeout = async <A>(promise: Promise<A>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const assertE2EInfrastructure = async (): Promise<void> => {
  const sqs = createSqsClient();
  const redis = createRedisClient();
  const failures: string[] = [];

  await Promise.all([
    withTimeout(
      sqs.send(new ListQueuesCommand({ MaxResults: 1 })),
      3_000,
    ).catch((error) => {
      failures.push(`LocalStack SQS at ${SQS_ENDPOINT}: ${String(error)}`);
    }),
    withTimeout(
      redis.connect().then(() => redis.ping()),
      3_000,
    ).catch((error) => {
      failures.push(`Redis at ${REDIS_URL}: ${String(error)}`);
    }),
  ]);

  sqs.destroy();
  redis.disconnect();

  if (failures.length > 0) {
    throw new Error(
      `E2E infrastructure unavailable. Start Docker Compose first with ` +
        `\"docker compose up -d\".\n${failures.join("\n")}`,
    );
  }
};
