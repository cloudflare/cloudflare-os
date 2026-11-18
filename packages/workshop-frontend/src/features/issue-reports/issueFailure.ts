import {
  getAdminAccessErrorCode,
  getAdminGrantErrorCode,
  getIssueReportErrorCode,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'

/**
 * What a failed call about an issue report or a grant says: the server's own message for a
 * refusal it names by code, which says what the user can do about it, and its account of any
 * other failure, which is logged as well.
 */
export const issueFailure = (err: unknown, fallback: string): string => {
  const code = getIssueReportErrorCode(err) ?? getAdminGrantErrorCode(err) ?? getAdminAccessErrorCode(err)
  if (code !== undefined && err instanceof Error) return err.message
  logRpcFailure(fallback, err)
  return rpcFailureDescription(err) ?? fallback
}
