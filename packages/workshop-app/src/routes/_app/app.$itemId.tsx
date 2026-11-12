import { createFileRoute } from '@tanstack/react-router'
import { ITEM_PAGE } from '../-itemPage'

/** An app, on its own: apps are what is run, and have pages apart from everything else. */
export const Route = createFileRoute('/_app/app/$itemId')({ ...ITEM_PAGE })
