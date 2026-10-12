// A Salesforce request that never answers (a stalled connection, a network hiccup) would leave the caller waiting forever.
// This gives each attempt a time limit and tries again; a fresh attempt normally answers at once.
//
// run(): starts one attempt and returns its promise (so a new connection/request is made each time).
// onRetry(message): called before every retry so the caller can show it in a log.
export async function withRetry(run, { attempts = 3, timeoutMs = 20_000, onRetry = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer;
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) onRetry(`${String(err.message ?? err).slice(0, 140)}; trying again (${attempt}/${attempts - 1})`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
