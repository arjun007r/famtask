/**
 * The mirror boundary. famtask stays the source of truth; a target is a
 * read-only audience that gets told what happened. Nothing syncs back — a
 * task completed in Todoist stays open here, deliberately, because two
 * writers over one row needs conflict rules this does not have.
 */
import type { Priority, TaskState } from '../core/types.ts';

export interface MirroredTask {
  id: string;
  title: string;
  description: string | null;
  listName: string;
  assigneeName: string | null;
  /** Somebody outside the family the task hangs on. */
  waitingOn: string | null;
  state: TaskState;
  /** Already escalated by the due date, so the mirror shows what we show. */
  priority: Priority;
  dueAt: string | null;
  closed: boolean;
}

export interface SyncTarget {
  name: string;
  /** Returns the external id to remember. */
  create(task: MirroredTask): Promise<string>;
  update(externalId: string, task: MirroredTask): Promise<void>;
  close(externalId: string): Promise<void>;
  reopen(externalId: string): Promise<void>;
}
