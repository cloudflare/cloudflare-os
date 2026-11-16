import { createFileRoute } from '@tanstack/react-router'
import { ProfilePane } from '@/profile/ProfilePane'
import { signOut } from '@/rpc/token'

/** The signed-in user's profile, from the account menu's first row. */
export const Route = createFileRoute('/_app/profile')({
  component: Profile,
})

function Profile() {
  return (
    <ProfilePane
      // Forgets the session here and starts again from nothing, as the account menu's Sign out does.
      onSignOut={() => {
        signOut()
        window.location.assign('/')
      }}
    />
  )
}
