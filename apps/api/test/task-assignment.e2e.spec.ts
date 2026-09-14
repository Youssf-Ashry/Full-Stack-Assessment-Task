import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { OrganizationRole, ProjectRole, TaskStatus } from '@projectflow/shared';
import { backfillTaskCounters } from '../src/database/migrations/backfill-task-counters';
import { createTestApp, resetDatabase } from './utils/test-app';
import {
  addOrganizationMember,
  addProjectMember,
  authHeader,
  createOrganization,
  createProject,
  createTask,
  registerUser,
  type TestUser,
} from './utils/fixtures';

describe('Task assignment and numbering', () => {
  let app: INestApplication;
  let connection: Connection;
  let owner: TestUser;
  let admin: TestUser;
  let manager: TestUser;
  let member: TestUser;
  let other: TestUser;
  let outsider: TestUser;
  let projectId: string;

  beforeAll(async () => ({ app, connection } = await createTestApp()));
  afterAll(async () => app.close());

  beforeEach(async () => {
    await resetDatabase(connection);
    [owner, admin, manager, member, other, outsider] = await Promise.all([
      registerUser(app, 'Owner User', 'owner@example.com'),
      registerUser(app, 'Admin User', 'admin@example.com'),
      registerUser(app, 'Manager User', 'manager@example.com'),
      registerUser(app, 'Member User', 'member@example.com'),
      registerUser(app, 'Other Member', 'other@example.com'),
      registerUser(app, 'Outside Project', 'outside@example.com'),
    ]);
    const organizationId = await createOrganization(connection, 'Acme', 'acme', owner.id);
    await Promise.all([
      addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER),
      addOrganizationMember(connection, organizationId, admin.id, OrganizationRole.ADMIN),
      addOrganizationMember(connection, organizationId, manager.id, OrganizationRole.MEMBER),
      addOrganizationMember(connection, organizationId, member.id, OrganizationRole.MEMBER),
      addOrganizationMember(connection, organizationId, other.id, OrganizationRole.MEMBER),
      addOrganizationMember(connection, organizationId, outsider.id, OrganizationRole.MEMBER),
    ]);
    projectId = await createProject(connection, organizationId, 'Engineering', 'ENG', owner.id);
    await Promise.all([
      addProjectMember(connection, projectId, manager.id, ProjectRole.PROJECT_MANAGER),
      addProjectMember(connection, projectId, member.id, ProjectRole.MEMBER),
      addProjectMember(connection, projectId, other.id, ProjectRole.MEMBER),
    ]);
  });

  async function taskId(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({ title: 'Assignment test task' })
      .expect(201);
    return response.body.id;
  }

  it.each([
    ['OWNER', () => owner],
    ['ADMIN', () => admin],
    ['PROJECT_MANAGER', () => manager],
  ])('%s can assign another project member', async (_role, actorFactory) => {
    const id = await taskId();
    const actor = actorFactory();
    const response = await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(actor))
      .send({ assigneeId: other.id })
      .expect(200);
    expect(response.body.assignee).toMatchObject({ id: other.id });
  });

  it('allows a MEMBER to assign and unassign themselves only', async () => {
    const id = await taskId();
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: member.id })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: other.id })
      .expect(403);
    const response = await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: null })
      .expect(200);
    expect(response.body.assignee).toBeNull();
  });

  it('rejects an assignee who is not a project member', async () => {
    const id = await taskId();
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: outsider.id })
      .expect(403);
  });

  it('records transitions once, returns newest-first pages, and blocks unauthorized activity access', async () => {
    const id = await taskId();
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: member.id })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: other.id })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: null })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: null })
      .expect(200);

    const first = await request(app.getHttpServer())
      .get(`/tasks/${id}/activity`)
      .query({ page: 1, pageSize: 2 })
      .set('Authorization', authHeader(member))
      .expect(200);
    const second = await request(app.getHttpServer())
      .get(`/tasks/${id}/activity`)
      .query({ page: 2, pageSize: 2 })
      .set('Authorization', authHeader(member))
      .expect(200);
    expect(first.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(first.body.items[0]).toMatchObject({ fromAssignee: { id: other.id }, toAssignee: null });
    expect(first.body.items[1]).toMatchObject({
      fromAssignee: { id: member.id },
      toAssignee: { id: other.id },
    });
    expect(second.body.items[0]).toMatchObject({
      fromAssignee: null,
      toAssignee: { id: member.id },
    });
    await request(app.getHttpServer())
      .get(`/tasks/${id}/activity`)
      .set('Authorization', authHeader(outsider))
      .expect(403);
  });

  it('blocks a member of another project from every task mutation', async () => {
    const id = await taskId();
    const projectTwo = await createProject(
      connection,
      (await connection
        .collection('projects')
        .findOne({
          _id: new connection.base.Types.ObjectId(projectId),
        }))!.organizationId.toString(),
      'Other',
      'OTH',
      owner.id,
    );
    await addProjectMember(connection, projectTwo, outsider.id, ProjectRole.MEMBER);
    await request(app.getHttpServer())
      .patch(`/tasks/${id}`)
      .set('Authorization', authHeader(outsider))
      .send({ title: 'Forbidden update' })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/status`)
      .set('Authorization', authHeader(outsider))
      .send({ status: TaskStatus.DONE })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/tasks/${id}/assignee`)
      .set('Authorization', authHeader(outsider))
      .send({ assigneeId: outsider.id })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/tasks/${id}`)
      .set('Authorization', authHeader(outsider))
      .expect(403);
  });

  it('allocates unique identifiers for concurrent task creation', async () => {
    const responses = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        request(app.getHttpServer())
          .post(`/projects/${projectId}/tasks`)
          .set('Authorization', authHeader(member))
          .send({ title: `Concurrent task ${index}` })
          .expect(201),
      ),
    );
    const numbers = responses.map((response) => response.body.number);
    const keys = responses.map((response) => response.body.key);
    expect(new Set(numbers).size).toBe(16);
    expect(new Set(keys).size).toBe(16);
    expect(numbers.sort((a: number, b: number) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
  });

  it('backfills task counters without moving safe counters backwards', async () => {
    const emptyProjectId = await createProject(
      connection,
      (await connection
        .collection('projects')
        .findOne({
          _id: new connection.base.Types.ObjectId(projectId),
        }))!.organizationId.toString(),
      'Empty',
      'EMP',
      owner.id,
    );
    const blankProjectId = await createProject(
      connection,
      (await connection
        .collection('projects')
        .findOne({
          _id: new connection.base.Types.ObjectId(projectId),
        }))!.organizationId.toString(),
      'Blank',
      'BLK',
      owner.id,
    );
    await connection
      .collection('projects')
      .updateOne(
        { _id: new connection.base.Types.ObjectId(projectId) },
        { $unset: { nextTaskNumber: '' } },
      );
    await connection
      .collection('projects')
      .updateOne(
        { _id: new connection.base.Types.ObjectId(blankProjectId) },
        { $unset: { nextTaskNumber: '' } },
      );
    await connection
      .collection('projects')
      .updateOne(
        { _id: new connection.base.Types.ObjectId(emptyProjectId) },
        { $set: { nextTaskNumber: 20 } },
      );
    await createTask(connection, projectId, 'ENG', 4, 'Legacy four', member.id);
    await createTask(connection, projectId, 'ENG', 9, 'Legacy nine', member.id);
    await backfillTaskCounters(connection);
    await backfillTaskCounters(connection);
    const [legacy, safe, blank] = await Promise.all([
      connection
        .collection('projects')
        .findOne({ _id: new connection.base.Types.ObjectId(projectId) }),
      connection
        .collection('projects')
        .findOne({ _id: new connection.base.Types.ObjectId(emptyProjectId) }),
      connection
        .collection('projects')
        .findOne({ _id: new connection.base.Types.ObjectId(blankProjectId) }),
    ]);
    expect(legacy?.nextTaskNumber).toBe(10);
    expect(safe?.nextTaskNumber).toBe(20);
    expect(blank?.nextTaskNumber).toBe(1);
  });
});
