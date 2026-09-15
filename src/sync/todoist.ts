/**
 * Mirrors tasks into Todoist. Chosen over Google Tasks because Google Tasks
 * lists cannot be shared with another person, so each family member would
 * see only their own — and because a personal API token avoids OAuth.
 *
 * https://api.todoist.com/api/v1/
 */
import type { MirroredTask, SyncTarget } from './types.ts';

const BASE = 'https://api.todoist.com/api/v1';

/** Todoist priority is 1-4 with 4 the most urgent — the reverse of how it
 *  reads in their UI, where 4 shows as P1. */
const PRIORITY: Record<string, number> = { high: 4, medium: 2, low: 1 };

export class TodoistError extends Error {
  status: number;

  constructor(status: number, body: string) {
    super(`Todoist ${status}: ${body.slice(0, 200)}`);
    this.name = 'TodoistError';
    this.status = status;
  }
}

export function todoistTarget(token: string): SyncTarget {
  // One project lookup per isolate, not per task.
  const projects = new Map<string, string>();

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) throw new TodoistError(response.status, await response.text());
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function projectFor(listName: string): Promise<string> {
    const key = listName.toLowerCase();
    const cached = projects.get(key);
    if (cached) return cached;

    const listed = await call<{ results?: { id: string; name: string }[] } | { id: string; name: string }[]>(
      '/projects',
    );
    // The unified API returns some collections wrapped in `results`.
    const all = Array.isArray(listed) ? listed : listed?.results ?? [];
    for (const p of all) projects.set(p.name.toLowerCase(), p.id);

    const found = projects.get(key);
    if (found) return found;

    const created = await call<{ id: string }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: listName }),
    });
    projects.set(key, created.id);
    return created.id;
  }

  /** Todoist has no blocked or needs-clarification state, so the signal is
   *  carried as a label rather than silently dropped. */
  function labelsFor(task: MirroredTask): string[] {
    const labels: string[] = [];
    if (task.assigneeName) labels.push(task.assigneeName.split(/\s+/)[0]!.toLowerCase());
    if (task.waitingOn) labels.push('waiting');
    if (task.state === 'blocked') labels.push('blocked');
    if (task.state === 'needs_clarification') labels.push('needs-info');
    return labels;
  }

  async function body(task: MirroredTask): Promise<Record<string, unknown>> {
    return {
      content: task.title,
      description: [task.waitingOn ? `Waiting on ${task.waitingOn}` : '', task.description ?? '']
        .filter(Boolean)
        .join('\n\n'),
      project_id: await projectFor(task.listName),
      priority: PRIORITY[task.priority] ?? 1,
      labels: labelsFor(task),
      ...(task.dueAt ? { due_date: task.dueAt.slice(0, 10) } : {}),
    };
  }

  return {
    name: 'todoist',

    async create(task) {
      const created = await call<{ id: string }>('/tasks', {
        method: 'POST',
        body: JSON.stringify(await body(task)),
      });
      return created.id;
    },

    async update(externalId, task) {
      await call(`/tasks/${externalId}`, {
        method: 'POST',
        body: JSON.stringify(await body(task)),
      });
    },

    async close(externalId) {
      await call(`/tasks/${externalId}/close`, { method: 'POST' });
    },

    async reopen(externalId) {
      await call(`/tasks/${externalId}/reopen`, { method: 'POST' });
    },
  };
}
