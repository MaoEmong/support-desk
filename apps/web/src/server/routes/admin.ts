import { randomUUID } from 'node:crypto';
import { AIConfigError, assertCategoryIdsUnchanged } from '@support/ai';
import type { TenantSettings } from '../domain';
import { toAdminSettings, toKb } from '../dto';
import { ApiError } from '../errors';
import { readBody, requireActor } from '../http/context';
import type { Router } from '../http/router';
import { assertCan } from '../policy';
import type { SettingsPatch } from '../repo/types';
import { idParam, kbCreateBody, kbPatchBody, settingsPatchBody } from '../validation';

/**
 * 카테고리 규칙: id 집합은 바꿀 수 없다(라벨·키워드·설명만 수정). 금지·fallback은 categories 안의 id여야 한다.
 * id를 바꾸면 기존 티켓 분류·금지 정책이 끊기므로 추가·삭제·변경 모두 거부한다.
 */
function assertCategoryRules(current: TenantSettings, patch: SettingsPatch) {
  const issues: { path: string; message: string }[] = [];
  const ids = (patch.categories ?? current.categories).map((c) => c.id);
  if (patch.categories) {
    // id 불변 규칙은 AI 패키지 한 곳(assertCategoryIdsUnchanged)에서
    try {
      assertCategoryIdsUnchanged(current.categories, patch.categories);
    } catch (e) {
      if (!(e instanceof AIConfigError)) throw e;
      issues.push({ path: 'categories', message: e.message });
    }
  }
  const idSet = new Set(ids);
  (patch.forbiddenCategories ?? current.forbiddenCategories).forEach((id, i) => {
    if (!idSet.has(id)) issues.push({ path: `forbiddenCategories.${i}`, message: `unknown category: ${id}` });
  });
  const fallback = patch.fallbackCategory ?? current.fallbackCategory;
  if (!idSet.has(fallback)) issues.push({ path: 'fallbackCategory', message: `unknown category: ${fallback}` });
  if (issues.length) throw new ApiError('VALIDATION_FAILED', undefined, issues);
}

/** tenant_admin 전용: 테넌트 설정(브랜딩·AI 정책)과 KB CRUD. KB 조회는 상담원도 가능. */
export function registerAdminRoutes(r: Router) {
  r.add({
    method: 'GET',
    pattern: '/t/:slug/admin/settings',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'settings:read');
      const s = await ctx.deps.repo.getSettings(actor.tenantId!);
      if (!s) throw new ApiError('NOT_FOUND');
      return toAdminSettings(s);
    },
  });

  r.add({
    method: 'PATCH',
    pattern: '/t/:slug/admin/settings',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'settings:write');
      const patch = await readBody(ctx, settingsPatchBody);
      const tenantId = actor.tenantId!;
      const s = await ctx.deps.repo.tx(async (tx) => {
        const current = await tx.getSettings(tenantId);
        if (!current) throw new ApiError('NOT_FOUND');
        assertCategoryRules(current, patch);
        const updated = await tx.updateSettings(tenantId, patch, ctx.now);
        if (!updated) throw new ApiError('NOT_FOUND');
        await tx.audit(
          { tenantId, actorId: actor.userId, action: 'settings.update', targetType: 'tenant_settings', targetId: tenantId, meta: { fields: Object.keys(patch) } },
          ctx.now,
        );
        return updated;
      });
      return toAdminSettings(s);
    },
  });

  r.add({
    method: 'GET',
    pattern: '/t/:slug/admin/kb',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'kb:read');
      const items = await ctx.deps.repo.listKb(actor.tenantId!);
      return { items: items.map(toKb) };
    },
  });

  r.add({
    method: 'GET',
    pattern: '/t/:slug/admin/kb/:id',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'kb:read');
      const a = await ctx.deps.repo.getKb(actor.tenantId!, idParam(ctx, 'id'));
      if (!a) throw new ApiError('NOT_FOUND');
      return toKb(a);
    },
  });

  r.add({
    method: 'POST',
    pattern: '/t/:slug/admin/kb',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'kb:write');
      const body = await readBody(ctx, kbCreateBody);
      const tenantId = actor.tenantId!;
      const a = await ctx.deps.repo.tx(async (tx) => {
        const a = await tx.createKb(
          {
            id: randomUUID(),
            tenantId,
            title: body.title,
            question: body.question || body.title, // 0006 backfill과 같은 정책: 비우면 제목
            body: body.body,
            category: body.category ?? null,
            tags: body.tags ?? [],
            published: body.published ?? true,
          },
          ctx.now,
        );
        await tx.audit({ tenantId, actorId: actor.userId, action: 'kb.create', targetType: 'kb_article', targetId: a.id }, ctx.now);
        return a;
      });
      ctx.deps.kbChanged?.(tenantId);
      return Response.json(toKb(a), { status: 201 });
    },
  });

  r.add({
    method: 'PATCH',
    pattern: '/t/:slug/admin/kb/:id',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'kb:write');
      const id = idParam(ctx, 'id');
      const patch = await readBody(ctx, kbPatchBody);
      const tenantId = actor.tenantId!;
      const a = await ctx.deps.repo.tx(async (tx) => {
        const a = await tx.updateKb(tenantId, id, patch, ctx.now);
        if (!a) throw new ApiError('NOT_FOUND');
        await tx.audit({ tenantId, actorId: actor.userId, action: 'kb.update', targetType: 'kb_article', targetId: id }, ctx.now);
        return a;
      });
      ctx.deps.kbChanged?.(tenantId);
      return toKb(a);
    },
  });

  r.add({
    method: 'DELETE',
    pattern: '/t/:slug/admin/kb/:id',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'kb:write');
      const id = idParam(ctx, 'id');
      const tenantId = actor.tenantId!;
      await ctx.deps.repo.tx(async (tx) => {
        if (!(await tx.deleteKb(tenantId, id))) throw new ApiError('NOT_FOUND');
        await tx.audit({ tenantId, actorId: actor.userId, action: 'kb.delete', targetType: 'kb_article', targetId: id }, ctx.now);
      });
      ctx.deps.kbChanged?.(tenantId);
      return new Response(null, { status: 204 });
    },
  });
}
