'use client';
import { useRef, useState, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fieldErrors } from '@/lib/api';
import { qk } from '@/lib/hooks';
import type { KbArticle } from '@/lib/types';
import { useAdminApi } from '@/components/admin/shared';
import { SafeMarkdown } from '@/components/safe-markdown';
import { LoadingView, ErrorView, EmptyView } from '@/components/states';
import { Card, PageHeader, Badge, Alert } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea, fieldAria } from '@/components/ui/form-controls';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';

type Form = {id?:string;title:string;body:string;category:string;tags:string;published:boolean};
const blank: Form = {title:'',body:'',category:'',tags:'',published:true};
export default function KbPage() {
  const {slug,base,href,me,domains} = useAdminApi();
  const client = useQueryClient();
  const createButton = useRef<HTMLButtonElement>(null);
  const [opener,setOpener] = useState('create');
  const query = useQuery({queryKey:qk.kb(slug),queryFn:() => api<{items:KbArticle[]}>(`${base}/kb`)});
  const [search,setSearch] = useState('');
  const [form,setForm] = useState<Form | null>(null);
  const [deleting,setDeleting] = useState<KbArticle | null>(null);
  const [pending,setPending] = useState(false);
  const [error,setError] = useState<unknown>(null);
  const [errors,setErrors] = useState<Record<string,string>>({});
  // 저장·삭제 결과 안내(사용자 동작 결과라 live로 읽어 준다)
  const [result,setResult] = useState('');
  const editable = me.data?.user.role === 'tenant_admin';
  function open(f: Form) {setForm(f);setError(null);setErrors({});setResult('');}
  async function save() {
    if (!form || pending) return;
    setPending(true);setError(null);setErrors({});
    const tags = form.tags.split('\n').map(s => s.trim()).filter(Boolean);
    if (tags.length > 20 || tags.some(t => t.length > 40)) {setErrors({tags:'태그는 20개 이하, 각 40자 이하여야 합니다.'});setPending(false);return;}
    try {await api(`${base}/kb${form.id ? `/${form.id}` : ''}`,{method:form.id ? 'PATCH' : 'POST',body:{title:form.title,body:form.body,category:form.category || null,tags,published:form.published}});setResult(form.id ? '문서를 수정했습니다.' : '문서를 만들었습니다.');setForm(null);await client.invalidateQueries({queryKey:qk.kb(slug)});} catch(e) {setError(e);setErrors(fieldErrors(e));} finally {setPending(false);}
  }
  if (!query.data && query.isError) return <ErrorView error={query.error} retry={() => query.refetch()} loginHref={href('/login')} />;
  const items = query.data?.items.filter(a => `${a.title} ${a.body} ${a.category} ${a.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <Dialog open={form !== null} onOpenChange={v => {if (!v && !pending) setForm(null);}}><PageHeader title="KB / FAQ" description={editable ? 'AI와 상담원이 참고할 지식을 관리합니다.' : '등록된 지식을 조회할 수 있습니다. 수정은 관리자에게 요청하세요.'} actions={editable && <EditorTrigger active={opener === 'create'}><Button ref={createButton} onClick={() => {setOpener('create');open({...blank});}}>문서 만들기</Button></EditorTrigger>} /><Field id="kb-search" label="지식 검색"><Input id="kb-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="제목, 본문, 태그 검색" /></Field><div className="mt-5 space-y-3">{result && <Alert tone="success" live>{result}</Alert>}{query.isError && <Alert tone="danger">목록을 갱신하지 못했습니다.<Button variant="outline" onClick={() => query.refetch()}>다시 시도</Button></Alert>}{!query.data ? <LoadingView /> : !items.length ? <EmptyView title="검색 결과가 없습니다" /> : items.map(a => <Card key={a.id} className="min-w-0 space-y-3"><div className="flex flex-wrap gap-2"><Badge>{a.published ? '게시됨' : '비공개'}</Badge>{a.category && <Badge>{a.category}</Badge>}</div><h2 className="break-words text-lg font-semibold">{a.title}</h2><SafeMarkdown allowedDomains={domains}>{a.body}</SafeMarkdown><p className="break-words text-sm text-muted-foreground">{a.tags.join(' · ')}</p>{editable && <div className="flex gap-2"><EditorTrigger active={opener === a.id}><Button variant="outline" onClick={() => {setOpener(a.id);open({...a,category:a.category ?? '',tags:a.tags.join('\n')});}}>수정</Button></EditorTrigger><Dialog open={deleting?.id === a.id} onOpenChange={v => {if (!v && !pending) setDeleting(null);}}><DialogTrigger asChild><Button variant="danger" onClick={() => {setError(null);setDeleting(a);}}>삭제</Button></DialogTrigger><DialogContent title="지식을 삭제하시겠습니까?" description={a.title}>{error != null && <Alert tone="danger">{error instanceof Error ? error.message : '삭제에 실패했습니다.'}</Alert>}<Button variant="danger" disabled={pending} onClick={async () => {if (pending) return;setPending(true);try {await api(`${base}/kb/${a.id}`,{method:'DELETE'});setResult('문서를 삭제했습니다.');setDeleting(null);await client.invalidateQueries({queryKey:qk.kb(slug)});requestAnimationFrame(() => createButton.current?.focus());} catch(e) {setError(e);} finally {setPending(false);}}}>삭제 확정</Button></DialogContent></Dialog></div>}</Card>)}</div><DialogContent title={form?.id ? '지식 수정' : '지식 만들기'}>{form && <form className="space-y-4" onSubmit={e => {e.preventDefault();void save();}}>{error != null && <Alert tone="danger">{error instanceof Error ? error.message : '저장 실패'}</Alert>}{(['title','body','category','tags'] as const).map(key => <Field key={key} id={`kb-${key}`} label={{title:'제목',body:'본문',category:'분류',tags:'태그 (한 줄에 하나)'}[key]} error={errors[key]}>{key === 'body' || key === 'tags' ? <Textarea disabled={pending} {...fieldAria(`kb-${key}`,errors[key])} required={key === 'body'} maxLength={key === 'body' ? 20000 : undefined} value={form[key]} onChange={e => setForm({...form,[key]:e.target.value})} /> : <Input disabled={pending} {...fieldAria(`kb-${key}`,errors[key])} required={key === 'title'} maxLength={key === 'title' ? 200 : 50} value={form[key]} onChange={e => setForm({...form,[key]:e.target.value})} />}</Field>)}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.published} onChange={e => setForm({...form,published:e.target.checked})} />게시</label><Button type="submit" disabled={pending || !form.title.trim() || !form.body.trim()}>저장</Button></form>}</DialogContent></Dialog>;
}

function EditorTrigger({active,children}:{active:boolean;children:ReactElement}) { return active ? <DialogTrigger asChild>{children}</DialogTrigger> : children; }
