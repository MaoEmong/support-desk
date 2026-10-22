'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { CategoryDefSchema } from '@support/ai/contracts';
import { api, fieldErrors } from '@/lib/api';
import { qk } from '@/lib/hooks';
import type { AdminSettings } from '@/lib/types';
import { RequireRole, ADMIN_ROLES } from '@/components/auth-guard';
import { useTenant } from '@/components/tenant-context';
import { LoadingView, ErrorView } from '@/components/states';
import { Card, PageHeader, Alert } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea, fieldAria } from '@/components/ui/form-controls';

const text = (max:number) => z.string().trim().min(1).max(max);
const domain = z.string().trim().toLowerCase().max(253).regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, '올바른 도메인을 입력하세요.');
// Adapt the shared zod/v4 category schema to this form's zod/v3 schema.
const categoryDef = z.unknown().transform((value, ctx) => {
  const result = CategoryDefSchema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) ctx.addIssue({code:'custom',path:issue.path.map(String),message:issue.message});
    return z.NEVER;
  }
  return result.data;
});
const schema = z.object({
  displayName:text(80),logoUrl:z.string().max(500).refine(u => u.startsWith('https://') || u.startsWith('/'),'https 또는 상대 경로만 허용').nullable(),
  primaryColor:z.string().regex(/^#[0-9a-fA-F]{6}$/,'#rrggbb 형식으로 입력하세요.').nullable(),chatbotName:text(40),aiSystemPrompt:z.string().max(4000),aiThreshold:z.number().min(0).max(1),forbiddenCategories:z.array(text(50)).max(50),approvalMode:z.boolean(),categories:z.array(categoryDef).min(1).max(50),fallbackCategory:text(40).default('other'),allowedLinkDomains:z.array(domain).max(20),
}).strict().superRefine((value,ctx) => {
  const ids = new Set(value.categories.map(c => c.id));
  if (ids.size !== value.categories.length) ctx.addIssue({code:'custom',path:['categories'],message:'카테고리 ID가 중복됩니다.'});
  for (const id of value.forbiddenCategories) if (!ids.has(id)) ctx.addIssue({code:'custom',path:['forbiddenCategories'],message:'등록된 카테고리만 선택하세요.'});
  if (value.fallbackCategory !== undefined && !ids.has(value.fallbackCategory)) ctx.addIssue({code:'custom',path:['fallbackCategory'],message:'등록된 카테고리만 선택하세요.'});
});

export default function SettingsPage() { return <RequireRole roles={ADMIN_ROLES}>{() => <SettingsContent />}</RequireRole>; }
function SettingsContent() {
  const {slug,href} = useTenant();
  const query = useQuery({queryKey:qk.adminSettings(slug),queryFn:() => api<AdminSettings>(`/t/${encodeURIComponent(slug)}/admin/settings`)});
  if (query.isPending) return <LoadingView />;
  if (query.isError) return <ErrorView error={query.error} retry={() => query.refetch()} loginHref={href('/login')} />;
  return <SettingsForm initial={query.data} slug={slug} />;
}
function SettingsForm({initial,slug}:{initial:AdminSettings;slug:string}) {
  const client = useQueryClient();
  const modernCategories = (initial.categories ?? []).every(c => typeof c !== 'string');
  const [form,setForm] = useState({...initial,categories:(initial.categories ?? []).map(c => typeof c === 'string' ? {id:c,label:c,keywords:[]} : c)});
  const [allowedDomains,setAllowedDomains] = useState(initial.allowedLinkDomains.join('\n'));
  const [keywords,setKeywords] = useState((initial.categories ?? []).map(c => typeof c === 'string' ? '' : c.keywords.join('\n')));
  const [errors,setErrors] = useState<Record<string,string>>({});
  const [error,setError] = useState<unknown>(null);
  const [pending,setPending] = useState(false);
  const [saved,setSaved] = useState(false);
  async function save() {
    setErrors({});setError(null);setSaved(false);
    const values = {displayName:form.displayName,logoUrl:form.logoUrl,primaryColor:form.primaryColor,chatbotName:form.chatbotName,aiSystemPrompt:form.aiSystemPrompt,aiThreshold:form.aiThreshold,approvalMode:form.approvalMode};
    const result = schema.safeParse({...values,logoUrl:form.logoUrl || null,primaryColor:form.primaryColor || null,categories:form.categories.map((c,i) => ({...c,keywords:keywords[i].split('\n').map(v => v.trim()).filter(Boolean)})),forbiddenCategories:form.forbiddenCategories,fallbackCategory:form.fallbackCategory,allowedLinkDomains:allowedDomains.split('\n').map(v => v.trim()).filter(Boolean)});
    if (!result.success) {const next:Record<string,string> = {};for (const issue of result.error.issues) next[String(issue.path[0])] = issue.message;setErrors(next);return;}
    setPending(true);
    try {const updated = await api<AdminSettings>(`/t/${encodeURIComponent(slug)}/admin/settings`,{method:'PATCH',body:modernCategories ? result.data : { ...values,logoUrl:form.logoUrl || null,primaryColor:form.primaryColor || null,forbiddenCategories:form.forbiddenCategories,allowedLinkDomains:result.data.allowedLinkDomains }});client.setQueryData(qk.adminSettings(slug),updated);await client.invalidateQueries({queryKey:qk.settings(slug)});setSaved(true);} catch(e) {setError(e);setErrors(Object.fromEntries(Object.entries(fieldErrors(e)).map(([key,value]) => [key.split('.')[0],value])));} finally {setPending(false);}
  }
  function stringField(key:'displayName'|'logoUrl'|'primaryColor'|'chatbotName'|'aiSystemPrompt',label:string,max:number) {return <Field id={`setting-${key}`} label={label} error={errors[key]}>{key === 'aiSystemPrompt' ? <Textarea {...fieldAria(`setting-${key}`,errors[key])} maxLength={max} value={form[key] ?? ''} onChange={e => setForm({...form,[key]:e.target.value})} /> : <Input {...fieldAria(`setting-${key}`,errors[key])} maxLength={max} value={form[key] ?? ''} onChange={e => setForm({...form,[key]:e.target.value})} />}</Field>;}
  return <><PageHeader title="테넌트 설정" description="브랜딩과 AI 답변 정책을 관리합니다." /><form className="space-y-5" onSubmit={e => {e.preventDefault();void save();}}>{saved && <Alert tone="success" live>설정을 저장했습니다.</Alert>}{error != null && <Alert tone="danger">{error instanceof Error ? error.message : '설정 저장에 실패했습니다.'}<Button variant="outline" disabled={pending} onClick={() => void save()}>다시 저장</Button></Alert>}<Card className="space-y-4"><h2 className="text-lg font-semibold">브랜딩</h2>{stringField('displayName','표시 이름',80)}{stringField('logoUrl','로고 URL (https 또는 / 경로)',500)}<div className="flex items-end gap-3"><div className="min-w-0 flex-1">{stringField('primaryColor','브랜드 색상 (#rrggbb)',7)}</div><input type="color" aria-label="브랜드 색상 선택" className="h-10 w-12 shrink-0" value={/^#[0-9a-fA-F]{6}$/.test(form.primaryColor ?? '') ? form.primaryColor! : '#2563eb'} onChange={e => setForm({...form,primaryColor:e.target.value})} /></div>{stringField('chatbotName','챗봇 이름',40)}</Card><Card className="space-y-4"><h2 className="text-lg font-semibold">AI 설정</h2>{stringField('aiSystemPrompt','AI 시스템 프롬프트 (최대 4,000자)',4000)}<Field id="setting-threshold" label="자동답변 신뢰도 임계값 (0~1)" error={errors.aiThreshold}><Input {...fieldAria('setting-threshold',errors.aiThreshold)} type="number" min={0} max={1} step={0.01} value={Number.isNaN(form.aiThreshold) ? '' : form.aiThreshold} onChange={e => setForm({...form,aiThreshold:e.target.valueAsNumber})} /><input className="w-full" aria-label="자동답변 임계값 조절" type="range" min={0} max={1} step={0.01} value={Number.isNaN(form.aiThreshold) ? 0 : form.aiThreshold} onChange={e => setForm({...form,aiThreshold:Number(e.target.value)})} /></Field><section className="space-y-4" aria-label="카테고리 설정"><h3 className="font-semibold">문의 카테고리</h3>{!modernCategories && <Alert tone="warning">카테고리 객체 설정은 백엔드 반영 대기 중입니다. 현재 ID 목록은 읽기 전용으로 표시합니다.</Alert>}<p className="text-sm text-muted-foreground">ID는 변경할 수 없습니다. 카테고리 추가·삭제는 서버 정책 확인 전까지 제한됩니다.</p>{errors.categories && <p role="alert" className="text-sm text-danger">{errors.categories}</p>}{form.categories.map((c,i) => <div key={c.id} className="space-y-3 rounded border border-border p-3"><Field id={`category-id-${i}`} label="카테고리 ID"><Input id={`category-id-${i}`} readOnly value={c.id} /></Field><Field id={`category-label-${i}`} label="표시 이름"><Input id={`category-label-${i}`} required maxLength={40} disabled={pending || !modernCategories} value={c.label} onChange={e => setForm({...form,categories:form.categories.map((row,j) => j === i ? {...row,label:e.target.value} : row)})} /></Field><Field id={`category-keywords-${i}`} label="키워드 (한 줄에 하나, 최대 80개 · 각 40자)"><Textarea id={`category-keywords-${i}`} disabled={pending || !modernCategories} value={keywords[i]} onChange={e => setKeywords(keywords.map((v,j) => j === i ? e.target.value : v))} /></Field></div>)}<fieldset disabled={pending || !modernCategories} className="space-y-2"><legend className="mb-2 text-sm font-medium">자동답변 금지 카테고리</legend>{form.categories.map(c => <label key={c.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.forbiddenCategories.includes(c.id)} onChange={e => setForm({...form,forbiddenCategories:e.target.checked ? [...form.forbiddenCategories,c.id] : form.forbiddenCategories.filter(id => id !== c.id)})} />{c.label}</label>)}{errors.forbiddenCategories && <p role="alert" className="text-sm text-danger">{errors.forbiddenCategories}</p>}</fieldset><Field id="fallback-category" label="분류 실패 시 카테고리" error={errors.fallbackCategory}><Select {...fieldAria('fallback-category',errors.fallbackCategory)} disabled={pending || !modernCategories} value={form.fallbackCategory ?? ''} onChange={e => setForm({...form,fallbackCategory:e.target.value})}><option value="" disabled>카테고리를 선택하세요</option>{form.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field><Field id="auto-answer-limit" label="티켓별 자동답변 횟수"><Input id="auto-answer-limit" readOnly value="1회 (고정)" /></Field></section><Field id="allowed-domains" label="허용 링크 도메인" hint="한 줄에 하나씩, 최대 20개 입력하세요." error={errors.allowedLinkDomains}><Textarea {...fieldAria('allowed-domains',errors.allowedLinkDomains,true)} value={allowedDomains} onChange={e => setAllowedDomains(e.target.value)} /></Field><label className="flex items-center gap-3 text-sm"><input type="checkbox" role="switch" checked={form.approvalMode} onChange={e => setForm({...form,approvalMode:e.target.checked})} />모든 AI 답변을 상담원 승인 후 발송</label></Card><Button type="submit" disabled={pending}>{pending ? '저장 중…' : '설정 저장'}</Button></form></>;
}
