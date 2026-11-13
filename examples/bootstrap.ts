import { LINE_ROLES } from './machine-line/line';

// Local demo only: log in as the seeded admin and mint a bot key for the workflow side.
// In production, create the bot and its key once in the dashboard and set LT_API_KEY.
// The bot opens waits on every role the examples park rows on, so it holds each as admin.
const BOT_NAME = 'dbos-workflows';
const BOT_ROLES = ['reviewer', ...LINE_ROLES].map((role) => ({ role, type: 'admin' }));

interface Bot { id: string; external_id: string }

export async function bootstrapApiKey(url: string): Promise<string> {
  const username = process.env.LT_ADMIN_USER;
  const password = process.env.LT_ADMIN_PASSWORD;
  if (!username || !password) throw new Error('Set LT_API_KEY, or LT_ADMIN_USER and LT_ADMIN_PASSWORD for the local demo');
  const { token } = await call<{ token: string }>(url, 'POST', '/api/auth/login', '', { username, password });
  const bots = await call<Bot[] | { bots: Bot[] }>(url, 'GET', '/api/bot-accounts', token);
  const existing = (Array.isArray(bots) ? bots : bots.bots).find((b) => b.external_id === BOT_NAME);
  const bot = existing ?? (await call<Bot>(url, 'POST', '/api/bot-accounts', token, { name: BOT_NAME, roles: BOT_ROLES }));
  // A bot from an earlier boot gains any role added since.
  if (existing) for (const role of BOT_ROLES) await call(url, 'POST', `/api/bot-accounts/${bot.id}/roles`, token, role);
  const key = await call<{ id: string; rawKey: string }>(url, 'POST', `/api/bot-accounts/${bot.id}/api-keys`, token, { name: `examples-${Date.now()}` });
  // Each boot mints a key; revoke the older ones so keys do not pile up.
  const keys = await call<Array<{ id: string }> | { keys: Array<{ id: string }> }>(url, 'GET', `/api/bot-accounts/${bot.id}/api-keys`, token);
  for (const old of (Array.isArray(keys) ? keys : keys.keys).filter((k) => k.id !== key.id)) {
    await call(url, 'DELETE', `/api/bot-accounts/${bot.id}/api-keys/${old.id}`, token);
  }
  return key.rawKey;
}

async function call<T>(url: string, method: string, path: string, token: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`);
      return JSON.parse(text) as T;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
