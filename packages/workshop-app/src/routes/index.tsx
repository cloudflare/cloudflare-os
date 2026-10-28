import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/layouts/AppShell'

export const Route = createFileRoute('/')({
  component: () => <AppShell sidebar="Sidebar">Content</AppShell>,
})
