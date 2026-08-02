/**
 * Shared Redis URL parsing for YAML connection contracts.
 *
 * Accepts authority-form `redis://` URLs only. Unsupported schemes
 * (including `rediss://`) and opaque forms like `redis:host:port` are rejected.
 */

export type RedisConnection = {
  host: string;
  port: number;
  password: string | undefined;
  db: number | undefined;
};

/**
 * Parse a Redis connection URL into host/port/password/db.
 * Returns `undefined` when the URL is malformed or uses an unsupported scheme.
 */
export const tryParseRedisUrl = (url: string): RedisConnection | undefined => {
  // Require authority-form redis:// so opaque paths like redis:host:port
  // cannot silently resolve to localhost.
  if (!/^redis:\/\//i.test(url)) {
    return undefined;
  }

  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return undefined;
  }

  if (urlObj.protocol !== "redis:") {
    return undefined;
  }

  const pathMatch = /^\/(\d+)/.exec(urlObj.pathname);
  return {
    host: urlObj.hostname || "localhost",
    port: urlObj.port ? Number.parseInt(urlObj.port, 10) : 6379,
    password: urlObj.password || undefined,
    db: pathMatch ? Number.parseInt(pathMatch[1], 10) : undefined,
  };
};
