'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Send, Square, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ChatInputSchema, ConvertConversationInputSchema, SSEEventSchema, type SSEEvent } from '@support/contracts';
import { api, fieldErrors, isApiError, rawApi } from '@/lib/api';
import { qk } from '@/lib/hooks';
import { decisionReasonText, noticeCopy } from '@/lib/labels';
import type { Conversation, NoticeCode, PublicSource } from '@/lib/types';
import { cn } from '@/lib/utils';
import { SafeMarkdown } from '../safe-markdown';
import { useTenant } from '../tenant-context';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '../ui/dialog';
import { Field, Input, Textarea, fieldAria } from '../ui/form-controls';
import { Spinner } from '../ui/surface';
import { SourceList, koreanErrorMap } from './shared';
import { readSSE, type RawSSEFrame } from './sse';

/**
 * 챗봇 위젯(고객 전용, PortalShell이 띄운다).
 * POST /t/{slug}/chat 응답 SSE를 직접 읽어 classified → token* → sources → done / escalated / error를 그린다.
 * 대화 ID는 sessionStorage에 두고 새로고침 시 GET /conversations/{id}로 복원한다.
 */

type Phase = 'classifying' | 'answering' | 'done' | 'stopped' | 'failed';
interface Escalation {
  reason: string;
  message: string;
  /** 대화 복원 system 메시지의 안내 코드(contracts NoticeCodeSchema). 있으면 안내 문구의 1순위 */
  noticeCode?: NoticeCode | null;
}

/** 안내 문구 선택: noticeCode → (실시간 SSE의) reason=approval_mode → 일반 이관 안내 */
function escalationCopy(e: Escalation) {
  if (e.noticeCode) return noticeCopy[e.noticeCode];
  return e.reason === 'approval_mode' ? noticeCopy.APPROVAL_REQUIRED : noticeCopy.ESCALATED;
}
interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  sources: PublicSource[];
  escalation?: Escalation | null;
  error?: string | null;
  phase?: Phase;
}
interface ConvState {
  status: Conversation['status'];
  ticketId: string | null;
  /** 이번 응답에서 서버가 자동으로 문의를 접수함(승인 모드, done.ticketId) — 안내 문구만 다르다 */
  auto?: boolean;
}

/** 화면 처리용 이벤트: 계약 SSEEventSchema 그대로, sources만 화면 근거(PublicSource) 형태로 바꾼다. */
type ChatStreamEvent = Exclude<SSEEvent, { event: 'sources' }> | { event: 'sources'; data: { sources: PublicSource[] } };

const DEFAULT_ESCALATION = '상담원 확인이 필요한 문의입니다. 문의글로 남겨 주시면 상담원이 답변드립니다.';
const DEFAULT_ERROR = '답변 중 오류가 발생했습니다. 잠시 후 다시 시도하거나 문의글로 남겨 주세요.';
const titleErrorMap = koreanErrorMap({ title: '제목' });
const bodyErrorMap = koreanErrorMap({ body: '메시지' });

const storageKey = (slug: string) => `sd-chat:${slug}`;
function readStored(slug: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(slug));
  } catch {
    return null;
  }
}
function writeStored(slug: string, id: string | null) {
  try {
    if (id) window.sessionStorage.setItem(storageKey(slug), id);
    else window.sessionStorage.removeItem(storageKey(slug));
  } catch {
    /* 저장소 차단(사생활 모드 등): 새로고침 복원만 포기 */
  }
}

let seq = 0;
const localId = () => `local-${Date.now()}-${++seq}`;

/** 계약 밖 프레임(JSON 아님·스키마 불일치·모르는 이벤트)은 화면에서 오류 안내로 처리한다. */
const CONTRACT_ERROR: ChatStreamEvent = { event: 'error', data: { code: 'INTERNAL', message: DEFAULT_ERROR } };

function toEvent(frame: RawSSEFrame): ChatStreamEvent {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return CONTRACT_ERROR;
  }
  const parsed = SSEEventSchema.safeParse({ event: frame.event, data });
  if (!parsed.success) return CONTRACT_ERROR;
  if (parsed.data.event === 'sources') return { event: 'sources', data: { sources: parsed.data.data.sources.map(toPublicSource) } };
  return parsed.data;
}

/** 계약 근거({id,title,excerpt?,url?}) → 화면 근거 */
function toPublicSource(s: { id: string; title: string; excerpt?: string; url?: string }): PublicSource {
  return { id: s.id, title: s.title, excerpt: s.excerpt || null, ...(s.url ? { url: s.url } : {}) };
}

