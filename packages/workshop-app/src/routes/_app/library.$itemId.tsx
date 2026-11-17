import { createFileRoute } from '@tanstack/react-router'
import { ITEM_PAGE } from '../-itemPage'

/** Anything but an app on its own, such as a document or a file that was sent. */
export const Route = createFileRoute('/_app/library/$itemId')({ ...ITEM_PAGE })
