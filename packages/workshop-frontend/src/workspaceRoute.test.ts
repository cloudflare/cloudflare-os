import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'
import { MAX_FOCUS_ANCHOR_LENGTH } from '@gadgets/workshop-shared/api'

vi.mock('./GadgetEditor', () => ({ default: () => null }))

import { Route } from './routes/workspace.$id'

const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => unknown

describe('the workspace route', () => {
  // Anchors that look like other JSON values must come back as the same strings.
  it.each(['sheet/q3/cell B7', '123', 'true', 'null', '{"a":1}', ''])('round-trips `at` %j', at => {
    const url = defaultStringifySearch({ w: 0, at })
    expect(validateSearch(defaultParseSearch(url))).toEqual({ w: 0, at })
  })

  it('drops an `at` that is not a string or is too long', () => {
    expect(validateSearch({ w: 1, at: 7 })).toEqual({ w: 1 })
    expect(validateSearch({ w: 1, at: 'a'.repeat(MAX_FOCUS_ANCHOR_LENGTH + 1) })).toEqual({ w: 1 })
  })
})
