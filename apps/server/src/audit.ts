import type { FastifyRequest } from 'fastify';

/**
 * Where an audited action came from: the client's address and its User-Agent header. These
 * used to be hard-coded ('127.0.0.1' and made-up service names). Behind a reverse proxy set
 * TRUST_PROXY=true, so request.ip is the real client rather than the proxy.
 */
export interface RequestOrigin {
  ip_address: string | null;
  user_agent: string | null;
}

/** For actions with no request behind them (e.g. scheduled report emails). */
export const NO_ORIGIN: RequestOrigin = { ip_address: null, user_agent: null };

const MAX_USER_AGENT_LENGTH = 500;

export function requestOrigin(request: FastifyRequest): RequestOrigin {
  const agent = request.headers['user-agent'];
  return {
    // The column is varchar(45), the longest textual IPv6 address.
    ip_address: request.ip ? request.ip.slice(0, 45) : null,
    user_agent: typeof agent === 'string' && agent.trim() ? agent.trim().slice(0, MAX_USER_AGENT_LENGTH) : null,
  };
}

/** An audit row's actor_type: SERVICE_ACCOUNT for an API token, USER for a person. */
export function actorType(actor: { api_token?: unknown }): 'USER' | 'SERVICE_ACCOUNT' {
  return actor.api_token ? 'SERVICE_ACCOUNT' : 'USER';
}
