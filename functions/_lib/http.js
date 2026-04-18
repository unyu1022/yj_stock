export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function badRequest(message) {
  return json({ ok: false, error: message }, { status: 400 });
}

export function serverError(message, status = 500) {
  return json({ ok: false, error: message }, { status });
}

export function getUrl(request) {
  return new URL(request.url);
}

export async function safeFetchJson(url, init, errorPrefix) {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${errorPrefix}: HTTP ${response.status}`);
  }
  return data;
}

export async function safeFetchText(url, init, errorPrefix) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${errorPrefix}: HTTP ${response.status}`);
  }
  return text;
}
