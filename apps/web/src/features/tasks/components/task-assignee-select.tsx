'use client';

import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCurrentUser } from '@/features/auth/hooks';
import { useProject, useProjectMembers } from '@/features/projects/hooks';
import { useTaskAssignee } from '../hooks';

export function TaskAssigneeSelect({
  taskId,
  projectId,
  assigneeId,
}: {
  taskId: string;
  projectId: string;
  assigneeId: string | null;
}) {
  const members = useProjectMembers(projectId);
  const project = useProject(projectId);
  const currentUser = useCurrentUser();
  const mutation = useTaskAssignee(taskId, projectId);
  const [search, setSearch] = useState('');
  const me = currentUser.data?.id;
  const myMembership = members.data?.find((member) => member.user.id === me);
  const organizationRole = currentUser.data?.organizations.find(
    (organization) => organization.id === project.data?.organizationId,
  )?.role;
  const canAssignOthers =
    myMembership?.role === 'PROJECT_MANAGER' ||
    organizationRole === 'OWNER' ||
    organizationRole === 'ADMIN';
  const canChange = Boolean(
    canAssignOthers || (myMembership && (assigneeId === null || assigneeId === me)),
  );
  const availableMembers = useMemo(
    () =>
      (members.data ?? []).filter(
        (member) =>
          (canAssignOthers || member.user.id === me) &&
          `${member.user.name} ${member.user.email}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [members.data, canAssignOthers, me, search],
  );

  if (members.isPending || project.isPending || currentUser.isPending)
    return <p className="text-[13px] text-muted-foreground">Loading members…</p>;
  if (members.isError || project.isError || currentUser.isError)
    return <p className="text-[13px] text-danger">Could not load assignment options.</p>;
  if (!members.data?.length)
    return (
      <p className="text-[13px] text-muted-foreground">This project has no assignable members.</p>
    );

  const selected = members.data.find((member) => member.user.id === assigneeId) ?? null;
  return (
    <div className="space-y-2">
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search members"
        aria-label="Search project members"
        disabled={!canChange || mutation.isPending}
      />
      <Select
        value={assigneeId ?? 'unassigned'}
        onValueChange={(value) =>
          mutation.mutate(
            value === 'unassigned'
              ? null
              : (members.data.find((member) => member.user.id === value) ?? null),
          )
        }
        disabled={!canChange || mutation.isPending}
      >
        <SelectTrigger aria-label="Task assignee">
          <SelectValue placeholder="Unassigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">Unassigned</SelectItem>
          {availableMembers.map((member) => (
            <SelectItem key={member.user.id} value={member.user.id}>
              {member.user.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected ? (
        <p className="text-[12px] text-muted-foreground">Assigned to {selected.user.name}</p>
      ) : null}
      {!canChange ? (
        <p className="text-[12px] text-muted-foreground">
          Only project managers can assign other members.
        </p>
      ) : null}
      {mutation.isError ? (
        <p role="alert" className="text-[12px] text-danger">
          {mutation.error.message}
        </p>
      ) : null}
    </div>
  );
}
