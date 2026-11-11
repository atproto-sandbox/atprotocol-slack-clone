/** `work`, or a rejection once `ms` pass without it settling; the timer goes either way. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Not done within ${ms} ms.`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
