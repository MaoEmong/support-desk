import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { getDemoCase, loadDemoSet } from '@support/ai/data';
import { DECISION_REASONS, DemoCaseSchema, type DemoCase } from '@support/ai/contracts';
import { apiAs, contextAs, uniq } from './helpers';
import { PASSWORD } from './env';
import { decisionReasonLabel } from '../src/lib/labels';
import type { AdminSettings, Agent, CustomerTicketDetail, Me, Page as ResultPage, StaffTicketDetail, TenantMetrics } from '../src/lib/types';
import { assertNoInternalStrings, assertPublicConversation, assertPublicCustomerTicket, assertPublicSSEWire } from './leak-check';

const WAIT = 30_000;
const PF = 'pixelforge';

function demo(slug: string, key: string): DemoCase {
  const set = loadDemoSet(slug);
  expect(set, `시연 데이터 누락: ${slug}`).not.toBeNull();
  expect(set!.cases.some(c => c.key === key), `시연 키 누락: ${slug}/${key}`).toBeTruthy();
  const item = DemoCaseSchema.parse(getDemoCase(slug, key));
  expect(DECISION_REASONS).toContain(item.expected.reason);
  test.info().annotations.push({type:'caseKey',description:`${slug}/${key}`});
  return item;
}

async function freshCustomer(browser: Browser, info: TestInfo, slug: string) {
  const context = await contextAs(browser, info, null);
  try {
    await apiAs<Me>(context, 'POST', `/t/${slug}/auth/signup`, {
      name: uniq('stage2-customer'), email: `${uniq('stage2')}@example.test`, password: PASSWORD,
    });
    return context;
  } catch (e) { await context.close(); throw e; }
}

