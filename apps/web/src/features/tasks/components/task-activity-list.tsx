'use client';

import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ClockIcon } from '@phosphor-icons/react/dist/ssr';
import { formatRelativeTime } from '@/lib/format';
import { useTaskActivity } from '../hooks';

export function TaskActivityList({ taskId }: { taskId: string }) {
  const { data, isPending, isError } = useTaskActivity(taskId);
  if (isPending) return <Skeleton className="h-16 w-full" />;
  if (isError) return <p className="text-[13px] text-danger">Could not load activity.</p>;
  if (!data?.items.length)
    return (
      <EmptyState
        icon={ClockIcon}
        title="No assignment activity"
        description="Assignment changes will appear here."
      />
    );
  return (
    <section aria-label="Activity" className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">Activity</h2>
      <ul className="space-y-3">
        {data.items.map((item) => (
          <li key={item.id} className="text-[13px] text-muted-foreground">
            <span className="text-foreground">{item.actor.name}</span>
            {item.fromAssignee && item.toAssignee
              ? ` changed the assignee from ${item.fromAssignee.name} to ${item.toAssignee.name}`
              : item.toAssignee
                ? ` assigned ${item.toAssignee.name}`
                : ' removed the assignee'}{' '}
            <time className="text-subtle-foreground" dateTime={item.createdAt}>
              {' '}
              {formatRelativeTime(item.createdAt)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}
