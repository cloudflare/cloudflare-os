import { useEffect, useId, useRef, useState } from 'react'
import type { CodeFileEditing } from './CodeFileTree'
import type { CodeNameFieldProps } from './CodeNameField'
import { nameOf } from './codeTree'

/**
 * A file's name being typed where it is: a new one's (`adding`, the folder it goes in, which the
 * host keeps until `onAddingEnd`) and a renamed file's (`rename`), one at a time. It holds what is
 * typed, says what is wrong with it (`problem`, for the host to show wherever there is room), and
 * answers Enter by making the file or taking the name where it can go, Escape by putting it away,
 * and leaving the field by taking a name that can go and putting away one that can't.
 */
export const useCodeNaming = ({ editing, adding, onAddingEnd }: { editing?: CodeFileEditing; adding?: string; onAddingEnd?: () => void }) => {
  const [renaming, setRenaming] = useState<string>()
  const [typed, setTyped] = useState('')
  const finished = useRef(false)
  const problemId = useId()

  // A new file starts with nothing typed.
  const [was, setWas] = useState(adding)
  if (was !== adding) {
    setWas(adding)
    if (adding !== undefined) setTyped('')
  }
  // Once started, a name is finished once: Enter and the field being left are one answer.
  useEffect(() => {
    finished.current = false
  }, [adding, renaming])

  const naming = editing && adding !== undefined ? ({ folder: adding } as const) : editing && renaming !== undefined ? ({ renaming } as const) : undefined
  const answer = editing && naming ? editing.check(typed, naming) : undefined
  const problem = answer && 'problem' in answer ? answer.problem : undefined

  const finish = (path: string | undefined) => {
    if (!editing || finished.current) return
    finished.current = true
    if (adding !== undefined) {
      onAddingEnd?.()
      if (path) editing.onCreate(path)
    } else if (renaming !== undefined) {
      setRenaming(undefined)
      if (path) editing.onRename(renaming, path)
    }
  }

  return {
    /** The path of the file being renamed, if one is. */
    renaming,
    /** Starts typing a new name for the file at `path`. */
    rename: (path: string) => {
      setTyped(nameOf(path))
      setRenaming(path)
    },
    /** What is typed, for the icon of the file it will be. */
    typed,
    /** What is wrong with it, said wherever there is room. */
    problem,
    problemId,
    /** What the field is given, for the name it starts from. */
    field: (initial: string, label: string, placeholder?: string): Omit<CodeNameFieldProps, 'fill'> => ({
      initial,
      label,
      placeholder,
      value: typed,
      onValueChange: setTyped,
      invalid: problem !== undefined,
      describedBy: problem ? problemId : undefined,
      onEnter: () => {
        if (answer && 'path' in answer) finish(answer.path)
        else if (answer && 'none' in answer) finish(undefined)
      },
      onEscape: () => finish(undefined),
      onBlur: () => finish(answer && 'path' in answer ? answer.path : undefined),
    }),
  }
}
