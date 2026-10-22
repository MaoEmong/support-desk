'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, fieldErrors, isApiError } from '@/lib/api';
import { qk, useMe } from '@/lib/hooks';
import type { Agent } from '@/lib/types';
import { roleLabel } from '@/lib/labels';
import { RequireRole, ADMIN_ROLES } from '@/components/auth-guard';
import { useTenant } from '@/components/tenant-context';
import { LoadingView, ErrorView, EmptyView } from '@/components/states';
import { Card, PageHeader, Badge, Alert } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Field, Input, fieldAria } from '@/components/ui/form-controls';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { AGENT_RESPONSE_KEYS, type AgentCreationResponse } from '@/components/admin/shared';

const createSchema = z.object({name:z.string().trim().min(1,'이름을 입력하세요.').max(50),email:z.string().trim().toLowerCase().email('올바른 이메일을 입력하세요.').max(254)});
export default function AgentsPage() {return <RequireRole roles={ADMIN_ROLES}>{() => <AgentManagement />}</RequireRole>;}

function AgentManagement() {
  const {slug,href} = useTenant();
  const me = useMe(slug);
  const client = useQueryClient();
  const base = '/t/'+encodeURIComponent(slug)+'/admin/agents';
  const query = useQuery({queryKey:qk.agents(slug),queryFn:() => api<{items:Agent[]}>(base)});
  const [createOpen,setCreateOpen] = useState(false);
  const [name,setName] = useState('');
  const [email,setEmail] = useState('');
  const [password,setPassword] = useState<string | null>(null);
  const [copied,setCopied] = useState(false);
  const [copyError,setCopyError] = useState(false);
  const [pending,setPending] = useState(false);
  const lock = useRef(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const [error,setError] = useState<string | null>(null);
  const [errors,setErrors] = useState<Record<string,string>>({});
  const [disabling,setDisabling] = useState<string | null>(null);
  const [notice,setNotice] = useState('');
  function closeCreate(open:boolean) {
    if (pending) return;
    setCreateOpen(open);
    if (!open) {setPassword(null);setName('');setEmail('');setCopied(false);setCopyError(false);setError(null);setErrors({});}
  }
  async function create() {
    if (lock.current) return;
    setErrors({});setError(null);
    const parsed=createSchema.safeParse({name,email});
    if (!parsed.success) {const next:Record<string,string>={};for(const issue of parsed.error.issues) next[String(issue.path[0])]=issue.message;setErrors(next);return;}
    lock.current=true;setPending(true);
    try {
      // Never store the creation response in React Query: it contains a one-time secret.
      const result=await api<AgentCreationResponse>(base,{method:'POST',body:parsed.data});
      const secret=result[AGENT_RESPONSE_KEYS.temporaryPassword];
      setPassword(secret ?? null);
      setName('');setEmail('');
      if (!secret) {setError('상담원은 생성되었지만 임시 비밀번호가 응답에 없습니다. 관리자에게 문의하세요.');}
      else setNotice('상담원을 추가했습니다.');
      await client.invalidateQueries({queryKey:qk.agents(slug)});
    } catch(e) {
      if (isApiError(e) && String(e.code)==='EMAIL_TAKEN') setErrors({email:'이미 사용 중인 이메일입니다.'});
      else {setErrors(fieldErrors(e));setError(e instanceof Error ? e.message : '상담원을 추가하지 못했습니다.');}
    } finally {lock.current=false;setPending(false);}
  }
  async function disable(agent:Agent) {
    if (lock.current) return;
    lock.current=true;setPending(true);setError(null);
    try {await api(base+'/'+encodeURIComponent(agent.id),{method:'PATCH',body:{status:'disabled'}});setDisabling(null);setNotice(agent.name+' 상담원을 비활성화했습니다.');await client.invalidateQueries({queryKey:qk.agents(slug)});requestAnimationFrame(() => createButton.current?.focus());}
    catch(e) {setError(e instanceof Error ? e.message : '비활성화하지 못했습니다.');}
    finally {lock.current=false;setPending(false);}
  }
  if (!query.data && query.isError) return <ErrorView error={query.error} retry={() => query.refetch()} loginHref={href('/login')} />;
  return <><PageHeader title="상담원 관리" description="상담원을 추가하고 계정 상태를 관리합니다." actions={<Dialog open={createOpen} onOpenChange={closeCreate}><DialogTrigger asChild><Button ref={createButton} disabled={pending} onClick={() => {setError(null);setErrors({});}}>상담원 추가</Button></DialogTrigger><DialogContent title={password ? '임시 비밀번호' : '상담원 추가'} description={password ? '닫으면 다시 볼 수 없습니다. 상담원에게 안전하게 전달하세요.' : '상담원 이름과 이메일을 입력하세요.'}>{password ? <div className="space-y-3"><Field id="agent-temporary-password" label="임시 비밀번호"><Input id="agent-temporary-password" readOnly autoComplete="off" value={password} /></Field><Button onClick={async () => {try {await navigator.clipboard.writeText(password);setCopied(true);setCopyError(false);} catch {setCopyError(true);}}}>비밀번호 복사</Button>{copied && <Alert tone="success" live>복사했습니다.</Alert>}{copyError && <Alert tone="warning" live>복사하지 못했습니다. 비밀번호를 직접 선택해 복사하세요.</Alert>}<Button variant="outline" onClick={() => closeCreate(false)}>확인 후 닫기</Button></div> : <form className="space-y-4" onSubmit={e => {e.preventDefault();void create();}}>{error && <Alert tone="danger">{error}</Alert>}<Field id="agent-name" label="이름" error={errors.name}><Input {...fieldAria('agent-name',errors.name)} required maxLength={50} disabled={pending} value={name} onChange={e => setName(e.target.value)} /></Field><Field id="agent-email" label="이메일" error={errors.email}><Input {...fieldAria('agent-email',errors.email)} type="email" required maxLength={254} disabled={pending} value={email} onChange={e => setEmail(e.target.value)} /></Field><Button type="submit" disabled={pending}>상담원 생성</Button></form>}</DialogContent></Dialog>} />
    {notice && <Alert tone="success" live>{notice}</Alert>}
    {query.isError && <Alert tone="danger">목록을 갱신하지 못했습니다.<Button variant="outline" onClick={() => query.refetch()}>다시 시도</Button></Alert>}
    {!query.data ? <LoadingView /> : !query.data.items.length ? <EmptyView title="상담원이 없습니다" /> : <div className="grid gap-3 sm:grid-cols-2">{query.data.items.map(a => <Card key={a.id} className="min-w-0 space-y-3"><h2 className="break-words font-semibold">{a.name}</h2><p className="break-all text-sm text-muted-foreground">{a.email}</p><div className="flex flex-wrap gap-2"><Badge>{roleLabel[a.role]}</Badge><Badge tone={a.status==='disabled' ? 'danger' : 'neutral'}>{a.status==='disabled' ? '비활성' : a.status==='active' ? '활성' : '상태 확인 대기'}</Badge></div><p className="text-sm">담당 중인 열린 티켓 {a.assignedOpenCount === undefined ? '확인 불가' : a.assignedOpenCount+'건'}</p>{a.role==='agent' && a.id!==me.data?.user.id && a.status!=='disabled' && <Dialog open={disabling===a.id} onOpenChange={v => {if(!pending) {setDisabling(v ? a.id : null);setError(null);}}}><DialogTrigger asChild><Button variant="danger" disabled={pending || a.assignedOpenCount===undefined}>비활성화</Button></DialogTrigger><DialogContent title="상담원을 비활성화하시겠습니까?" description={a.name+' · 담당 중인 열린 티켓 '+(a.assignedOpenCount ?? 0)+'건'}><p className="mb-3 text-sm">이 상담원에게 새 티켓을 배정할 수 없게 됩니다. 기존 담당 문의도 확인하세요.</p>{error && <Alert tone="danger">{error}</Alert>}<Button variant="danger" disabled={pending} onClick={() => disable(a)}>비활성화 확정</Button></DialogContent></Dialog>}</Card>)}</div>}
  </>;
}
