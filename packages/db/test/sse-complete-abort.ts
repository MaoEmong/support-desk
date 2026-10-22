import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { getDemoCase } from '@support/ai/data';
import { HttpClient, until } from './window1-http';

/** Both boundaries run inside the SAME HTTP server/DB/execution as all other SSE checks. */
export async function abortChecks(base: string, pool: Pool, record: (value: unknown) => void) {
  const client = new HttpClient(base); await client.login('pixelforge', 'customer2');
  const demo = getDemoCase('pixelforge', 'faq_install');
  const request = (signal: AbortSignal) => fetch(`${base}/api/t/pixelforge/chat`, { method: 'POST', signal, headers: { origin: base, 'content-type': 'application/json', 'x-csrf-token': client.csrf, cookie: [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }, body: JSON.stringify({ body: demo.message }) });
  async function counts(id: string) {
    return (await pool.query("SELECT (SELECT count(*)::int FROM conversation_messages WHERE conversation_id=$1 AND role='user') AS customer,(SELECT count(*)::int FROM conversation_messages WHERE conversation_id=$1 AND role='assistant') AS assistant,(SELECT count(*)::int FROM ai_runs WHERE conversation_id=$1) AS runs,(SELECT count(*)::int FROM ai_drafts WHERE conversation_id=$1) AS drafts", [id])).rows[0];
  }
  await pool.query("CREATE FUNCTION sse_complete_abort_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(584001); PERFORM pg_sleep(0.25); RETURN NEW; END $$; CREATE TRIGGER sse_complete_abort_gate BEFORE INSERT ON ai_runs FOR EACH ROW EXECUTE FUNCTION sse_complete_abort_gate()");
  const gate = await pool.connect();
  try {
    await gate.query('SELECT pg_advisory_lock(584001)');
    const controller = new AbortController(), response = await request(controller.signal); assert.equal(response.status, 200);
    const reader = response.body!.getReader(); let wire = '', id = '';
    while (!id) { const chunk = await reader.read(); assert(!chunk.done); wire += new TextDecoder().decode(chunk.value); id = wire.match(/"conversationId":"([a-f0-9-]+)"/)?.[1] ?? ''; }
    await until(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=584001 AND NOT granted")).rows[0].n > 0 ? true : undefined, 'SSE transaction before commit');
    controller.abort(); await reader.cancel().catch(() => {}); await gate.query('SELECT pg_advisory_unlock(584001)');
    await until(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=584001")).rows[0].n === 0 ? true : undefined, 'SSE aborted transaction rollback');
    assert.deepEqual(await counts(id), { customer: 1, assistant: 0, runs: 0, drafts: 0 });
    record({ check: 'same_run_abort_before_commit', conversationId: id, ...(await counts(id)) });
  } finally { await gate.query('SELECT pg_advisory_unlock(584001)'); gate.release(); await pool.query('DROP TRIGGER sse_complete_abort_gate ON ai_runs; DROP FUNCTION sse_complete_abort_gate()'); }
  const controller = new AbortController(), response = await request(controller.signal); assert.equal(response.status, 200);
  const reader = response.body!.getReader(); let wire = '', id = '';
  while (!id) {
    const chunk = await reader.read(); assert(!chunk.done); wire += new TextDecoder().decode(chunk.value);
    const done = wire.match(/event: done\r?\ndata: ([^\r\n]+)/); if (done) id = JSON.parse(done[1]).conversationId;
  }
  controller.abort(); await reader.cancel().catch(() => {});
  const committed = await counts(id); assert.deepEqual(committed, { customer: 1, assistant: 1, runs: 1, drafts: 0 });
  const ids = (await pool.query('SELECT id FROM conversation_messages WHERE conversation_id=$1', [id])).rows.map(row => row.id);
  const followUp = await client.request('/t/pixelforge/chat', 'POST', { conversationId: id, body: demo.message });
  assert.equal(followUp.status, 200); assert.equal((await counts(id)).assistant, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_messages WHERE id=ANY($1::uuid[])', [ids])).rows[0].n, 2);
  record({ check: 'same_run_abort_after_commit', conversationId: id, committed, originalIdsRetained: true, duplicateAssistant: 0, followUpStatus: 200 });
}
