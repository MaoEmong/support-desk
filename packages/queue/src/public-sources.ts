export interface PublicSource {
  id: string;
  title: string;
  excerpt?: string;
  url?: string;
}

/** Public-message DTO allowlist. AI sources use kbArticleId; adapters may already
 * supply public id. The server/AI boundary must validate tenant ownership and
 * sanitize any url against allowed domains before calling this projection.
 * Never derive urls from rawURL/raw metadata or spread original source objects. */
export function projectPublicSources(value: unknown): PublicSource[] {
  if (!Array.isArray(value)) return [];
  const projected: PublicSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const id = typeof source.id === 'string' && source.id.length ? source.id : source.kbArticleId;
    if (typeof id !== 'string' || !id.length || typeof source.title !== 'string') continue;
    const dto: PublicSource = { id, title: source.title };
    if (typeof source.excerpt === 'string') dto.excerpt = source.excerpt;
    if (typeof source.url === 'string') dto.url = source.url;
    projected.push(dto);
  }
  return projected;
}
