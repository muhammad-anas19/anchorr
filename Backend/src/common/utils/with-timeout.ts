// Rejects if `promise` has not settled within `ms`. It stops the CALLER waiting — it does not
// cancel the underlying operation. Measured on this project with `docker pause` on Redis: a
// command that timed out here was still executed by Redis the moment it woke. Anything guarded
// by this must be safe to happen late.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
