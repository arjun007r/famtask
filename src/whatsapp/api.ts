/** Thin Cloud API client. The only file that knows Meta's wire format. */
export interface WhatsAppApi {
  /** POST to the business phone number's messages edge. */
  send<T>(body: Record<string, unknown>): Promise<T>;
}

/** Meta nests the useful part; this pulls it up so callers can branch on it. */
export class WhatsAppApiError extends Error {
  status: number;
  code: number;
  detail: string;

  constructor(status: number, code: number, detail: string) {
    super(`WhatsApp send failed (${status}/${code}): ${detail}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * "Message undeliverable; more than 24 hours since the last inbound message."
 * Not a fault -- it is the platform's re-engagement rule, and the only correct
 * response is a pre-approved template.
 */
export const OUTSIDE_WINDOW = 131047;

export function isOutsideWindow(err: unknown): boolean {
  return err instanceof WhatsAppApiError && err.code === OUTSIDE_WINDOW;
}

export function createWhatsAppApi(
  token: string,
  phoneNumberId: string,
  version = 'v21.0',
): WhatsAppApi {
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
  return {
    async send<T>(body: Record<string, unknown>): Promise<T> {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
      });
      const payload = (await response.json()) as {
        error?: { code?: number; message?: string; error_data?: { details?: string } };
      };
      if (!response.ok || payload.error) {
        const e = payload.error;
        throw new WhatsAppApiError(
          response.status,
          e?.code ?? response.status,
          e?.error_data?.details ?? e?.message ?? 'unknown error',
        );
      }
      return payload as T;
    },
  };
}

/** Plain body text caps at 4096. Split rather than let Meta reject the lot. */
export function splitForWhatsApp(text: string, limit = 4000): string[] {
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
