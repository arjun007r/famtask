/** Short, URL- and callback-data-safe ids. crypto.randomUUID exists in
 *  Workers and in Node >= 19. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
