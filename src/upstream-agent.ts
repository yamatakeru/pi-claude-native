/** Shared connection pools; admission and authentication stay request-scoped. */
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

/**
 * How long each resolved address may take to connect before Node tries the
 * next one. Node's default of 250 ms abandons the attempt, not just races it,
 * so a slow IPv4 handshake followed by an unreachable IPv6 address failed the
 * whole connection within a second (#101). 2 s outlasts one lost SYN, which
 * is resent after 1 s. Only the relay's agents use it; Pi's other providers
 * keep Node's default.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;

const options = {
  keepAlive: true,
  maxFreeSockets: 2,
  autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
};

// Node keys pooled sockets by destination and TLS settings. No credentials or
// request headers are supplied to the agents. Idle pooled sockets are unrefed.
const httpAgent = new HttpAgent(options);
const httpsAgent = new HttpsAgent({ ...options, maxCachedSessions: 16 });

process.once("exit", () => {
  httpAgent.destroy();
  httpsAgent.destroy();
});

export function upstreamAgent(scheme: "https:" | "http:"): HttpAgent {
  return scheme === "https:" ? httpsAgent : httpAgent;
}
