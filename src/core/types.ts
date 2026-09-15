export const TASK_STATES = [
  'todo',
  'in_progress',
  'blocked',
  'needs_clarification',
  'done',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type AssigneeKind = 'member' | 'group' | 'unassigned';

export interface Family {
  id: string;
  name: string;
  group_chat_id: string | null;
  created_at: string;
}

export interface FamilyMember {
  id: string;
  family_id: string;
  name: string;
  /** Which messaging channel reaches this person: 'telegram', 'whatsapp', … */
  channel: string;
  channel_user_id: string;
  /** DM conversation id, learned the first time they message the bot. Until
   *  it is set the member cannot receive a digest. */
  channel_chat_id: string | null;
  timezone: string;
  digest_hour: number;
  is_active: number;
  created_at: string;
}

export interface TaskList {
  id: string;
  family_id: string;
  name: string;
  owner_member_id: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface Task {
  id: string;
  family_id: string;
  list_id: string;
  title: string;
  description: string | null;
  created_by: string | null;
  assignee_kind: AssigneeKind;
  assigned_to: string | null;
  /** Someone outside the family the outcome depends on: a contractor, a
   *  school office, a relative. `assigned_to` still names whoever chases it. */
  waiting_on: string | null;
  state: TaskState;
  priority: Priority;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  source_chat_id: string | null;
  source_message_id: string | null;
}

export type TaskEventKind =
  | 'created'
  | 'comment'
  | 'state_change'
  | 'reassigned'
  | 'priority_change'
  | 'edited';

export interface TaskEvent {
  id: string;
  task_id: string;
  actor_member_id: string | null;
  kind: TaskEventKind;
  from_state: TaskState | null;
  to_state: TaskState | null;
  body: string | null;
  created_at: string;
}

/** A task joined with the names the presentation layers need. */
export interface TaskView extends Task {
  list_name: string;
  assignee_name: string | null;
}

export function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v);
}

export function isPriority(v: unknown): v is Priority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
}
