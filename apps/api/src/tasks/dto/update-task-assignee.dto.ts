import { IsMongoId, IsOptional } from 'class-validator';

export class UpdateTaskAssigneeDto {
  /** Omit or send null to unassign. */
  @IsOptional()
  @IsMongoId()
  assigneeId?: string | null;
}
