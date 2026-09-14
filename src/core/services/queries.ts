import type { Db } from '../db/adapter.ts';
import type { FamilyMember, TaskView } from '../types.ts';
import { renderTaskList } from '../../channel/format.ts';
import type { RenderedMessage } from '../../channel/types.ts';
import { allLists, findListByName, listsVisibleTo } from './lists.ts';
import { listMembers, matchMemberByName } from './registry.ts';
import { queryTasks, rankTasks } from './tasks.ts';

export interface Query {
  scope: 'mine' | 'member' | 'list' | 'unclaimed' | 'next' | 'all';
  member?: string | null;
  list?: string | null;
  search?: string | null;
  limit?: number;
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
      return renderTaskList('Everything open:', rankTasks(tasks).slice(0, query.limit ?? 25), {
        showAssignee: true,
      });
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
      return renderTaskList(`${list.name}:`, rankTasks(tasks).slice(0, limit), {
        showAssignee: true,
      });
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
