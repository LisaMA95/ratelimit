import type { Duration } from "./duration.ts";
import { ms } from "./duration.ts";
import type {
  Context,
  Ratelimiter,
  RatelimitResponse,
  Redis,
} from "./types.ts";

export type RatelimitConfig = {
  /**
   * Instance of `@upstash/redis`
   * @see https://github.com/upstash/upstash-redis#quick-start
   */
  redis: Redis;
  /**
   * The ratelimiter function to use.
   *
   * Choose one of the predefined ones or implement your own.
   * Available algorithms are exposed via static methods:
   * - Ratelimiter.fixedWindow
   * - Ratelimiter.slidingLogs
   * - Ratelimiter.slidingWindow
   * - Ratelimiter.tokenBucket
   */
  limiter: Ratelimiter;
  /**
   * All keys in redis are prefixed with this.
   *
   * @default `@upstash/ratelimit`
   */
  prefix?: string;
};

/**
 * Ratelimiter using serverless redis from https://upstash.com/
 *
 * @example
 * ```ts
 * const { limit } = new Ratelimit({
 *    redis: Redis.fromEnv(),
 *    limiter: Ratelimit.slidingWindow(
 *      "30 m", // interval of 30 minutes
 *      10,     // Allow 10 requests per window of 30 minutes
 *    )
 * })
 *
 * ```
 */
export class Ratelimit {
  private readonly redis: Redis;
  private readonly limiter: Ratelimiter;
  private readonly prefix: string;

  /**
   * Create a new Ratelimit instance by providing a `@upstash/redis` instance and the algorithn of your choice.
   */

  constructor(config: RatelimitConfig) {
    this.redis = config.redis;
    this.limiter = config.limiter;
    this.prefix = config.prefix ?? "@upstash/ratelimit";
  }

  /**
   * Determine if a request should pass or be rejected based on the identifier and previously chosen ratelimit.
   *
   * Use this if you want to reject all requests that you can not handle right now.
   *
   * @example
   * ```ts
   *  const ratelimit = new Ratelimit({
   *    redis: Redis.fromEnv(),
   *    limiter: Ratelimit.slidingWindow(10, "10 s")
   *  })
   *
   *  const { success } = await ratelimit.limit(id)
   *  if (!success){
   *    return "Nope"
   *  }
   *  return "Yes"
   * ```
   */
  public limit = async (identifier: string): Promise<RatelimitResponse> => {
    const key = [this.prefix, identifier].join(":");
    return await this.limiter({ redis: this.redis }, key);
  };

  /**
   * Block until the request may pass or timeout is reached.
   *
   * This method returns a promsie that resolves as soon as the request may be processed
   * or after the timeoue has been reached.
   *
   * Use this if you want to delay the request until it is ready to get processed.
   *
   * @example
   * ```ts
   *  const ratelimit = new Ratelimit({
   *    redis: Redis.fromEnv(),
   *    limiter: Ratelimit.slidingWindow(10, "10 s")
   *  })
   *
   *  const { success } = await ratelimit.blockUntilReady(id, 60_000)
   *  if (!success){
   *    return "Nope"
   *  }
   *  return "Yes"
   * ```
   */
  public blockUntilReady = async (
    /**
     * An identifier per user or api.
     * Choose a userID, or api token, or ip address.
     *
     * If you want to globally limit your api, you can set a constant string.
     */
    identifier: string,
    /**
     * Maximum duration to wait in milliseconds.
     * After this time the request will be denied.
     */
    timeout: number
  ): Promise<RatelimitResponse> => {
    if (timeout <= 0) {
      throw new Error("timeout must be positive");
    }
    let res: RatelimitResponse;

    const deadline = Date.now() + timeout;
    while (true) {
      res = await this.limit(identifier);
      if (res.success) {
        break;
      }
      if (res.reset === 0) {
        throw new Error("This should not happen");
      }

      const wait = Math.min(res.reset, deadline) - Date.now();
      await new Promise((r) => setTimeout(r, wait));

      if (Date.now() > deadline) {
        break;
      }
    }
    return res!;
  };

  static eventualWrite(tokens: number, window: Duration): Ratelimiter {
    const windowDuration = ms(window);
    return async function (ctx: Context, identifier: string) {
      const bucket = Math.floor(Date.now() / windowDuration);
      const key = [identifier, bucket].join(":");

      const usedTokensAfterUpdate = (await ctx.redis.get<number>(key)) ?? 1;

      ctx.redis.incr(key).then((res) => {
        if (res === 1) {
          ctx.redis.expire(key, windowDuration);
        }
      });

      return {
        success: usedTokensAfterUpdate <= tokens,
        limit: tokens,
        remaining: tokens - usedTokensAfterUpdate,
        reset: (bucket + 1) * windowDuration,
      };
    };
  }