function fromConversation(c: Conversation): ChatItem[] {
  return c.messages.map((m) =>
    m.role === 'user'
      ? { id: m.id, role: 'user', body: m.body, sources: [] }
      : m.role === 'assistant'
        ? { id: m.id, role: 'assistant', body: m.body, sources: m.sources, phase: 'done' }
        : // system = 저장된 이관·오류 안내. noticeCode(1순위)·escalationReason(사유 한 줄)
          {
            id: m.id,
            role: 'assistant',
            body: '',
            sources: [],
            escalation: { reason: m.escalationReason ?? '', message: m.body, noticeCode: m.noticeCode ?? null },
            phase: 'done',
          },
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function ChatWidget() {
  const { slug, settings, href } = useTenant();
  const router = useRouter();
  const qc = useQueryClient();
  const base = `/t/${encodeURIComponent(slug)}`;

  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [conv, setConv] = useState<ConvState>({ status: 'open', ticketId: null });
  const [items, setItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [draft, setDraft] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // 저장된 대화 ID 읽기(마운트 1회)
  useEffect(() => {
    const id = readStored(slug);
    if (id) {
      setConversationId(id);
      setRestoreId(id);
    }
  }, [slug]);

  const restore = useQuery({
    queryKey: qk.conversation(slug, restoreId ?? ''),
    queryFn: () => api<Conversation>(`${base}/conversations/${encodeURIComponent(restoreId!)}`),
    enabled: restoreId !== null,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!restoreId) return;
    if (restore.data) {
      setItems(fromConversation(restore.data));
      // 승인 모드에서는 서버가 자동 접수하므로, 복원 시에도 APPROVAL_REQUIRED 안내가 있는 전환 대화는 '접수됨'으로 보여준다
      const auto = restore.data.status === 'converted' && restore.data.messages.some((m) => m.noticeCode === 'APPROVAL_REQUIRED');
      setConv({ status: restore.data.status, ticketId: restore.data.ticketId, auto });
      setRestoreId(null);
    } else if (restore.isError) {
      if (isApiError(restore.error) && restore.error.status === 404) {
        // 없는 대화(다른 계정·삭제) → 새 대화로
        writeStored(slug, null);
        setConversationId(null);
      } else {
        setNotice('이전 대화를 불러오지 못했습니다. 메시지를 보내면 대화를 이어갑니다.');
      }
      setRestoreId(null);
    }
  }, [restore.data, restore.isError, restore.error, restoreId, slug]);

  // 포커스: 열면 입력창(없으면 닫기 버튼), 닫으면 여는 버튼으로
  useEffect(() => {
    if (open) (inputRef.current ?? closeButtonRef.current)?.focus();
    else if (wasOpen.current) openButtonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, open, conv.status]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patchItem = (id: string, fn: (it: ChatItem) => ChatItem) => setItems((list) => list.map((it) => (it.id === id ? fn(it) : it)));
  const restoring = restoreId !== null;

  async function send(text: string) {
    if (streaming || restoring) return;
    const parsed = ChatInputSchema.safeParse({ body: text }, { errorMap: bodyErrorMap });
    if (!parsed.success) {
      setInputError(parsed.error.issues[0]?.message ?? '메시지를 확인해 주세요.');
      return;
    }
    const body = parsed.data.body;
    setInputError(null);
    setNotice(null);
    setDraft('');

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const replyId = localId();
    setItems((l) => [...l, { id: localId(), role: 'user', body, sources: [] }, { id: replyId, role: 'assistant', body: '', sources: [], phase: 'classifying' }]);
    setStreaming(true);

    let cid = conversationId;
    const adopt = (id: string) => {
      if (id === cid) return;
      cid = id;
      setConversationId(id);
      writeStored(slug, id);
    };
    let answer = '';
    let escalation: Escalation | null = null;
    let errorMsg: string | null = null;
    let autoTicketId: string | null = null;

    try {
      const res = await rawApi(`${base}/chat`, {
        method: 'POST',
        body: cid ? { conversationId: cid, body } : { body },
        headers: { accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.body) throw new Error(DEFAULT_ERROR);
      for await (const frame of readSSE(res.body)) {
        const ev = toEvent(frame);
        if (!ev) continue;
        switch (ev.event) {
          case 'classified':
            adopt(ev.data.conversationId);
            patchItem(replyId, (it) => ({ ...it, phase: 'answering' }));
            break;
          case 'token': {
            const token = ev.data.token;
            answer += token;
            patchItem(replyId, (it) => ({ ...it, phase: 'answering', body: it.body + token }));
            break;
          }
          case 'sources': {
            const sources = ev.data.sources;
            patchItem(replyId, (it) => ({ ...it, sources }));
            break;
          }
          case 'escalated': {
            const esc: Escalation = { reason: ev.data.reason, message: ev.data.message || DEFAULT_ESCALATION };
            escalation = esc;
            patchItem(replyId, (it) => ({ ...it, escalation: esc }));
            break;
          }
          case 'error': {
            const message = ev.data.message || DEFAULT_ERROR;
            errorMsg = message;
            patchItem(replyId, (it) => ({ ...it, error: message }));
            break;
          }
          case 'done':
            adopt(ev.data.conversationId);
            // 승인 모드 자동 전환: 서버가 문의를 이미 접수했으면 done에만 ticketId가 온다(escalated에는 오지 않음)
            if (ev.data.ticketId) autoTicketId = ev.data.ticketId;
            break;
        }
      }
      patchItem(replyId, (it) => ({ ...it, phase: errorMsg ? 'failed' : 'done' }));
      const esc = escalation as Escalation | null;
      const ticketId = autoTicketId as string | null;
      if (ticketId) {
        // 대화 ID는 sessionStorage에 그대로 두고, 새로고침 시 서버 대화 상태(converted + ticketId)로 복원된다
        setConv({ status: 'converted', ticketId, auto: true });
        void qc.invalidateQueries({ queryKey: ['tickets', slug] });
      }
      setAnnouncement(
        errorMsg
          ? `오류: ${errorMsg}`
          : ticketId
            ? `${settings.chatbotName}: 문의가 접수되었습니다. 상담원이 확인한 뒤 답변드립니다.`
            : esc
              ? `${settings.chatbotName}: ${esc.message}`
              : answer
                ? `${settings.chatbotName}의 답변: ${truncate(answer, 300)}`
                : `${settings.chatbotName}의 응답이 끝났습니다.`,
      );
    } catch (e) {
      if (ctrl.signal.aborted) {
        patchItem(replyId, (it) => ({ ...it, phase: 'stopped' }));
        setAnnouncement('응답을 중단했습니다.');
        return;
      }
      let message = e instanceof Error && e.message ? e.message : DEFAULT_ERROR;
      if (isApiError(e) && e.status === 409) {
        // 이미 문의글로 전환(또는 종료)된 대화
        const d = (e.details ?? {}) as { status?: string; ticketId?: string | null };
        setConv({ status: d.status === 'closed' ? 'closed' : 'converted', ticketId: d.ticketId ?? null });
        message = d.ticketId ? '이미 문의글로 전환된 대화입니다. 전환된 문의에서 이어서 확인해 주세요.' : '더 이상 메시지를 보낼 수 없는 대화입니다.';
      } else if (isApiError(e) && e.status === 404 && cid) {
        writeStored(slug, null);
        setConversationId(null);
        message = '이전 대화를 찾을 수 없어 새 대화로 시작합니다. 메시지를 다시 보내 주세요.';
      } else if (isApiError(e) && e.status === 401) {
        message = '로그인이 만료되었습니다. 다시 로그인해 주세요.';
        void qc.invalidateQueries({ queryKey: qk.me(slug) });
      } else if (isApiError(e) && e.code === 'VALIDATION_FAILED') {
        message = fieldErrors(e).body ?? e.message;
      }
      patchItem(replyId, (it) => ({ ...it, phase: 'failed', error: message }));
      setAnnouncement(`오류: ${message}`);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setStreaming(false);
    }
  }

  const retryFor = (index: number) => {
    const question = items
      .slice(0, index)
      .reverse()
      .find((i) => i.role === 'user')?.body;
    return question ? () => void send(question) : undefined;
  };

  function startNew() {
    abortRef.current?.abort();
    writeStored(slug, null);
    setConversationId(null);
    setRestoreId(null);
    setItems([]);
    setConv({ status: 'open', ticketId: null });
    setNotice(null);
    setInputError(null);
    setAnnouncement('새 대화를 시작했습니다.');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onConverted(ticketId: string) {
    setConv({ status: 'converted', ticketId });
    setConvertOpen(false);
    setOpen(false);
    setAnnouncement('문의글로 전환되었습니다. 문의 상세 화면으로 이동합니다.');
    void qc.invalidateQueries({ queryKey: ['tickets', slug] });
    router.push(href(`/tickets/${ticketId}`));
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };
  const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 전송, Shift+Enter 줄바꿈. 한글 조합 중 Enter는 무시
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !convertOpen) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const firstQuestion = items.find((i) => i.role === 'user')?.body ?? '';
  const canConvert = conv.status === 'open' && conversationId !== null && !streaming && !restoring && firstQuestion !== '';

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <Button
        ref={openButtonRef}
        data-testid="chat-open"
        aria-expanded={open}
        aria-controls="chat-panel"
        onClick={() => setOpen(true)}
        className={cn('fixed bottom-4 right-4 z-30 h-12 rounded-full px-4 shadow-lg', open && 'hidden')}
      >
        <MessageCircle className="h-5 w-5" aria-hidden />
        <span className="max-w-[40vw] truncate">{settings.chatbotName}</span>
      </Button>

      {open && (
        <div
          id="chat-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="chat-panel-title"
          onKeyDown={onPanelKeyDown}
          className="fixed inset-2 z-30 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[min(640px,calc(100dvh-2rem))] sm:w-[380px]"
        >
          <header className="flex items-center justify-between gap-2 border-b border-border bg-brand px-4 py-2 text-brand-foreground">
            <div className="min-w-0">
              <h2 id="chat-panel-title" className="truncate font-semibold">
                {settings.chatbotName}
              </h2>
              <p className="truncate text-xs opacity-90">{settings.displayName} 고객센터</p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="챗봇 닫기"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-current"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </header>

          <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-3 py-3" aria-label="대화 내용" role="region">
            {restoring ? (
              <div className="flex justify-center py-6">
                <Spinner label="이전 대화를 불러오는 중" />
              </div>
            ) : items.length === 0 ? (
              <Greeting />
            ) : (
              items.map((it, i) => (
                <ChatBubble
                  key={it.id}
                  item={it}
                  canConvert={conv.status === 'open'}
                  // 처리 실패 안내: 바로 앞 질문을 다시 보낸다(대화가 열려 있고 응답 중이 아닐 때)
                  onRetry={conv.status === 'open' && !streaming ? retryFor(i) : undefined}
                />
              ))
            )}
            {notice && <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">{notice}</p>}
          </div>

          <footer className="border-t border-border p-3">
            {conv.status !== 'open' ? (
              <div className="space-y-2 text-sm" data-testid="chat-closed" data-auto-converted={conv.auto || undefined}>
                <p>
                  {conv.status !== 'converted'
                    ? '종료된 대화입니다.'
                    : conv.auto
                      ? '문의가 접수되었습니다. 상담원이 확인한 뒤 답변드립니다.'
                      : '이 대화는 문의글로 전환되었습니다.'}
                  {conv.ticketId && (
                    <>
                      {' '}
                      <Link href={href(`/tickets/${conv.ticketId}`)} onClick={() => setOpen(false)} className="font-medium text-info underline underline-offset-2">
                        {conv.auto ? '접수된 문의 보기' : '전환된 문의 보기'}
                      </Link>
                    </>
                  )}
                </p>
                <Button variant="outline" className="w-full" onClick={startNew}>
                  새 대화 시작
                </Button>
              </div>
            ) : (
              <>
                {canConvert && conversationId && (
                  <ConvertDialog
                    open={convertOpen}
                    onOpenChange={setConvertOpen}
                    defaultTitle={truncate(firstQuestion.replace(/\s+/g, ' ').trim(), 50)}
                    path={`${base}/conversations/${encodeURIComponent(conversationId)}/convert`}
                    onConverted={onConverted}
                  />
                )}
                <form onSubmit={onSubmit} noValidate className="flex items-end gap-2">
                  <Field id="chat-input" label={<span className="sr-only">{settings.chatbotName}에게 보낼 메시지</span>} error={inputError ?? undefined} className="min-w-0 flex-1 space-y-0">
                    <Textarea
                      ref={inputRef}
                      {...fieldAria('chat-input', inputError ?? undefined)}
                      data-testid="chat-input"
                      rows={2}
                      maxLength={10000}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={onInputKeyDown}
                      disabled={restoring}
                      placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
                      className="max-h-32 min-h-10 resize-none"
                    />
                  </Field>
                  {streaming ? (
                    <Button variant="outline" size="icon" onClick={() => abortRef.current?.abort()} aria-label="응답 중단" data-testid="chat-stop">
                      <Square className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : (
                    <Button type="submit" size="icon" aria-label="보내기" disabled={restoring} data-testid="chat-send">
                      <Send className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </form>
              </>
            )}
          </footer>
        </div>
      )}
    </>
  );
}

function Greeting() {
  const { settings } = useTenant();
  return (
    <div className="rounded-lg bg-muted px-3 py-3 text-sm">
      <p className="font-medium">{settings.chatbotName}에게 궁금한 점을 물어보세요.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {settings.approvalMode
          ? '이 고객센터는 상담원이 내용을 확인한 뒤 답변합니다. 남긴 질문은 문의글로 전환할 수 있습니다.'
          : '바로 답하기 어려운 내용은 문의글로 남기면 상담원이 이어서 답변합니다.'}
      </p>
    </div>
  );
}

function ChatBubble({ item, canConvert, onRetry }: { item: ChatItem; canConvert: boolean; onRetry?: () => void }) {
  const { settings } = useTenant();
  // 링크 차단의 1차 방어는 서버 sanitize, 여기서는 허용 도메인으로 한 번 더 거른다(2차 방어)
  const domains = settings.allowedLinkDomains ?? [];
  const copy = item.escalation ? escalationCopy(item.escalation) : null;
  // 승인 모드는 제목·설명이 이미 같은 뜻이라 사유 줄을 덧붙이지 않는다
  const reasonText = item.escalation?.reason !== 'approval_mode' ? decisionReasonText(item.escalation?.reason) : null;
  if (item.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="chat-message" data-role="user">
        <div className="min-w-0 max-w-[85%] rounded-lg bg-brand px-3 py-2 text-brand-foreground">
          <SafeMarkdown allowedDomains={domains} className="break-words [&_a]:text-current">
            {item.body}
          </SafeMarkdown>
        </div>
      </div>
    );
  }
  const waiting = !item.body && !item.escalation && !item.error;
  return (
    <div className="flex justify-start" data-testid="chat-message" data-role="assistant">
      <div className="min-w-0 max-w-[90%] space-y-2">
        <p className="text-xs font-semibold text-muted-foreground">{settings.chatbotName}</p>
        {waiting && item.phase === 'classifying' && <Spinner label="문의 내용을 확인하는 중" />}
        {waiting && item.phase === 'answering' && <Spinner label="답변을 준비하는 중" />}
        {item.body && (
          <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
            <SafeMarkdown allowedDomains={domains} className="break-words">
              {item.body}
            </SafeMarkdown>
            <SourceList sources={item.sources} allowedDomains={domains} />
          </div>
        )}
        {copy && item.escalation && (
          <div
            className={cn(
              'rounded-lg border px-3 py-2 text-sm',
              copy.tone === 'danger' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-info/30 bg-info-soft text-info',
            )}
            data-testid="chat-escalated"
            data-reason={item.escalation.reason || undefined}
            data-notice={item.escalation.noticeCode || undefined}
          >
            <p className="font-semibold">{copy.title}</p>
            {copy.detail && <p className="mt-1">{copy.detail}</p>}
            {item.escalation.message && item.escalation.message !== copy.detail && <p className="mt-1 break-words">{item.escalation.message}</p>}
            {reasonText && <p className="mt-1 text-xs">사유: {reasonText}</p>}
            {canConvert && <p className="mt-1 text-xs">아래 ‘문의글로 남기기’를 누르면 대화 내용이 문의로 접수됩니다.</p>}
            {copy.retry && onRetry && (
              <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
                다시 보내기
              </Button>
            )}
          </div>
        )}
        {item.error && <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">{item.error}</p>}
        {item.phase === 'stopped' && <p className="text-xs text-muted-foreground">응답을 중단했습니다.</p>}
      </div>
    </div>
  );
}

function ConvertDialog({
  open,
  onOpenChange,
  defaultTitle,
  path,
  onConverted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultTitle: string;
  path: string;
  onConverted: (ticketId: string) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (t: string) => api<{ ticketId: string; created: boolean }>(path, { method: 'POST', body: { title: t } }),
    onSuccess: (r) => onConverted(r.ticketId),
    onError: (e) => setError(fieldErrors(e).title ?? e.message),
  });

  const onChange = (v: boolean) => {
    if (v) {
      setTitle(defaultTitle);
      setError(null);
      m.reset();
    }
    onOpenChange(v);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = ConvertConversationInputSchema.safeParse({ title }, { errorMap: titleErrorMap });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '제목을 확인해 주세요.');
      return;
    }
    setError(null);
    m.mutate(parsed.data.title);
  };

  return (
    <Dialog open={open} onOpenChange={onChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="mb-2 w-full" data-testid="chat-convert">
          문의글로 남기기
        </Button>
      </DialogTrigger>
      <DialogContent title="문의글로 남기기" description="지금까지의 대화 내용이 문의에 함께 첨부되고, 상담원이 확인 후 답변드립니다.">
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field id="chat-convert-title" label="문의 제목" error={error ?? undefined}>
            <Input {...fieldAria('chat-convert-title', error ?? undefined)} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline">취소</Button>
            </DialogClose>
            <Button type="submit" disabled={m.isPending} data-testid="chat-convert-submit">
              {m.isPending ? '전환 중…' : '문의 등록'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
