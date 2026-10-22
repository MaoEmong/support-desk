/**
 * 시드 데이터 로더 (packages/ai/data).
 * 백엔드 시드(packages/db)는 loadSeedBundle() 결과를 그대로 DB 에 넣으면 된다. 형식은 README 참고.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoCase, DemoFile, EvalFile, KbSeedFile, TenantSettingsSeedFile } from './contracts';
import { DemoFileSchema, EvalFileSchema, KbSeedFileSchema, TenantSettingsSeedFileSchema } from './contracts';
import type { KbArticle } from './kb/search';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function listTenantSlugs(dataDir = DATA_DIR): string[] {
  const dir = join(dataDir, 'tenants');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function loadTenantSettings(slug: string, dataDir = DATA_DIR): TenantSettingsSeedFile {
  return TenantSettingsSeedFileSchema.parse(readJson(join(dataDir, 'tenants', slug, 'settings.json')));
}

export function loadTenantKb(slug: string, dataDir = DATA_DIR): KbSeedFile {
  const file = KbSeedFileSchema.parse(readJson(join(dataDir, 'tenants', slug, 'kb.json')));
  if (file.tenantSlug !== slug) throw new Error(`kb.json tenantSlug(${file.tenantSlug}) ≠ 폴더(${slug})`);
  return file;
}

export function loadEvalSet(slug: string, dataDir = DATA_DIR): EvalFile | null {
  const path = join(dataDir, 'eval', `${slug}.json`);
  if (!existsSync(path)) return null;
  return EvalFileSchema.parse(readJson(path));
}

/** 시연 문장(data/demo/{slug}.json). 없으면 null. */
export function loadDemoSet(slug: string, dataDir = DATA_DIR): DemoFile | null {
  const path = join(dataDir, 'demo', `${slug}.json`);
  if (!existsSync(path)) return null;
  const file = DemoFileSchema.parse(readJson(path));
  if (file.tenantSlug !== slug) throw new Error(`demo/${slug}.json tenantSlug(${file.tenantSlug}) ≠ 파일명(${slug})`);
  return file;
}

/** 모든 테넌트의 시연 문장. 카테고리가 테넌트 설정에 없으면 예외. */
export function loadDemoBundle(dataDir = DATA_DIR): DemoFile[] {
  return listTenantSlugs(dataDir).flatMap((slug) => {
    const demo = loadDemoSet(slug, dataDir);
    if (!demo) return [];
    const ids = new Set(loadTenantSettings(slug, dataDir).settings.categories.map((c) => c.id));
    const bad = demo.cases.filter((c) => !ids.has(c.expected.category)).map((c) => c.key);
    if (bad.length) throw new Error(`${slug}: 설정에 없는 카테고리를 기대하는 시연 문장: ${bad.join(', ')}`);
    return [demo];
  });
}

/** key 로 시연 문장 하나를 찾는다(E2E 용). 없으면 예외. */
export function getDemoCase(slug: string, key: string, dataDir = DATA_DIR): DemoCase {
  const found = loadDemoSet(slug, dataDir)?.cases.find((c) => c.key === key);
  if (!found) throw new Error(`시연 문장 없음: ${slug}/${key}`);
  return found;
}

export interface TenantSeed {
  slug: string;
  displayName: string;
  settings: TenantSettingsSeedFile['settings'];
  kb: KbSeedFile['articles'];
}

/** 모든 테넌트의 설정 + KB 를 검증해서 돌려준다. KB 카테고리가 설정에 없으면 예외. */
export function loadSeedBundle(dataDir = DATA_DIR): TenantSeed[] {
  return listTenantSlugs(dataDir).map((slug) => {
    const s = loadTenantSettings(slug, dataDir);
    const kb = loadTenantKb(slug, dataDir);
    const ids = new Set(s.settings.categories.map((c) => c.id));
    const bad = kb.articles.filter((a) => !ids.has(a.category)).map((a) => a.id);
    if (bad.length) throw new Error(`${slug}: 설정에 없는 카테고리를 쓰는 KB 문서: ${bad.join(', ')}`);
    return { slug, displayName: s.displayName, settings: s.settings, kb: kb.articles };
  });
}

/** 시드 KB 를 파이프라인 KbArticle 로 변환(tenantId 는 DB 의 실제 id 를 넣는다). */
export function toKbArticles(tenantId: string, articles: KbSeedFile['articles']): KbArticle[] {
  return articles.map((a) => ({
    id: a.id,
    tenantId,
    title: a.title,
    question: a.question,
    body: a.answer,
    category: a.category,
    tags: a.tags,
  }));
}