  /**
   * Each requests inside a fixed time increases a counter.
   * Once the counter reaches a maxmimum allowed number, all further requests are
   * rejected.
   *
   * **Pro:**
   *
   * - Newer requests are not starved by old ones.
   * - Low storage cost.
   *
   * **Con:**
   *
   * A burst of requests near the boundary of a window can result in a very
   * high request rate because two windows will be filled with requests quickly.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - A fixed timeframe
   */
  static fixedWindow(
    /**
     * How many requests are allowed per window.
     */
    tokens: number,
    /**
     * The duration in which `tokens` requests are allowed.
     */
    window: Duration
  ): Ratelimiter {
    const windowDuration = ms(window);

    const script = `
    local key     = KEYS[1]
    local window  = ARGV[1]
    
    local r = redis.call("INCR", key)
    if r == 1 then 
    -- The first time this key is set, the value will be 1.
    -- So we only need the expire command once
    redis.call("PEXPIRE", key, window)
    end
    
    return r
    `;

    return async function (ctx: Context, identifier: string) {
      const bucket = Math.floor(Date.now() / windowDuration);
      const key = [identifier, bucket].join(":");

      const usedTokensAfterUpdate = (await ctx.redis.eval(
        script,
        [key],
        [windowDuration]
      )) as number;

      return {
        success: usedTokensAfterUpdate <= tokens,
        limit: tokens,
        remaining: tokens - usedTokensAfterUpdate,
        reset: (bucket + 1) * windowDuration,
      };
    };
  }

  // /**
  //  * For each request all past requests in the last `{window}` are summed up and
  //  * if they exceed `{tokens}`, the request will be rejected.
  //  *
  //  * **Pro:**
  //  *
  //  * Does not have the problem of `fixedWindow` at the window boundaries.
  //  *
  //  * **Con:**
  //  *
  //  * More expensive to store and compute, which makes this unsuitable for apis
  //  * with very high traffic.
  //  *
  //  * @param window - The duration in which the user can max X requests.
  //  * @param tokens - How many requests a user can make in each time window.
  //  */
  // static slidingLogs(window: Duration, tokens: number): Ratelimiter {
  //   const script = `
  //   local key         = KEYS[1] -- identifier including prefixes
  //   local windowStart = ARGV[1] -- timestamp of window start
  //   local windowEnd   = ARGV[2] -- timestamp of window end
  //   local tokens      = ARGV[3] -- tokens per window
  //   local now         = ARGV[4] -- current timestamp

  //   local count = redis.call("ZCOUNT", key, windowStart, windowEnd)

  //   if count < tonumber(tokens) then
  //     -- Log the current request
  //     redis.call("ZADD", key, now, now)

  //     -- Remove all previous requests that are outside the window
  //     redis.call("ZREMRANGEBYSCORE", key, "-inf", windowStart - 1)
  //   end

  //   return count
  //   `;
  //   return async function (ctx: Context, identifier: string) {
  //     const windowEnd = Date.now();
  //     const windowStart = windowEnd - ms(window);

  //     const count = (await ctx.redis.eval(
  //       script,
  //       [identifier],
  //       [windowStart, windowEnd, tokens, Date.now()]
  //     )) as number;
  //     return {
  //       success: count < tokens,
  //       limit: tokens,
  //       remaining: Math.max(0, tokens - count - 1),
  //       reset: windowEnd,
  //     };
  //   };
  // }

