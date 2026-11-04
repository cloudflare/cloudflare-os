/** Replica access requires an explicit deployment grant, never a gatekeeper assertion. */
export function agentIntegrationReplicaGrant(config: string | undefined, vendor: string): boolean {
  try { return JSON.parse(config ?? "null")?.[vendor]?.worktreeReplica === true; }
  catch { return false; }
}
