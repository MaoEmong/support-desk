import assert from 'node:assert/strict';
import process from 'node:process';
import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

const base = process.env.ACCEPTANCE_URL ?? 'http://localhost:3100';
const password = process.env.SEED_PASSWORD ?? 'DemoPassword123!';
const results = [];
class Client {
  cookies = new Map();
  csrf = '';
  async request(path, method = 'GET', body, csrf = true) {
    const headers = { origin: base, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf && this.csrf) headers['x-csrf-token'] = this.csrf;
    const response = await globalThis.fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]; const at = pair.indexOf('=');
      this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: response.status, json, text, headers: response.headers };
  }
}
async function check(name, expected, action) {
  const actual = await action();
  assert.equal(actual, expected, name);
  results.push({ name, expected, actual, result: 'pass' });
}
async function login(client, slug, local) {
  const path = slug ? `/t/${slug}/auth/login` : '/platform/auth/login';
  const email = slug ? `${local}@${slug}.example.com` : 'platform@support.example.com';
  const result = await client.request(path, 'POST', { email, password });
  assert.equal(result.status, 200, `login ${slug ?? 'platform'} ${local}`);
  assert.ok(client.csrf);
  assert.match(result.headers.get('set-cookie'), /HttpOnly/i);
}
const customer = new Client(); const other = new Client(); const agent = new Client();
const foreignAgent = new Client(); const platform = new Client();
try {
  await check('unauthenticated ticket list', 401, async () => (await customer.request('/t/pixelforge/tickets')).status);
  await check('public tenant settings', 200, async () => (await customer.request('/t/pixelforge/settings/public')).status);
  await check('seeded customer/staff/platform logins and HttpOnly cookies', 5, async () => {
    await login(customer, 'pixelforge', 'customer1'); await login(other, 'pixelforge', 'customer2');
    await login(agent, 'pixelforge', 'agent'); await login(foreignAgent, 'mailpulse', 'agent');
    await login(platform, null, 'platform'); return 5;
  });
  let ticketId;
  await check('customer creates ticket over HTTP', 201, async () => {
    const r = await customer.request('/t/pixelforge/tickets', 'POST', { title: 'HTTP acceptance', body: 'Acceptance customer question' });
    ticketId = r.json.id; assert.ok(ticketId); return r.status;
  });
  await check('customer cannot enter staff queue', 403, async () => (await customer.request('/t/pixelforge/admin/tickets')).status);
  await check('another customer cannot read ticket', 404, async () => (await other.request(`/t/pixelforge/tickets/${ticketId}`)).status);
  await check('another tenant staff cannot read ticket', 404, async () => (await foreignAgent.request(`/t/mailpulse/admin/tickets/${ticketId}`)).status);
  await check('tenant session cannot access other tenant route', 401, async () => (await customer.request('/t/mailpulse/tickets')).status);
  await check('staff write without CSRF rejected', 403, async () => (await agent.request(`/t/pixelforge/admin/tickets/${ticketId}/notes`, 'POST', { body: 'Rejected note' }, false)).status);
  await check('staff creates internal note', 201, async () => (await agent.request(`/t/pixelforge/admin/tickets/${ticketId}/notes`, 'POST', { body: 'INTERNAL_ACCEPTANCE_NOTE' })).status);
  await check('customer DTO excludes internal notes/drafts/analysis', true, async () => {
    const r = await customer.request(`/t/pixelforge/tickets/${ticketId}`);
    assert.equal(r.status, 200);
    return !r.text.includes('INTERNAL_ACCEPTANCE_NOTE') && !('drafts' in r.json) && !('aiRuns' in r.json);
  });
  const detail = await agent.request(`/t/pixelforge/admin/tickets/${ticketId}`);
  assert.equal(detail.status, 200); const version = detail.json.version;
  await check('staff conditional ticket update', 200, async () => (await agent.request(`/t/pixelforge/admin/tickets/${ticketId}`, 'PATCH', { version, status: 'in_progress' })).status);
  await check('stale ticket version rejected', 409, async () => (await agent.request(`/t/pixelforge/admin/tickets/${ticketId}`, 'PATCH', { version, status: 'resolved' })).status);
  await check('platform aggregate excludes inquiry bodies', true, async () => {
    const r = await platform.request('/platform/tenants'); assert.equal(r.status, 200);
    const seeded = r.json.items.filter(item => ['pixelforge', 'mailpulse'].includes(item.slug));
    return seeded.length === 2 && !r.text.includes('Acceptance customer question') && !r.text.includes('INTERNAL_ACCEPTANCE_NOTE');
  });
  await check('platform session cannot enter tenant ticket route', 401, async () => (await platform.request(`/t/pixelforge/tickets/${ticketId}`)).status);
  await check('customer logout invalidates session', 401, async () => {
    assert.equal((await customer.request('/t/pixelforge/auth/logout', 'POST')).status, 204);
    return (await customer.request('/t/pixelforge/auth/me')).status;
  });
  const reportPath = process.env.ACCEPTANCE_RESULTS ?? new URL('../../../docs/http-acceptance-results.json', import.meta.url);
  await writeFile(reportPath, JSON.stringify({ base, database: process.env.ACCEPTANCE_DATABASE ?? 'support_desk_acceptance', ticketId, results }, null, 2) + '\n');
  globalThis.console.log(`HTTP acceptance: ${results.length}/${results.length} passed`);
} catch (error) {
  globalThis.console.error(error); process.exitCode = 1;
}
