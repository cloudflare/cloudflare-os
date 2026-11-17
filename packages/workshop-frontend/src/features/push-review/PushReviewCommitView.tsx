import { ExactText } from '../../components/ExactText'
import { formatSize } from '../../components/ActionFields'
import { parseCommitText, type CommitRow } from './pushReviewModel'

const headingClass = 'm-0 text-[12px] font-semibold leading-4 text-kumo-default'
const statementClass = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle'
const exactClass = 'font-mono text-[12px] leading-[18px] text-kumo-default'

/**
 * One commit of the push, whole: its oid, every header line in the order written, and its
 * message. Nothing is normalized, shortened or left out, and each value goes through `ExactText`,
 * so what the approver reads is what the commit object holds.
 */
export const PushReviewCommitView = ({ commit }: { commit: CommitRow }) => {
  const parsed = commit.text === undefined ? undefined : parseCommitText(commit.text)
  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h3 className={headingClass}>Commit</h3>
        <p className={`m-0 mt-1 break-all ${exactClass}`}>{commit.oid}</p>
      </div>

      {parsed === undefined ? (
        <p className={statementClass}>
          {commit.size === undefined
            ? 'This commit is not in this workspace yet, so it cannot be shown.'
            : `This commit cannot be read as text: ${formatSize(commit.size)}.`}
        </p>
      ) : (
        <>
          <dl className="m-0 flex flex-col gap-2">
            {parsed.headers.map((header, index) => (
              <div key={index} className="min-w-0">
                <dt className={headingClass}>
                  {'raw' in header ? 'Unrecognized header line' : <ExactText text={header.name} singleLine />}
                </dt>
                <dd className="m-0 mt-0.5 min-w-0">
                  {'raw' in header ? (
                    <ExactText text={header.raw} singleLine className={exactClass} />
                  ) : header.value === '' ? (
                    <span className={`italic ${statementClass}`}>(empty)</span>
                  ) : (
                    <ExactText text={header.value} className={exactClass} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {!parsed.terminated && <p className={statementClass}>The commit text ends without a newline.</p>}

          <div>
            <h3 className={headingClass}>Message</h3>
            {parsed.message === undefined ? (
              <p className={`mt-1 ${statementClass}`}>No message.</p>
            ) : parsed.message === '' ? (
              <p className={`mt-1 ${statementClass}`}>The message is empty.</p>
            ) : (
              <p className="m-0 mt-1 rounded-xl border border-kumo-line/70 bg-kumo-base p-3">
                <ExactText text={parsed.message} className={exactClass} />
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
