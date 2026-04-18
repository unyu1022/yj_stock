const store = globalThis.__stockInsightCache || new Map();
globalThis.__stockInsightCache = store;

export function getCached(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function setCached(key, value, ttlMs) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  return value;
}

export async function remember(key, ttlMs, loader) {
  const cached = getCached(key);
  if (cached) return cached;
  const value = await loader();
  return setCached(key, value, ttlMs);
}
