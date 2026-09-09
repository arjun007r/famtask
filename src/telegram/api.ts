/** Thin Bot API client. The only file that knows Telegram's wire format. */
export interface TelegramApi {
  call<T>(method: string, body: Record<string, unknown>): Promise<T>;
}

export class TelegramApiError extends Error {
  method: string;
  code: number;
  description: string;

  constructor(method: string, code: number, description: string) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
  }
}

export function createTelegramApi(token: string): TelegramApi {
  return {
    async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        result?: T;
        error_code?: number;
        description?: string;
      };
      if (!payload.ok) {
        throw new TelegramApiError(
          method,
          payload.error_code ?? response.status,
          payload.description ?? 'unknown error',
        );
      }
      return payload.result as T;
    },
  };
}

/** Telegram truncates silently past 4096 characters; split instead. */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit);
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
