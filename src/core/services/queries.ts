import type { Db } from '../db/adapter.ts';
import type { FamilyMember, TaskView } from '../types.ts';
import { renderTaskList } from '../../channel/format.ts';
import type { RenderedMessage } from '../../channel/types.ts';
import { allLists, findListByName, listsVisibleTo } from './lists.ts';
import { listMembers, matchMemberByName } from './registry.ts';
import { queryTasks, rankTasks } from './tasks.ts';

export const PERIODS = { week: 7, month: 30, quarter: 91, year: 365 } as const;
export type Period = keyof typeof PERIODS;

export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && value in PERIODS;
}

/** Rolling days rather than calendar boundaries: "the past month" in a family
 *  chat means the last thirty days, not since the 1st. */
function since(period: Period, now: Date): string {
  return new Date(now.getTime() - PERIODS[period] * 24 * 60 * 60 * 1000).toISOString();
}

export interface Query {
  scope: 'mine' | 'member' | 'list' | 'unclaimed' | 'next' | 'all' | 'waiting' | 'completed';
  /** For scope=completed. Defaults to the past week. */
  period?: Period | null;
  member?: string | null;
  list?: string | null;
  search?: string | null;
  limit?: number;
  now?: Date;
}

/** On-demand answers. Unlike the digest these ignore the 3-list cap: every
 *  list stays fully usable, it just is not pushed daily. */
export async function answerQuery(
  db: Db,
  asker: FamilyMember,
  query: Query,
): Promise<RenderedMessage> {
  const familyId = asker.family_id;
  const limit = query.limit ?? 10;

  switch (query.scope) {
    case 'all': {
      // Every open task in the family, whoever owns it and whatever list it
      // is in. Personal lists of other members are excluded by visibility.
      const visible = await listsVisibleTo(db, asker);
      const tasks = await queryTasks(db, {
        familyId,
        listIds: visible.map((l) => l.id),
        search: query.search ?? undefined,
      });
      return renderTaskList('Everything open:', rankTasks(tasks).slice(0, query.limit ?? 25));
    }
    case 'completed': {
      const period = PERIODS[query.period ?? 'week'] ? (query.period ?? 'week') : 'week';
      const visible = await listsVisibleTo(db, asker);
      const done = await queryTasks(db, {
        familyId,
        listIds: visible.map((l) => l.id),
        closedAfter: since(period, query.now ?? new Date()),
        search: query.search ?? undefined,
        limit: 50,
      });
      if (done.length === 0) return { text: `Nothing finished in the past ${period}.` };
      const heading = `${done.length} finished in the past ${period}:`;
      return renderTaskList(heading, done.slice(0, Math.max(limit, 20)), query.now);
    }
    case 'waiting': {
      // The GTD "waiting for" list: work the family cannot finish itself,
      // which is exactly the work that gets silently dropped.
      const visible = await listsVisibleTo(db, asker);
      const tasks = await queryTasks(db, {
        familyId,
        listIds: visible.map((l) => l.id),
        waitingOnly: true,
        search: query.search ?? undefined,
      });
      if (tasks.length === 0) return { text: 'Not waiting on anyone outside the family.' };
      return renderTaskList('Waiting on someone else:', rankTasks(tasks).slice(0, limit));
    }
    case 'next': {
      const tasks = await rankedFor(db, asker, asker.id, query.search);
      const top = tasks.slice(0, 1);
      if (top.length === 0) return { text: "Nothing on your plate. Enjoy it." };
      return renderTaskList('Next up:', top);
    }
    case 'mine': {
      const tasks = await rankedFor(db, asker, asker.id, query.search);
      return renderTaskList('Your tasks:', tasks.slice(0, limit));
    }
    case 'member': {
      const members = await listMembers(db, familyId);
      const target = query.member ? matchMemberByName(members, query.member) : null;
      if (!target) {
        return { text: `I don't know who "${query.member ?? ''}" is. Family: ${members.map((m) => m.name).join(', ')}.` };
      }
      const tasks = await rankedFor(db, asker, target.id, query.search);
      return renderTaskList(`${target.name}'s tasks:`, tasks.slice(0, limit));
    }
    case 'list': {
      if (!query.list) {
        const lists = await allLists(db, familyId);
        return { text: `Lists: ${lists.map((l) => l.name).join(', ') || 'none yet'}` };
      }
      const list = await findListByName(db, familyId, query.list);
      if (!list) {
        const lists = await allLists(db, familyId);
        return { text: `No list called "${query.list}". Lists: ${lists.map((l) => l.name).join(', ') || 'none yet'}` };
      }
      const tasks = await queryTasks(db, { familyId, listIds: [list.id], search: query.search ?? undefined });
      return renderTaskList(`${list.name}:`, rankTasks(tasks).slice(0, limit));
    }
    case 'unclaimed': {
      const tasks = await queryTasks(db, { familyId, unclaimedOnly: true, search: query.search ?? undefined });
      return renderTaskList('Up for grabs:', rankTasks(tasks).slice(0, limit));
    }
  }
}

async function rankedFor(
  db: Db,
  asker: FamilyMember,
  assignedTo: string,
  search?: string | null,
): Promise<TaskView[]> {
  const visible = await listsVisibleTo(db, asker);
  const tasks = await queryTasks(db, {
    familyId: asker.family_id,
    listIds: visible.map((l) => l.id),
    assignedTo,
    search: search ?? undefined,
  });
  return rankTasks(tasks);
}
