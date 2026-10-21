/** What Bedrock, Polly and Rekognition call "slow down". */
const THROTTLED = new Set(['ThrottlingException', 'TooManyRequestsException', 'ProvisionedThroughputExceededException']);

/**
 * Retry an AWS call, backing off exponentially (4 s, 8 s, 16 s…) while the service throttles us;
 * any other error gets one quick retry. At bedtime a slower story beats a failed one.
 */
export async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let delay = 4000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const throttled = THROTTLED.has(err?.name) || err?.$metadata?.httpStatusCode === 429;
      if (attempt >= tries || (!throttled && attempt >= 2)) throw err;
      const wait = throttled ? delay : 1000;
      console.warn(`[retry] attempt ${attempt} failed (${err?.name}: ${String(err?.message).slice(0, 120)}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      delay *= 2;
    }
  }
}
