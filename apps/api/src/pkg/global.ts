/**
 * This is special, all of these services will be available globally and are initialized
 * before any hono handlers run.
 *
 * These services can carry state across requests and you can use this for caching purposes.
 * However you should not write any request-specific state to these services.
 * Use the hono context for that.
 */

import { Analytics } from "./analytics";
import { MemoryCache } from "./cache/memory";
import { CacheWithMetrics } from "./cache/metrics";
import { TieredCache } from "./cache/tiered";
import { CacheWithTracing } from "./cache/tracing";
import { ZoneCache } from "./cache/zone";
import { type Api, type Database, type Key, createConnection } from "./db";
import { Env } from "./env";
import { KeyService } from "./keys/service";
import { ConsoleLogger, Logger } from "./logging";
import { AxiomLogger } from "./logging/axiom";
import { QueueLogger } from "./logging/queue";
import { AxiomMetrics, Metrics, NoopMetrics, QueueMetrics } from "./metrics";
import { DurableRateLimiter, NoopRateLimiter, RateLimiter } from "./ratelimit";
import { DurableUsageLimiter, NoopUsageLimiter, UsageLimiter } from "./usagelimit";

export type KeyHash = string;
export type CacheNamespaces = {
  keyById: {
    key: Key;
    api: Api;
    permissions: string[];
    roles: string[];
  } | null;
  keyByHash: {
    key: Key;
    api: Api;
    permissions: string[];
    roles: string[];
  } | null;
  apiById: Api | null;
  keysByOwnerId: {
    key: Key;
    api: Api;
  }[];
  verificationsByKeyId: {
    time: number;
    success: number;
    rateLimited: number;
    usageExceeded: number;
  }[];
};

const fresh = 1 * 60 * 1000; // 1 minute
const stale = 24 * 60 * 60 * 1000; // 24 hours

export let cache: TieredCache<CacheNamespaces>;
export let db: Database;
export let metrics: Metrics;
export let logger: Logger;
export let keyService: KeyService;
export let analytics: Analytics;
export let usageLimiter: UsageLimiter;
export let rateLimiter: RateLimiter;

let initialized = false;

/**
 * Initialize all services.
 *
 * Call this once before any hono handlers run.
 */
export async function init(opts: { env: Env }): Promise<void> {
  if (initialized) {
    return;
  }

  metrics = opts.env.METRICS
    ? new QueueMetrics({ queue: opts.env.METRICS })
    : opts.env.AXIOM_TOKEN
      ? new AxiomMetrics({
          axiomToken: opts.env.AXIOM_TOKEN,
          environment: opts.env.ENVIRONMENT,
        })
      : new NoopMetrics();

  cache = new TieredCache(
    CacheWithTracing.wrap(
      CacheWithMetrics.wrap({
        cache: new MemoryCache<CacheNamespaces>({ fresh, stale }),
        metrics,
      }),
    ),
    opts.env.CLOUDFLARE_ZONE_ID && opts.env.CLOUDFLARE_API_KEY
      ? CacheWithTracing.wrap(
          CacheWithMetrics.wrap({
            cache: new ZoneCache<CacheNamespaces>({
              domain: "cache.unkey.dev",
              fresh,
              stale,
              zoneId: opts.env.CLOUDFLARE_ZONE_ID,
              cloudflareApiKey: opts.env.CLOUDFLARE_API_KEY,
            }),
            metrics,
          }),
        )
      : undefined,
  );

  db = createConnection({
    host: opts.env.DATABASE_HOST,
    username: opts.env.DATABASE_USERNAME,
    password: opts.env.DATABASE_PASSWORD,
  });
  logger = opts.env.LOGS
    ? new QueueLogger({ queue: opts.env.LOGS })
    : opts.env.AXIOM_TOKEN
      ? new AxiomLogger({ axiomToken: opts.env.AXIOM_TOKEN, environment: opts.env.ENVIRONMENT })
      : new ConsoleLogger();

  usageLimiter = opts.env.DO_USAGELIMIT
    ? new DurableUsageLimiter({
        namespace: opts.env.DO_USAGELIMIT,
      })
    : new NoopUsageLimiter();

  analytics = new Analytics(opts.env.TINYBIRD_TOKEN);
  rateLimiter = opts.env.DO_RATELIMIT
    ? new DurableRateLimiter({
        namespace: opts.env.DO_RATELIMIT,
      })
    : new NoopRateLimiter();

  keyService = new KeyService({
    cache,
    logger,
    db,
    metrics,
    rateLimiter,
    usageLimiter,
    analytics,
  });

  initialized = true;
}
