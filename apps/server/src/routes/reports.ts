import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import {
  REPORT_CATALOG,
  REPORT_DEFINITIONS,
  findReport,
  renderRunSummaryMarkdown,
  toCsv,
  validateReportParams,
  type ReportFormat,
  type RunSummaryReport,
} from '@testify/core';
import { requirePermission } from '../middleware/auth.js';
import { ReportError, ReportService } from '../services/reportService.js';

import { sendError, reportErrorParams } from '../errors.js';
import * as O from '../openapi/areas/other.js';
/**
 * Reports, driven entirely by @testify/core's REPORT_CATALOG:
 *
 * GET  /api/v1/projects/:projectId/reports            -- the catalog: every report, what it
 *      answers, its params as JSON Schema and formats, plus how every number is defined.
 * POST /api/v1/projects/:projectId/reports/:reportId  -- run one. JSON body = its params.
 *      ?format=json (default) | markdown | csv, where the catalog entry lists it.
 *
 * The same ReportService backs the MCP tools, so the web UI, scripts and agents all get
 * identical numbers. Nested under :projectId and gated on SPEC_VIEW (held by every default
 * role, including Viewer) so project-scoped overrides and API tokens resolve correctly.
 */
export async function registerReportRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const reports = new ReportService(db);

  app.get(
    '/api/v1/projects/:projectId/reports',
    { schema: O.reportCatalogSchema, preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async () => ({ reports: REPORT_CATALOG, definitions: REPORT_DEFINITIONS })
  );

  app.post(
    '/api/v1/projects/:projectId/reports/:reportId',
    { schema: O.runReportSchema, preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId, reportId } = request.params as { projectId: string; reportId: string };
      const { format: formatRaw } = request.query as { format?: string };

      const report = findReport(reportId);
      if (!report) {
        return sendError(reply, 404, `Unknown report '${reportId}'. GET .../reports lists them.`, { code: 'REPORT_NOT_FOUND' });
      }
      const format = (formatRaw || 'json') as ReportFormat;
      if (!report.formats.includes(format)) {
        return sendError(reply, 400, `Report '${reportId}' supports format ${report.formats.join(', ')}`, { code: 'INVALID_PARAMS', invalid_params: [{ name: 'format', reason: `must be one of ${report.formats.join(', ')}` }] });
      }

      const validation = validateReportParams(report, request.body);
      if (!validation.ok) {
        return sendError(reply, 400, validation.errors.map((e) => `${e.param} ${e.reason}`).join('; '), { code: 'INVALID_PARAMS', invalid_params: validation.errors });
      }

      try {
        const output = await reports.run(projectId, reportId, validation.params);
        if (format === 'markdown') {
          return reply.header('Content-Type', 'text/markdown; charset=utf-8').send(renderRunSummaryMarkdown(output.data as unknown as RunSummaryReport));
        }
        if (format === 'csv' && output.csv) {
          return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${reportId}.csv"`)
            .send(toCsv(output.csv.columns, output.csv.rows));
        }
        return reply.send(output.data);
      } catch (err) {
        if (err instanceof ReportError) {
          return sendError(reply, err.status, err.message, { code: err.code, ...reportErrorParams(err.details) });
        }
        throw err;
      }
    }
  );
}