  /**
   * Combined approach of `slidingLogs` and `fixedWindow` with lower storage
   * costs than `slidingLogs` and improved boundary behavior by calcualting a
   * weighted score between two windows.
   *
   * **Pro:**
   *
   * Good performance allows this to scale to very high loads.
   *
   * **Con:**
   *
   * Nothing major.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - The duration in which the user can max X requests.
   */
  static slidingWindow(
    /**
     * How many requests are allowed per window.
     */
    tokens: number,
    /**
     * The duration in which `tokens` requests are allowed.
     */
    window: Duration
  ): Ratelimiter {
    const script = `
      local currentKey  = KEYS[1]           -- identifier including prefixes
      local previousKey = KEYS[2]           -- key of the previous bucket
      local tokens      = tonumber(ARGV[1]) -- tokens per window
      local now         = ARGV[2]           -- current timestamp in milliseconds
      local window      = ARGV[3]           -- interval in milliseconds

      local requestsInCurrentWindow = redis.call("GET", currentKey)
      if requestsInCurrentWindow == false then
        requestsInCurrentWindow = 0
      end


      local requestsInPreviousWindow = redis.call("GET", previousKey)
      if requestsInPreviousWindow == false then
        requestsInPreviousWindow = 0
      end
      local percentageInCurrent = ( now % window) / window
      if requestsInPreviousWindow * ( 1 - percentageInCurrent ) + requestsInCurrentWindow >= tokens then
        return 0
      end

      local newValue = redis.call("INCR", currentKey)
      if newValue == 1 then 
        -- The first time this key is set, the value will be 1.
        -- So we only need the expire command once
        redis.call("PEXPIRE", currentKey, window * 2 + 1000) -- Enough time to overlap with a new window + 1 second
      end
      return tokens - newValue
      `;
    const windowSize = ms(window);
    return async function (ctx: Context, identifier: string) {
      const now = Date.now();

      const currentWindow = Math.floor(now / windowSize);
      const currentKey = [identifier, currentWindow].join(":");
      const previousWindow = currentWindow - windowSize;
      const previousKey = [identifier, previousWindow].join(":");

      const remaining = (await ctx.redis.eval(
        script,
        [currentKey, previousKey],
        [tokens, now, windowSize]
      )) as number;
      return {
        success: remaining > 0,
        limit: tokens,
        remaining,
        reset: (currentWindow + 1) * windowSize,
      };
    };
  }

  /**
   * You have a bucket filled with `{maxTokens}` tokens that refills constantly
   * at `{refillRate}` per `{interval}`.
   * Every request will remove one token from the bucket and if there is no
   * token to take, the request is rejected.
   *
   * **Pro:**
   *
   * - Bursts of requests are smoothed out and you can process them at a constant
   * rate.
   * - Allows to set a higher initial burst limit by setting `maxTokens` higher
   * than `refillRate`
   *
   * **Usage of Upstash Redis requests:**
   */
  static tokenBucket(
    /**
     * How many tokens are refilled per `interval`
     *
     * An interval of `10s` and refillRate of 5 will cause a new token to be added every 2 seconds.
     */
    refillRate: number,
    /**
     * The interval for the `refillRate`
     */
    interval: Duration,
    /**
     * Maximum number of tokens.
     * A newly created bucket starts with this many tokens.
     * Useful to allow higher burst limits.
     */
    maxTokens: number
  ): Ratelimiter {
    const script = `
        local key         = KEYS[1]           -- identifier including prefixes
        local maxTokens   = tonumber(ARGV[1]) -- maximum number of tokens
        local interval    = tonumber(ARGV[2]) -- size of the window in milliseconds
        local refillRate  = tonumber(ARGV[3]) -- how many tokens are refilled after each interval
        local now         = tonumber(ARGV[4]) -- current timestamp in milliseconds
        local remaining   = 0
        
        local bucket = redis.call("HMGET", key, "updatedAt", "tokens")
        
        if bucket[1] == false then
          -- The bucket does not exist yet, so we create it and add a ttl.
          remaining = maxTokens - 1
          
          redis.call("HMSET", key, "updatedAt", now, "tokens", remaining)
          redis.call("PEXPIRE", key, interval)
  
          return {remaining, now + interval}
        end

        -- The bucket does exist
  
        local updatedAt = tonumber(bucket[1])
        local tokens = tonumber(bucket[2])
  
        if now >= updatedAt + interval then
          remaining = math.min(maxTokens, tokens + refillRate) - 1
          
          redis.call("HMSET", key, "updatedAt", now, "tokens", remaining)
          return {remaining, now + interval}
        end
  
        if tokens > 0 then
          remaining = tokens - 1
          redis.call("HMSET", key, "updatedAt", now, "tokens", remaining)
        end
  
        return {remaining, updatedAt + interval}
       `;

    const intervalDuration = ms(interval);
    return async function (ctx: Context, identifier: string) {
      const now = Date.now();
      const key = [identifier, Math.floor(now / intervalDuration)].join(":");

      const [remaining, reset] = (await ctx.redis.eval(
        script,
        [key],
        [maxTokens, intervalDuration, refillRate, now]
      )) as [number, number];

      return { success: remaining > 0, limit: maxTokens, remaining, reset };
    };
  }
}
