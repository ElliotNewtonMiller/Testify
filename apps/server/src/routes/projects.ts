import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { ProjectRepository, TestPlanRepository } from '@testify/db';
import { authenticateRequest } from '../middleware/auth.js';

/**
 * Real project/test-plan listings, replacing the hardcoded fake dropdown data that used to
 * live in apps/web/src/App.tsx (prj_01/02/03, pln_01/02/03 -- none of which exist in the DB).
 */
export async function registerProjectRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const projectRepo = new ProjectRepository(db);
  const planRepo = new TestPlanRepository(db);

  app.get('/api/v1/projects', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const projects = await projectRepo.findAll();
    return { projects };
  });

  app.get('/api/v1/projects/:projectId/plans', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const { projectId } = request.params as { projectId: string };
    const project = await projectRepo.findById(projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const plans = await planRepo.findByProject(projectId);
    return { plans };
  });
}
