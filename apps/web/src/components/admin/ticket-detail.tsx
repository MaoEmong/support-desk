'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { qk } from '@/lib/hooks';
import type { Draft, StaffTicketDetail, TicketStatus } from '@/lib/types';
import { ticketStatusLabel } from '@/lib/labels';
import { SafeMarkdown } from '@/components/safe-markdown';
import { ConflictNotice, ErrorView, LoadingView } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/form-controls';
import { Alert, Badge, Card, PageHeader } from '@/components/ui/surface';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { dateLabel, MessageSources, reasonLabel, Sources, TicketBadges, useAdminApi } from './shared';

const transitions: Record<TicketStatus, TicketStatus[]> = { open: ['in_progress','resolved','closed'], in_progress: ['open','resolved','closed'], resolved: ['in_progress','closed'], closed: [] };

export function TicketDetail({ id }: { id: string }) {
  const { slug, base, href, agents, domains, categoryLabel } = useAdminApi();
  const client = useQueryClient();
  const path = `${base}/tickets/${encodeURIComponent(id)}`;
  const key = qk.staffTicket(slug,id);
  const ticket = useQuery({ queryKey: key, queryFn: () => api<StaffTicketDetail>(path), refetchInterval: query => query.state.status === 'error' ? false : 5000 });
  const [body,setBody] = useState('');
  const [visibility,setVisibility] = useState<'public'|'internal'>('public');
  const [pending,setPending] = useState(false);
  const actionLock = useRef(false);
  function acquire() { if (actionLock.current) return false; actionLock.current = true; setPending(true); return true; }
  function release() { actionLock.current = false; setPending(false); }
  const [error,setError] = useState<unknown>(null);
  const [notice,setNotice] = useState('');
  const [conflict,setConflict] = useState(false);
  async function mutate(suffix: string, method: 'POST'|'PATCH', payload?: unknown) {
    if (!acquire()) return false;
    setError(null); setConflict(false); setNotice('');
    try {
      const result = await api<StaffTicketDetail>(`${path}${suffix}`, { method, body: payload, headers: suffix.endsWith('regenerate') ? { 'Idempotency-Key': newIdempotencyKey() } : undefined });
      if (suffix.endsWith('regenerate')) { setNotice('초안 재생성을 요청했습니다. 완료되면 자동으로 표시됩니다.'); await ticket.refetch(); }
      else client.setQueryData(key,result);
      await client.invalidateQueries({queryKey:['queue',slug]});
      return true;
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409) { setConflict(true); if (e.code === 'JOB_IN_PROGRESS') setNotice('이미 초안 생성 작업이 진행 중입니다.'); await ticket.refetch(); }
      else setError(e);
      return false;
    } finally { release(); }
  }
  if (ticket.isPending) return <LoadingView />;
  if (!ticket.data) return <ErrorView error={ticket.error} retry={() => ticket.refetch()} loginHref={href('/login')} />;
  const t = ticket.data;
  const latest = [...t.aiRuns].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  return <div className="min-w-0 space-y-5"><PageHeader title={t.title} description={`${t.customer?.name ?? '고객'} · ${dateLabel(t.createdAt)}`} /><TicketBadges ticket={t} categoryLabel={categoryLabel} />
    {ticket.isError && <Alert tone="danger">최신 내용을 불러오지 못했습니다. 작성 내용은 유지됩니다.<Button variant="outline" onClick={() => ticket.refetch()}>다시 시도</Button></Alert>}{conflict && <ConflictNotice onReload={() => ticket.refetch()} />}{notice && <Alert live>{notice}</Alert>}{error != null && <Alert tone="danger">{error instanceof Error ? error.message : '변경에 실패했습니다.'}<Button variant="outline" onClick={() => ticket.refetch()}>최신 내용 다시 조회</Button></Alert>}
    <Card className="grid gap-4 sm:grid-cols-2"><Field id="ticket-status" label="문의 상태"><Select id="ticket-status" data-testid="status-select" value={t.status} disabled={pending || !transitions[t.status].length} onChange={e => mutate('', 'PATCH', {version:t.version,status:e.target.value})}>{[t.status,...transitions[t.status]].map(s => <option key={s} value={s}>{ticketStatusLabel[s]}</option>)}</Select></Field><Field id="ticket-assignee" label="담당자"><Select id="ticket-assignee" data-testid="assignee-select" value={t.assigneeId ?? ''} disabled={pending || !agents.data} onChange={e => mutate('', 'PATCH', {version:t.version,assigneeId:e.target.value || null})}><option value="">미배정</option>{t.assigneeId && !agents.data?.items.some(a => a.id===t.assigneeId && a.status !== 'disabled') && <option value={t.assigneeId} disabled>{t.assignee?.name ?? '현재 담당자'} (배정 불가)</option>}{agents.data?.items.filter(a => a.status !== 'disabled').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>{agents.isError && <p role="alert" className="text-sm text-danger">담당자 목록을 불러오지 못했습니다.</p>}</Field></Card>
    <section aria-label="대화 이력" className="space-y-3"><h2 className="text-lg font-semibold">대화 이력</h2>{!t.messages.length && <Card><SafeMarkdown allowedDomains={domains}>{t.body}</SafeMarkdown></Card>}{t.messages.map(m => <Card key={m.id} className={m.visibility === 'internal' ? 'border-warning/40 bg-warning-soft' : ''}><div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={m.visibility === 'internal' ? 'warning' : 'info'}>{m.visibility === 'internal' ? '내부 메모 · 고객 비공개' : '고객 공개'}</Badge><Badge>{({customer:'고객',agent:'상담원',ai:'AI',system:'시스템'})[m.authorType]}</Badge><strong className="break-all text-sm">{m.authorName}</strong><time className="text-xs text-muted-foreground">{dateLabel(m.createdAt)}</time></div><SafeMarkdown allowedDomains={domains}>{m.body}</SafeMarkdown><MessageSources sources={m.sources} domains={domains} /></Card>)}</section>
    <Card><h2 className="mb-3 text-lg font-semibold">답변 작성</h2><div className="mb-3 flex flex-wrap gap-2"><Button data-testid="visibility-public" disabled={pending} aria-pressed={visibility === 'public'} variant={visibility === 'public' ? 'default' : 'outline'} onClick={() => setVisibility('public')}>고객에게 공개 답변</Button><Button data-testid="visibility-internal" disabled={pending} aria-pressed={visibility === 'internal'} variant={visibility === 'internal' ? 'default' : 'outline'} onClick={() => setVisibility('internal')}>내부 메모</Button></div><form onSubmit={async e => { e.preventDefault(); if (await mutate('/messages','POST',{body,visibility})) setBody(''); }}><Field id="staff-reply" label={visibility === 'public' ? '공개 답변 내용' : '내부 메모 내용'}><Textarea id="staff-reply" data-testid="staff-reply-input" disabled={pending} required maxLength={20000} value={body} onChange={e => setBody(e.target.value)} /></Field><p className="my-3 text-sm">{visibility === 'public' ? '전송하면 고객이 바로 볼 수 있습니다.' : '이 메모는 상담원과 관리자만 볼 수 있습니다.'}</p><Button type="submit" data-testid="staff-reply-submit" disabled={pending || !body.trim() || (visibility === 'public' && t.status === 'closed')}>{visibility === 'public' ? '고객에게 답변 전송' : '내부 메모 저장'}</Button>{t.status === 'closed' && <p className="mt-2 text-sm">종료된 문의에는 공개 답변을 보낼 수 없습니다.</p>}</form></Card>
    <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">AI 초안</h2><Button variant="outline" disabled={pending || t.status === 'closed'} onClick={() => mutate('/drafts/regenerate','POST')}>초안 재생성</Button></div>{t.drafts.map(d => <DraftEditor busy={pending} acquire={acquire} release={release} key={d.id} draft={d} path={path} domains={domains} closed={t.status === 'closed'} onSuccess={result => { client.setQueryData(key,result); void client.invalidateQueries({queryKey:['queue',slug]}); }} refetch={() => ticket.refetch()} />)}<details><summary className="cursor-pointer">처리된 초안 이력 ({t.drafts.filter(d => d.status === 'sent' || d.status === 'rejected').length})</summary>{t.drafts.filter(d => d.status === 'sent' || d.status === 'rejected').map(d => <Card key={d.id} className="mt-3"><Badge>{d.status === 'sent' ? '발송됨' : '반려됨'}</Badge><SafeMarkdown allowedDomains={domains}>{d.body}</SafeMarkdown>{d.rejectReason && <p>반려 사유: {d.rejectReason}</p>}<Sources sources={d.sources} domains={domains} /></Card>)}</details></section>
    <Card><h2 className="mb-3 text-lg font-semibold">최신 AI 분석</h2>{latest ? <><dl className="grid gap-3 text-sm sm:grid-cols-2">{Object.entries({분류:categoryLabel(latest.category),긴급도:latest.urgency,감정:latest.sentiment,신뢰도:latest.confidence == null ? null : `${(latest.confidence*100).toFixed(1)}%`,결정:latest.decision ? ({auto_answer:'자동답변',escalate:'상담원 이관',pending_approval:'승인 대기'} as Record<string,string>)[latest.decision] ?? latest.decision : null,사유:reasonLabel(latest.reason),모델:latest.model,'처리 시간(ms)':latest.latencyMs,상태:latest.status}).map(([label,value]) => <div key={label} className="break-words"><dt className="text-muted-foreground">{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>{latest.error && <Alert tone="danger" title="AI 처리 실패">{latest.error}</Alert>}</> : <p className="text-sm">아직 AI 분석이 없습니다.</p>}</Card>
  </div>;
}

function DraftEditor({ draft, path, domains, closed, busy, acquire, release, onSuccess, refetch }: {
  draft: Draft; path: string; domains: string[]; closed: boolean; busy: boolean;
  acquire: () => boolean; release: () => void;
  onSuccess: (t: StaffTicketDetail) => void; refetch: () => unknown;
}) {
  const [editing, setEditing] = useState(draft);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [current, setCurrent] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('');
  const newest = current && current.version > draft.version ? current : draft;
  const hasNewVersion = newest.version !== editing.version;
  const inactive = draft.status === 'sent' || draft.status === 'rejected';
  const initiallyActive = useRef(!inactive);

  async function act(action: 'save' | 'approve' | 'reject') {
    if (!acquire()) return;
    setError(null);
    try {
      const result = await api<StaffTicketDetail>(`${path}/drafts/${draft.id}${action === 'save' ? '' : `/${action}`}`, {
        method: action === 'save' ? 'PATCH' : 'POST',
        body: action === 'reject' ? { version: editing.version, reason } : { version: editing.version, body: editing.body },
      });
      const updated = result.drafts.find(d => d.id === draft.id);
      if (updated) setEditing(updated);
      setConflict(false); setReject(false); onSuccess(result);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409) {
        setConflict(true);
        setCurrent((e.details as { current?: Draft } | null)?.current ?? null);
        refetch();
      } else setError(e);
    } finally { release(); }
  }

  // Keep the editor and dialog triggers mounted when another agent processes this draft.
  if (!initiallyActive.current && !conflict && !hasNewVersion) return null;
  return <Dialog open={confirm} onOpenChange={setConfirm}>
    <Card className="space-y-3">
      <Badge>{inactive ? '처리된 초안 · 편집 내용 보존' : draft.status === 'approved' ? '승인된 초안' : '검토 대기 초안'}</Badge>
      {conflict && <ConflictNotice message="초안이 변경되었습니다. 편집 내용은 유지됩니다. 최신 초안을 확인하고 적용해 주세요." onReload={() => setConfirm(true)} />}
      {hasNewVersion && <Alert tone="warning">새 버전이 있습니다. 편집 내용은 자동으로 바뀌지 않습니다.</Alert>}
      <DialogTrigger asChild><Button variant="outline" disabled={busy}>최신 초안 확인</Button></DialogTrigger>
      {error != null && <Alert tone="danger">{error instanceof Error ? error.message : '초안 처리에 실패했습니다.'}<Button variant="outline" onClick={() => refetch()}>최신 내용 다시 조회</Button></Alert>}
      <Field id={`draft-${draft.id}`} label="AI 초안 편집"><Textarea id={`draft-${draft.id}`} disabled={busy || inactive} maxLength={20000} value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} /></Field>
      <details><summary>미리 보기</summary><SafeMarkdown allowedDomains={domains}>{editing.body}</SafeMarkdown></details>
      <Sources sources={draft.sources} domains={domains} />
      <p className="text-sm">승인하면 편집한 답변이 고객에게 즉시 발송됩니다.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || conflict || hasNewVersion || inactive || !editing.body.trim()} onClick={() => act('save')}>초안 저장</Button>
        <Button data-testid="draft-approve" disabled={busy || conflict || hasNewVersion || inactive || closed || !editing.body.trim()} onClick={() => act('approve')}>승인·발송</Button>
        <Dialog open={reject} onOpenChange={v => { if (!busy) setReject(v); }}>
          <DialogTrigger asChild><Button data-testid="draft-reject" variant="danger" disabled={busy || conflict || hasNewVersion} aria-disabled={inactive} onClick={e => { if (inactive) e.preventDefault(); }}>반려</Button></DialogTrigger>
          <DialogContent title="AI 초안 반려">
            {error != null && <Alert tone="danger">{error instanceof Error ? error.message : '반려에 실패했습니다.'}</Alert>}
            <Field id={`reason-${draft.id}`} label="반려 사유 (선택)"><Textarea id={`reason-${draft.id}`} disabled={busy} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field>
            <Button className="mt-3" variant="danger" disabled={busy || conflict || hasNewVersion} onClick={() => act('reject')}>반려 확정</Button>
          </DialogContent>
        </Dialog>
      </div>
    </Card>
    <DialogContent title="최신 초안으로 바꾸시겠습니까?" description="작성 중인 편집 내용이 최신 초안으로 바뀝니다.">
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setConfirm(false)}>편집 내용 유지</Button><Button disabled={busy} onClick={() => { setEditing(newest); setCurrent(null); setConflict(false); setConfirm(false); }}>최신 초안 적용</Button></div>
    </DialogContent>
  </Dialog>;
}