async function submitTicket(context: BrowserContext, slug: string, item: DemoCase, onCreated?: (id:string)=>void) {
  const page = await context.newPage();
  const title = `${item.title} ${uniq('stage2')}`;
  await page.goto(`/t/${slug}/tickets/new`);
  await page.getByLabel('제목', { exact: true }).fill(title);
  await page.getByLabel('내용', { exact: true }).fill(item.message);
  await page.getByRole('button', { name: '문의 등록', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/tickets/[0-9a-f-]{36}$`), { timeout: WAIT });
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  onCreated?.(id);
  test.info().annotations.push({type:'ticketId',description:JSON.stringify({slug,caseKey:item.key,id})});
  if (item.key==='faq_install' || item.key==='refund_escalate') await readCustomerTicket(context,slug,id);
  return { page, id, title };
}

async function readCustomerTicket(context: BrowserContext, slug: string, id: string) {
  const path=`/api/t/${slug}/tickets/${id}`;
  const response=await context.request.get(path);
  expect(response.status()).toBe(200);
  const text=await response.text();
  assertNoInternalStrings(text,path);
  const value=JSON.parse(text) as CustomerTicketDetail;
  assertPublicCustomerTicket(value,path);
  return value;
}

async function waitRun(staff: BrowserContext, slug: string, id: string, expected: DemoCase['expected']) {
  const read = () => apiAs<StaffTicketDetail>(staff, 'GET', `/t/${slug}/admin/tickets/${id}`);
  await expect.poll(async () => {
    const ticket = await read();
    const run = [...ticket.aiRuns].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
    return run ? { status: run.status, decision: run.decision, reason: run.reason, category: run.category } : null;
  }, { timeout: WAIT, message: '실제 워커의 AI 처리 완료 대기' }).toEqual({ status:'succeeded', decision:expected.decision, reason:expected.reason, category:expected.category });
  const ticket = await read();
  const run = [...ticket.aiRuns].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  expect(run.confidence).not.toBeNull();
  expect(run.confidence!).toBeCloseTo(expected.confidence, 3);
  return ticket;
}

async function confirmResolved(page: Page) {
  await page.getByTestId('confirm-resolved').click();
  await page.getByTestId('confirm-resolved-submit').click();
  await expect(page.getByTestId('ticket-status')).toHaveText('해결됨', { timeout: WAIT });
}

async function withSettings(staff: BrowserContext, patch: Partial<AdminSettings>, work: () => Promise<void>, options: {restore?:Partial<AdminSettings>;beforeRestore?:()=>Promise<void>} = {}) {
  const path = `/t/${PF}/admin/settings`;
  const original = await apiAs<AdminSettings>(staff, 'GET', path);
  // Restore only the changed settings; never submit GET-only updatedAt/autoAnswerLimit.
  const restore = {...Object.fromEntries(Object.keys(patch).map(key => [key, original[key as keyof AdminSettings]])),...options.restore};
  try { await apiAs(staff, 'PATCH', path, patch); await work(); }
  finally {
    try {await options.beforeRestore?.();}
    finally {await apiAs(staff, 'PATCH', path, restore);}
  }
}

async function waitForRunsToFinish(staff: BrowserContext, ids: string[]) {
  await Promise.all(ids.map(id => expect.poll(async () => {
    const ticket=await apiAs<StaffTicketDetail>(staff,'GET',`/t/${PF}/admin/tickets/${id}`);
    const run=[...ticket.aiRuns].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
    return run?.status==='succeeded' || run?.status==='failed';
  },{timeout:WAIT,message:`설정 복구 전 ${id} 비동기 처리 종료 대기`}).toBe(true)));
}

// Independent scenarios run first; only settings writers at the end share serial failure behavior.
// Keep the configured workers=1 to prevent concurrent tenant-setting changes.
test.describe('2단계 실제 AI·관리자 통합', () => {
  test.setTimeout(180_000);

  test('pixelforge FAQ 티켓 → 자동답변·근거 → 고객 해결 확인', async ({ browser }, info) => {
    const item = demo(PF, 'faq_install');
    const customer = await freshCustomer(browser, info, PF);
    const staff = await contextAs(browser, info, 'admin');
    try {
      const { page, id } = await submitTicket(customer, PF, item);
      await waitRun(staff, PF, id, item.expected);
      await readCustomerTicket(customer,PF,id);
      const answer = page.locator('[data-testid="message"][data-author-type="ai"]');
      await expect(answer).toBeVisible({ timeout: WAIT });
      await expect(answer.getByTestId('message-sources')).toBeVisible();
      await expect(answer.getByTestId('message-sources').locator('li').first()).toBeVisible();
      await confirmResolved(page);
      await readCustomerTicket(customer,PF,id);
    } finally { await customer.close(); await staff.close(); }
  });

  test('환불 이관 → 큐 사유·초안 편집·승인 → 고객 반영 및 실제 초안 409', async ({ browser }, info) => {
    const item = demo(PF, 'refund_escalate');
    const customer = await freshCustomer(browser, info, PF);
    const ctxA = await contextAs(browser, info, 'agent');
    const ctxB = await contextAs(browser, info, 'agent');
    try {
      const { page: customerPage, id, title } = await submitTicket(customer, PF, item);
      const detail = await waitRun(ctxA, PF, id, item.expected);
      await readCustomerTicket(customer,PF,id);
      expect(detail.escalated).toBe(true);
      expect(detail.drafts.some(d => d.status==='draft')).toBe(true);
      const a = await ctxA.newPage();
      await a.goto(`/t/${PF}/admin?escalated=true`);
      const row = a.getByTestId('queue-row').filter({ hasText:title }).filter({ visible:true });
      await expect(row).toBeVisible({ timeout: WAIT });
      await expect(row).toContainText('상담원 이관');
      await expect(row).toContainText(decisionReasonLabel[item.expected.reason]);
      await a.goto(`/t/${PF}/admin/tickets/${id}`);
      await expect(a.getByTestId('draft-approve').first()).toBeVisible({ timeout: WAIT });
      const edited = `${uniq('상담원 검토 완료')} ${item.title}`;
      await a.getByLabel('AI 초안 편집', { exact:true }).first().fill(edited);
      const save = a.waitForResponse(r => r.request().method()==='PATCH' && /\/drafts\/[^/]+$/.test(new URL(r.url()).pathname));
      await a.getByRole('button', { name:'초안 저장', exact:true }).first().click();
      expect((await save).status()).toBe(200);

      const b = await ctxB.newPage();
      const detailPattern = `**/api/t/${PF}/admin/tickets/${id}`;
      let staleBody: string | undefined;
      await b.route(detailPattern, async route => {
        if (route.request().method()!=='GET') return route.continue();
        // Freeze only B's GET snapshot. Both approval POSTs hit the real server.
        if (staleBody === undefined) {
          const response = await route.fetch();
          expect(response.ok()).toBeTruthy();
          staleBody = await response.text();
        }
        await route.fulfill({status:200, contentType:'application/json', body:staleBody});
      });
      await b.goto(`/t/${PF}/admin/tickets/${id}`);
      await expect(b.getByTestId('draft-approve').first()).toBeEnabled({ timeout:WAIT });
      const approveA = a.waitForResponse(r => r.request().method()==='POST' && r.url().endsWith('/approve'));
      await a.getByTestId('draft-approve').first().click();
      expect((await approveA).status()).toBe(200);
      await expect(customerPage.locator('[data-testid="message"][data-author-type="agent"]').filter({hasText:edited})).toBeVisible({timeout:WAIT});
      await readCustomerTicket(customer,PF,id);
      const approveB = b.waitForResponse(r => r.request().method()==='POST' && r.url().endsWith('/approve'));
      await b.getByTestId('draft-approve').first().click();
      const conflict = await approveB;
      expect(conflict.status()).toBe(409);
      expect((await conflict.json()).code).toBe('VERSION_CONFLICT');
      await expect(b.getByTestId('view-409')).toBeVisible();
      await expect(b.getByLabel('AI 초안 편집', {exact:true}).first()).toHaveValue(edited);
      await b.unroute(detailPattern);
    } finally { await customer.close(); await ctxA.close(); await ctxB.close(); }
  });

  for (const key of ['chat_faq','chat_hacking']) {
    test(`챗봇 ${key}: 실제 SSE·출력 정책·전환 멱등성`, async ({browser}, info) => {
      const item = demo(PF,key);
      const customer = await freshCustomer(browser,info,PF);
      try {
        const page = await customer.newPage();
        await page.goto(`/t/${PF}/tickets`);
        await page.getByTestId('chat-open').click();
        await page.getByTestId('chat-input').fill(item.message);
        const responsePromise = page.waitForResponse(r => r.request().method()==='POST' && new URL(r.url()).pathname===`/api/t/${PF}/chat`);
        await page.getByTestId('chat-send').click();
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toContain('text/event-stream');
        const wire = await response.text();
        const events = assertPublicSSEWire(wire,`${PF}/${key} POST /chat`);
        const conversationId = events.find(e => e.event==='classified')?.data.conversationId;
        expect(typeof conversationId).toBe('string');
        if (typeof conversationId!=='string') throw new Error('classified conversationId 누락');
        test.info().annotations.push({type:'conversationId',description:JSON.stringify({caseKey:key,id:conversationId})});
        for (const event of events) if (event.event==='done' && event.data.ticketId) test.info().annotations.push({type:'ticketId',description:JSON.stringify({caseKey:key,id:event.data.ticketId})});
        const restorePath=`/api/t/${PF}/conversations/${conversationId}`;
        const restored=await customer.request.get(restorePath);
        expect(restored.status()).toBe(200);
        const restoredText=await restored.text();
        assertNoInternalStrings(restoredText,restorePath);
        assertPublicConversation(JSON.parse(restoredText),restorePath);
        expect(events.at(-1)?.event).toBe('done');
        expect(events.filter(e => e.event==='error')).toHaveLength(0);
        const tokens = events.filter(e => e.event==='token');
        const assistant = page.locator('[data-testid="chat-message"][data-role="assistant"]');
        if (item.expected.decision==='auto_answer') {
          expect(tokens.length).toBeGreaterThan(0);
          await expect(assistant.locator('.prose-sd')).not.toBeEmpty({timeout:WAIT});
          const sourceEvent = events.find(e => e.event==='sources');
          const sources = sourceEvent?.data.sources as {title:string;excerpt?:string | null}[] | undefined;
          expect(sources?.length).toBeGreaterThan(0);
          const excerpt = sources!.find(s => s.excerpt?.trim())?.excerpt;
          expect(excerpt, 'SSE 근거에 발췌가 있어야 합니다.').toBeTruthy();
          await expect(assistant.getByTestId('message-sources')).toContainText(excerpt!);
        } else {
          expect(tokens).toHaveLength(0);
          await expect(assistant.locator('.prose-sd')).toHaveCount(0);
          await expect(page.getByTestId('chat-escalated')).toBeVisible({timeout:WAIT});
          expect(events.find(e => e.event==='escalated')?.data.reason).toBe(item.expected.reason);
          await page.getByTestId('chat-convert').click();
          await page.getByLabel('문의 제목', {exact:true}).fill(item.title);
          const convertedPromise = page.waitForResponse(r => r.request().method()==='POST' && r.url().endsWith('/convert'));
          await page.getByTestId('chat-convert-submit').click();
          const converted = await (await convertedPromise).json() as {ticketId:string};
          test.info().annotations.push({type:'ticketId',description:JSON.stringify({caseKey:key,id:converted.ticketId,conversationId})});
          await expect(page).toHaveURL(new RegExp(`/tickets/${converted.ticketId}$`), {timeout:WAIT});
          const again = await apiAs<{ticketId:string}>(customer,'POST',`/t/${PF}/conversations/${conversationId}/convert`,{title:item.title});
          expect(again.ticketId).toBe(converted.ticketId);
          const tickets = await apiAs<ResultPage<{id:string}>>(customer,'GET',`/t/${PF}/tickets`);
          expect(tickets.total).toBe(1);
          expect(tickets.items.map(t => t.id)).toEqual([converted.ticketId]);
        }
      } finally {await customer.close();}
    });
  }

  test('상담원 추가·단회 비밀번호·중복 이메일·비활성 세션·관리 경로 권한', async ({browser},info) => {
    const admin=await contextAs(browser,info,'admin');
    const agent=await contextAs(browser,info,null);
    const existingAgent=await contextAs(browser,info,'agent');
    const customer=await freshCustomer(browser,info,PF);
    try {
      const page=await admin.newPage();await page.goto(`/t/${PF}/admin/agents`);
      const name=uniq('stage2-agent');const email=`${uniq('stage2-agent')}@example.test`;
      await page.getByRole('button',{name:'상담원 추가',exact:true}).click();
      await page.getByLabel('이름',{exact:true}).fill(name);await page.getByLabel('이메일',{exact:true}).fill(email);
      const creation=page.waitForResponse(r => r.request().method()==='POST' && new URL(r.url()).pathname===`/api/t/${PF}/admin/agents`);
      await page.getByRole('button',{name:'상담원 생성',exact:true}).click();
      const createdResponse=await creation;expect(createdResponse.status()).toBe(201);
      const created=await createdResponse.json() as {agent:Agent;temporaryPassword:string};
      // 다이얼로그 제목도 '임시 비밀번호'라 getByLabel은 dialog와 input 둘에 걸린다 → 입력란(textbox)으로 좁힌다
      const password=page.getByRole('textbox',{name:'임시 비밀번호',exact:true});
      await expect(password).toHaveValue(created.temporaryPassword);
      await expect(page.getByText(/닫으면 다시 볼 수 없습니다/)).toBeVisible();
      const login=await agent.newPage();await login.goto(`/t/${PF}/login`);
      await login.getByLabel('이메일',{exact:true}).fill(email);await login.getByLabel('비밀번호',{exact:true}).fill(await password.inputValue());
      await login.getByRole('button',{name:'로그인',exact:true}).click();
      await expect(login).toHaveURL(`/t/${PF}/admin`,{timeout:WAIT});
      await page.getByRole('button',{name:'확인 후 닫기',exact:true}).click();
      await expect(password).toHaveCount(0);
      await expect.poll(async () => {
        const response=await admin.request.get(`/api/t/${PF}/admin/agents`);
        return response.text();
      },{timeout:WAIT}).not.toContain(created.temporaryPassword);
      await page.getByRole('button',{name:'상담원 추가',exact:true}).click();
      await expect(page.getByRole('textbox',{name:'임시 비밀번호',exact:true})).toHaveCount(0);
      await page.getByLabel('이름',{exact:true}).fill(name);await page.getByLabel('이메일',{exact:true}).fill(email);
      const duplicate=page.waitForResponse(r => r.request().method()==='POST' && new URL(r.url()).pathname===`/api/t/${PF}/admin/agents`);
      await page.getByRole('button',{name:'상담원 생성',exact:true}).click();
      const duplicateResponse=await duplicate;expect(duplicateResponse.status()).toBe(409);
      expect((await duplicateResponse.json()).code).toBe('EMAIL_TAKEN');
      await expect(page.getByLabel('이메일',{exact:true})).toHaveAttribute('aria-invalid','true');
      await expect(page.getByText('이미 사용 중인 이메일입니다.',{exact:true})).toBeVisible();
      await page.getByRole('dialog').getByRole('button',{name:'닫기',exact:true}).click();

      const item=demo(PF,'faq_install');const ticket=await submitTicket(customer,PF,item);
      const detail=await waitRun(admin,PF,ticket.id,item.expected);
      await apiAs(admin,'PATCH',`/t/${PF}/admin/tickets/${ticket.id}`,{version:detail.version,assigneeId:created.agent.id});
      await page.reload();
      const card=page.getByRole('heading',{name,exact:true}).locator('..');
      await expect(card).toContainText('담당 중인 열린 티켓 1건',{timeout:WAIT});
      await card.getByRole('button',{name:'비활성화',exact:true}).click();
      const dialog=page.getByRole('dialog');await expect(dialog).toContainText('담당 중인 열린 티켓 1건');
      const disable=page.waitForResponse(r => r.request().method()==='PATCH' && r.url().endsWith(`/agents/${created.agent.id}`));
      await dialog.getByRole('button',{name:'비활성화 확정',exact:true}).click();expect((await disable).status()).toBe(200);
      expect((await agent.request.get(`/api/t/${PF}/auth/me`)).status()).toBe(401);
      await login.goto(`/t/${PF}/admin`);await expect(login).toHaveURL(/\/login\?next=/,{timeout:WAIT});
      await login.getByLabel('이메일',{exact:true}).fill(email);await login.getByLabel('비밀번호',{exact:true}).fill(created.temporaryPassword);
      const relogin=login.waitForResponse(r => r.request().method()==='POST' && r.url().endsWith('/auth/login'));
      await login.getByRole('button',{name:'로그인',exact:true}).click();expect((await relogin).status()).toBe(401);
      const restricted=await existingAgent.newPage();await restricted.goto(`/t/${PF}/admin`);
      await expect(restricted.getByRole('navigation',{name:'관리 메뉴'})).toBeVisible();
      await expect(restricted.getByRole('navigation',{name:'관리 메뉴'}).getByRole('link',{name:'상담원',exact:true})).toHaveCount(0);
      await restricted.goto(`/t/${PF}/admin/agents`);await expect(restricted.getByTestId('view-403')).toBeVisible();
    } finally {await admin.close();await agent.close();await existingAgent.close();await customer.close();}
  });

  test('mailpulse FAQ는 해당 테넌트의 실제 AI 답변과 근거를 표시', async ({browser},info) => {
    const slug='mailpulse';const item=demo(slug,'faq_campaign');
    const customer=await freshCustomer(browser,info,slug);
    try {
      const {page}=await submitTicket(customer,slug,item);
      const answer=page.locator('[data-testid="message"][data-author-type="ai"]');
      await expect(answer).toBeVisible({timeout:WAIT});
      await expect(answer.getByTestId('message-sources')).toBeVisible();
      await confirmResolved(page);
    } finally {await customer.close();}
  });

  test('KPI: 독립된 자동해결·이관 티켓 생성 후 두 비율과 분류 분포가 양수', async ({browser},info) => {
    const admin=await contextAs(browser,info,'admin');
    const customers:BrowserContext[]=[];
    try {
        const metricPath=`/t/${PF}/admin/metrics`;
        const before=await apiAs<TenantMetrics>(admin,'GET',metricPath);
        const faq=demo(PF,'faq_install');const refund=demo(PF,'refund_escalate');
        for(const item of [faq,refund]) {
          const customer=await freshCustomer(browser,info,PF);customers.push(customer);
          const {page,id}=await submitTicket(customer,PF,item);await waitRun(admin,PF,id,item.expected);
          if(item.expected.decision==='auto_answer') {await expect(page.locator('[data-testid="message"][data-author-type="ai"]')).toBeVisible({timeout:WAIT});await confirmResolved(page);}
        }
        const after=await apiAs<TenantMetrics>(admin,'GET',metricPath);
        expect(after.ticketsTotal-before.ticketsTotal).toBe(2);
        expect(after.autoResolvedTickets-before.autoResolvedTickets).toBe(1);
        expect(after.escalatedTickets-before.escalatedTickets).toBe(1);
        const page=await admin.newPage();
        const responsePromise=page.waitForResponse(r => r.request().method()==='GET' && new URL(r.url()).pathname===`/api${metricPath}`);
        await page.goto(`/t/${PF}/admin/metrics`);
        const response=await responsePromise;expect(response.status()).toBe(200);
        const raw=await response.json() as TenantMetrics;
        const rate=(n:number) => raw.ticketsTotal===0 ? 0 : Math.round(n/raw.ticketsTotal*1000)/1000;
        const autoRate=rate(raw.autoResolvedTickets);
        const escalationRate=rate(raw.escalatedTickets);
        expect(raw.autoResolutionRate).toBe(autoRate);
        expect(raw.escalationRate).toBe(escalationRate);
        expect(autoRate).toBeGreaterThan(0);expect(escalationRate).toBeGreaterThan(0);
        await expect(page.getByTestId('kpi-auto-resolution').locator('p').first()).toHaveText(`${(autoRate*100).toFixed(1)}%`);
        await expect(page.getByTestId('kpi-escalation').locator('p').first()).toHaveText(`${(escalationRate*100).toFixed(1)}%`);
        await expect(page.getByTestId('kpi-auto-resolution')).toContainText(`${raw.autoResolvedTickets} / ${raw.ticketsTotal}건`);
        await expect(page.getByTestId('kpi-escalation')).toContainText(`${raw.escalatedTickets} / ${raw.ticketsTotal}건`);
        const categories=page.getByRole('heading',{name:'카테고리 분포',exact:true}).locator('..');
        await expect(categories.locator('li').first()).toBeVisible();
    } finally {for(const customer of customers) await customer.close();await admin.close();}
  });

  test.describe('settings writers', () => {
    test.describe.configure({ mode: 'serial' });

    test('승인 모드: 접수 전 활성화 → 비공개 초안 → 승인 후 공개 → 설정 복구', async ({browser},info) => {
      // Ticket-channel approval. Chat-channel automatic conversion is covered by the next test.
      const item=demo(PF,'approval_pending');
      const staff=await contextAs(browser,info,'admin');
      let customer: BrowserContext | undefined;
      const pendingIds:string[]=[];
      try {
        expect(item.settingsOverride.approvalMode).toBe(true);
        await withSettings(staff,{approvalMode:item.settingsOverride.approvalMode},async () => {
          customer=await freshCustomer(browser,info,PF);
          const {page,id}=await submitTicket(customer,PF,item,id=>pendingIds.push(id));
          const detail=await waitRun(staff,PF,id,item.expected);
          expect(detail.drafts.some(d => d.status==='draft')).toBe(true);
          await page.reload();
          await expect(page.getByTestId('ticket-status')).toBeVisible({timeout:WAIT});
          await expect(page.locator('[data-testid="message"][data-author-type="ai"]')).toHaveCount(0);
          // Observe two real customer-page polling responses before approving. This
          // checks sustained non-disclosure without a fixed sleep or mocked response.
          for (let sample=0;sample<2;sample++) {
            const response=await page.waitForResponse(r => r.request().method()==='GET' && new URL(r.url()).pathname===`/api/t/${PF}/tickets/${id}`,{timeout:WAIT});
            expect(response.status()).toBe(200);
            const publicTicket=await response.json() as {messages:{authorType:string}[]};
            expect(publicTicket.messages.filter(m => m.authorType==='ai')).toHaveLength(0);
            await expect(page.locator('[data-testid="message"][data-author-type="ai"]')).toHaveCount(0);
          }
          const agentPage=await staff.newPage();
          await agentPage.goto(`/t/${PF}/admin/tickets/${id}`);
          const draftText=await agentPage.getByLabel('AI 초안 편집',{exact:true}).first().inputValue();
          expect(draftText.trim()).not.toBe('');
          await agentPage.getByTestId('draft-approve').first().click();
          await expect(page.locator('[data-testid="message"][data-author-type="agent"]')).toBeVisible({timeout:WAIT});
          const approved=await readCustomerTicket(customer,PF,id);
          expect(approved.messages.some(m => m.body===draftText)).toBe(true);
        },{beforeRestore:()=>waitForRunsToFinish(staff,pendingIds)});
      } finally {await customer?.close();await staff.close();}
    });

    // TASK#588-0: approval-mode chat is converted by the server (done.data.ticketId); no manual conversion.
    // demo has no chat-channel approval case (approval_pending is a ticket), so pixelforge chat_faq is sent with approval mode on.
    test('승인 모드 챗봇: done.ticketId 자동 접수 → 위젯 접수됨+링크·전환 버튼 없음 → 티켓 1건 → 복원 유지 → 설정 복구', async ({browser},info) => {
      const item=demo(PF,'chat_faq');
      const staff=await contextAs(browser,info,'admin');
      let customer: BrowserContext | undefined;
      try {
        await withSettings(staff,{approvalMode:true},async () => {
          customer=await freshCustomer(browser,info,PF);
          const page=await customer.newPage();
          await page.goto(`/t/${PF}/tickets`);
          await page.getByTestId('chat-open').click();
          await page.getByTestId('chat-input').fill(item.message);
          const responsePromise=page.waitForResponse(r => r.request().method()==='POST' && new URL(r.url()).pathname===`/api/t/${PF}/chat`);
          await page.getByTestId('chat-send').click();
          const response=await responsePromise;
          expect(response.status()).toBe(200);
          const wire=await response.text();
          const events=assertPublicSSEWire(wire,`${PF}/chat_faq(approval) POST /chat`);
          expect(events.filter(e => e.event==='token'),'승인 모드에서는 답변 토큰을 보내지 않는다').toHaveLength(0);
          expect(events.filter(e => e.event==='error')).toHaveLength(0);
          expect(events.find(e => e.event==='escalated')?.data.reason).toBe('approval_mode');
          const done=events.at(-1);
          expect(done?.event).toBe('done');
          const ticketId=done?.event==='done' ? done.data.ticketId : undefined;
          expect(ticketId,'승인 모드 자동 전환: done.data.ticketId').toBeTruthy();
          if (!ticketId || done?.event!=='done') throw new Error('done.ticketId 누락');
          const conversationId=done.data.conversationId;
          test.info().annotations.push({type:'ticketId',description:JSON.stringify({caseKey:'chat_faq(approval)',id:ticketId,conversationId})});

          // Widget: "접수됨 + 링크", no manual conversion button.
          const closed=page.getByTestId('chat-closed');
          await expect(closed).toHaveAttribute('data-auto-converted','true',{timeout:WAIT});
          await expect(closed).toContainText('문의가 접수되었습니다');
          await expect(closed.getByRole('link',{name:'접수된 문의 보기',exact:true})).toHaveAttribute('href',`/t/${PF}/tickets/${ticketId}`);
          await expect(page.getByTestId('chat-convert')).toHaveCount(0);

          // Exactly one customer ticket and it is the linked one.
          const tickets=await apiAs<ResultPage<{id:string}>>(customer,'GET',`/t/${PF}/tickets`);
          expect(tickets.total).toBe(1);
          expect(tickets.items.map(t => t.id)).toEqual([ticketId]);
          await readCustomerTicket(customer,PF,ticketId);

          // Restored conversation: public contract, converted to the same ticket, widget keeps the auto state after reload.
          const restorePath=`/api/t/${PF}/conversations/${conversationId}`;
          const restored=await customer.request.get(restorePath);
          expect(restored.status()).toBe(200);
          const restoredText=await restored.text();
          assertNoInternalStrings(restoredText,restorePath);
          const conversation=JSON.parse(restoredText) as {status:string;ticketId:string|null};
          assertPublicConversation(conversation,restorePath);
          expect(conversation.status).toBe('converted');
          expect(conversation.ticketId).toBe(ticketId);
          await page.reload();
          await page.getByTestId('chat-open').click();
          await expect(page.getByTestId('chat-closed')).toHaveAttribute('data-auto-converted','true',{timeout:WAIT});
          await expect(page.getByTestId('chat-convert')).toHaveCount(0);
        });
      } finally {await customer?.close();await staff.close();}
    });

    test('임계값 0.85: 경계 문의는 이관하고 더 높은 신뢰도 FAQ는 자동답변 → 0.7 복구', async ({browser},info) => {
      const item=demo(PF,'threshold_boundary');
      const faq=demo(PF,'faq_install');
      const probe=item.thresholdProbe;
      expect(probe).toBeDefined();
      const staff=await contextAs(browser,info,'admin');
      const customers:BrowserContext[]=[];
      const pendingIds:string[]=[];
      try {
        expect(item.expected.confidence).toBeLessThan(probe!.threshold);
        expect(faq.expected.confidence).toBeGreaterThanOrEqual(probe!.threshold);
        await withSettings(staff,{approvalMode:false,aiThreshold:probe!.threshold},async () => {
          const boundaryCustomer=await freshCustomer(browser,info,PF);customers.push(boundaryCustomer);
          const faqCustomer=await freshCustomer(browser,info,PF);customers.push(faqCustomer);
          const boundaryTicket=await submitTicket(boundaryCustomer,PF,item,id=>pendingIds.push(id));
          const faqTicket=await submitTicket(faqCustomer,PF,faq,id=>pendingIds.push(id));
          // Both tickets are submitted and fully processed under the same raised setting.
          await waitRun(staff,PF,boundaryTicket.id,{...item.expected,decision:probe!.decision,reason:probe!.reason});
          await waitRun(staff,PF,faqTicket.id,faq.expected);
          const page=await staff.newPage();await page.goto(`/t/${PF}/admin/tickets/${boundaryTicket.id}`);
          await expect(page.getByText(`이관 사유: ${decisionReasonLabel[probe!.reason]}`,{exact:true})).toBeVisible({timeout:WAIT});
          await expect(faqTicket.page.locator('[data-testid="message"][data-author-type="ai"]')).toBeVisible({timeout:WAIT});
        },{restore:{aiThreshold:0.7},beforeRestore:()=>waitForRunsToFinish(staff,pendingIds)});
      } finally {for(const context of customers) await context.close();await staff.close();}
    });
  });
});
