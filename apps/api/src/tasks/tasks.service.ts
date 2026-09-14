import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type FilterQuery, Model, Types } from 'mongoose';
import {
  TaskActivityType,
  type Paginated,
  type TaskActivityEntry,
  type TaskDetail,
  type TaskSummary,
} from '@projectflow/shared';
import type { PaginationQueryDto } from '../common/dto/pagination.dto';
import { toUserSummary } from '../common/utils/serialize';
import { Comment, type CommentDocument } from '../comments/schemas/comment.schema';
import { canManage, ProjectAccessService } from '../projects/project-access.service';
import { ProjectMembersService } from '../project-members/project-members.service';
import { Project, type ProjectDocument } from '../projects/schemas/project.schema';
import { UsersService } from '../users/users.service';
import type { CreateTaskDto } from './dto/create-task.dto';
import type { ListTasksQueryDto } from './dto/list-tasks.dto';
import type { UpdateTaskDto } from './dto/update-task.dto';
import type { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import type { UpdateTaskAssigneeDto } from './dto/update-task-assignee.dto';
import { TaskActivity, type TaskActivityDocument } from './schemas/task-activity.schema';
import { Task, type TaskDocument } from './schemas/task.schema';

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(Project.name) private readonly projectModel: Model<ProjectDocument>,
    @InjectModel(Comment.name) private readonly commentModel: Model<CommentDocument>,
    @InjectModel(TaskActivity.name) private readonly activityModel: Model<TaskActivityDocument>,
    private readonly projectAccessService: ProjectAccessService,
    private readonly projectMembersService: ProjectMembersService,
    private readonly usersService: UsersService,
  ) {}

  async findByProject(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    query: ListTasksQueryDto,
  ): Promise<Paginated<TaskSummary>> {
    await this.projectAccessService.assertCanView(projectId, userId);

    const filter: FilterQuery<TaskDocument> = { projectId };
    if (query.status) {
      filter.status = query.status;
    }
    if (query.priority) {
      filter.priority = query.priority;
    }

    const [tasks, total] = await Promise.all([
      this.taskModel.find(filter).sort({ number: 1 }).skip(query.skip).limit(query.pageSize).exec(),
      this.taskModel.countDocuments(filter),
    ]);

    return {
      items: await this.toSummaries(tasks),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: CreateTaskDto,
  ): Promise<TaskDetail> {
    const { project } = await this.projectAccessService.assertCanView(projectId, userId);

    let task: TaskDocument;
    try {
      task = await this.createNumberedTask(project, projectId, userId, dto);
    } catch (error) {
      if (!isTaskNumberDuplicate(error)) throw error;
      await this.repairTaskCounter(projectId);
      task = await this.createNumberedTask(project, projectId, userId, dto);
    }

    return this.toDetail(task, project);
  }

  async findOne(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const { project } = await this.projectAccessService.assertCanView(task.projectId, userId);

    return this.toDetail(task, project);
  }

  async update(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);

    const isCreator = task.createdBy.equals(userId);
    if (!canManage(access) && !isCreator) {
      throw new ForbiddenException('You do not have permission to edit this task');
    }

    if (dto.title !== undefined) {
      task.title = dto.title;
    }
    if (dto.description !== undefined) {
      task.description = dto.description;
    }
    if (dto.status !== undefined) {
      task.status = dto.status;
    }
    if (dto.priority !== undefined) {
      task.priority = dto.priority;
    }

    await task.save();

    return this.toDetail(task, access.project);
  }

  async updateStatus(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskStatusDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);
    if (!canManage(access) && !task.createdBy.equals(userId)) {
      throw new ForbiddenException('You do not have permission to edit this task');
    }

    task.status = dto.status;
    await task.save();

    return this.toDetail(task, access.project);
  }

  async updateAssignee(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskAssigneeDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);
    const assigneeId = dto.assigneeId ? new Types.ObjectId(dto.assigneeId) : null;

    const previous = task.assignee ?? null;
    if (
      assigneeId &&
      !(await this.projectMembersService.findExisting(task.projectId, assigneeId))
    ) {
      throw new ForbiddenException('Assignee must be a member of this project');
    }
    const mayAssignOthers = canManage(access);
    if (!mayAssignOthers && (assigneeId ? !assigneeId.equals(userId) : !previous?.equals(userId))) {
      throw new ForbiddenException('Project members can only assign themselves');
    }
    if ((previous === null && assigneeId === null) || previous?.equals(assigneeId))
      return this.toDetail(task, access.project);

    task.assignee = assigneeId;
    await task.save();
    try {
      await this.activityModel.create({
        type: TaskActivityType.TASK_ASSIGNEE_CHANGED,
        taskId,
        actorId: userId,
        fromAssigneeId: previous,
        toAssigneeId: assigneeId,
      });
    } catch (error) {
      task.assignee = previous;
      try {
        await task.save();
      } catch {
        throw new InternalServerErrorException(
          'Assignment activity failed and the assignment rollback failed',
        );
      }
      throw error;
    }
    return this.toDetail(task, access.project);
  }

  async findActivity(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    query: PaginationQueryDto,
  ): Promise<Paginated<TaskActivityEntry>> {
    const task = await this.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanView(task.projectId, userId);
    const [activities, total] = await Promise.all([
      this.activityModel
        .find({ taskId })
        .sort({ createdAt: -1, _id: -1 })
        .skip(query.skip)
        .limit(query.pageSize)
        .exec(),
      this.activityModel.countDocuments({ taskId }),
    ]);
    const ids = activities.flatMap((item) =>
      [item.actorId, item.fromAssigneeId, item.toAssigneeId].filter(
        (id): id is Types.ObjectId => id !== null,
      ),
    );
    const users = await this.usersService.findManyByIds(ids);
    const byId = new Map(users.map((user) => [user._id.toString(), user]));
    const person = (id: Types.ObjectId | null) =>
      id ? toCreatorSummary(byId.get(id.toString())) : null;
    return {
      items: activities.map((item) => ({
        id: item._id.toString(),
        type: item.type,
        taskId: item.taskId.toString(),
        actor: person(item.actorId)!,
        fromAssignee: person(item.fromAssigneeId),
        toAssignee: person(item.toAssigneeId),
        createdAt: item.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async remove(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<void> {
    const task = await this.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanManage(task.projectId, userId);

    await Promise.all([this.commentModel.deleteMany({ taskId: task._id }), task.deleteOne()]);
  }

  async findTaskOrFail(taskId: Types.ObjectId): Promise<TaskDocument> {
    const task = await this.taskModel.findById(taskId).exec();
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  private async createNumberedTask(
    project: ProjectDocument,
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: CreateTaskDto,
  ): Promise<TaskDocument> {
    const counter = await this.projectModel
      .findByIdAndUpdate(projectId, { $inc: { nextTaskNumber: 1 } }, { new: false })
      .exec();
    if (!counter) throw new NotFoundException('Project not found');
    const number = counter.nextTaskNumber;
    return this.taskModel.create({
      projectId,
      number,
      key: `${project.key}-${number}`,
      title: dto.title,
      description: dto.description ?? null,
      status: dto.status,
      priority: dto.priority,
      createdBy: userId,
    });
  }

  private async repairTaskCounter(projectId: Types.ObjectId): Promise<void> {
    const latest = await this.taskModel
      .findOne({ projectId })
      .sort({ number: -1 })
      .select('number')
      .lean()
      .exec();
    await this.projectModel
      .updateOne({ _id: projectId }, { $max: { nextTaskNumber: (latest?.number ?? 0) + 1 } })
      .exec();
  }

  private async toSummaries(tasks: TaskDocument[]): Promise<TaskSummary[]> {
    if (tasks.length === 0) {
      return [];
    }

    const [creators, commentRows] = await Promise.all([
      this.usersService.findManyByIds(
        tasks.flatMap((task) =>
          task.assignee ? [task.createdBy, task.assignee] : [task.createdBy],
        ),
      ),
      this.commentModel
        .aggregate<{
          _id: Types.ObjectId;
          count: number;
        }>([
          { $match: { taskId: { $in: tasks.map((task) => task._id) } } },
          { $group: { _id: '$taskId', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);

    const creatorsById = new Map(creators.map((user) => [user._id.toString(), user]));
    const commentCounts = new Map(commentRows.map((row) => [row._id.toString(), row.count]));

    return tasks.map((task) => ({
      id: task._id.toString(),
      projectId: task.projectId.toString(),
      number: task.number,
      key: task.key,
      title: task.title,
      status: task.status,
      priority: task.priority,
      commentCount: commentCounts.get(task._id.toString()) ?? 0,
      createdBy: toCreatorSummary(creatorsById.get(task.createdBy.toString())),
      assignee: task.assignee ? toCreatorSummary(creatorsById.get(task.assignee.toString())) : null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }));
  }

  private async toDetail(task: TaskDocument, project?: ProjectDocument): Promise<TaskDetail> {
    const [summary] = await this.toSummaries([task]);
    const resolvedProject = project ?? (await this.projectModel.findById(task.projectId).exec());

    if (!resolvedProject) {
      throw new NotFoundException('Project not found');
    }

    return {
      ...summary!,
      description: task.description ?? null,
      project: {
        id: resolvedProject._id.toString(),
        name: resolvedProject.name,
        key: resolvedProject.key,
      },
    };
  }
}

const DELETED_USER = {
  id: '',
  name: 'Unknown user',
  email: '',
  avatarUrl: null,
};

function toCreatorSummary(user: Parameters<typeof toUserSummary>[0] | undefined) {
  return user ? toUserSummary(user) : DELETED_USER;
}

function isTaskNumberDuplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000 &&
    'keyPattern' in error &&
    typeof error.keyPattern === 'object' &&
    error.keyPattern !== null &&
    'projectId' in error.keyPattern &&
    'number' in error.keyPattern
  );
}
