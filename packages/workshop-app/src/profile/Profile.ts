import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'

/** The parts of the user's API the profile uses. */
export type ProfileApi = Pick<AuthenticatedApi, 'getAvatar' | 'setAvatar' | 'setOwnDisplayName' | 'changePassword' | 'hasPasswordLogin'>

export type ProfileSnapshot = {
  /** Who the user is, as the server says, with what they changed since. */
  user: AiChatAuthorInfo
  /** Their picture, as an address an image can show; absent while there is none, or until it is read. */
  picture?: string
  /** They sign in with a password, which can then be changed here; undefined until it is known. */
  hasPassword?: boolean
}

/** What turns a picture's bytes into an address, and lets the address go. */
export type PictureUrls = { create: (bytes: Uint8Array) => string; revoke: (url: string) => void }

/** Hashes a password as sign-in does (`PublicApi.login`), salted with the user's id. */
export type PasswordHash = (userId: string, password: string) => Promise<Uint8Array>

const BROWSER_URLS: PictureUrls = {
  create: (bytes) => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })),
  revoke: (url) => URL.revokeObjectURL(url),
}

/**
 * The signed-in user's profile: who they are (`whoami`, as signed in), their picture
 * (`getAvatar`) and whether they have a password. Observable through `subscribe`/`getSnapshot`,
 * for the sidebar's account button and the profile page alike, so a change shows everywhere at
 * once. Each change is made on the server first, then shown; one refused rejects with why, and
 * leaves the profile as it was.
 */
export class Profile {
  #snapshot: ProfileSnapshot
  #listeners = new Set<() => void>()
  #run = 0

  constructor(
    private readonly api: () => ProfileApi,
    user: AiChatAuthorInfo,
    private readonly hash: PasswordHash,
    private readonly urls: PictureUrls = BROWSER_URLS,
  ) {
    this.#snapshot = { user }
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  /** Reads the picture and how the user signs in, keeping what is shown until they come. */
  start() {
    const run = ++this.#run
    const api = this.api()
    // Without them, the profile shows initials, and no password to change.
    api.getAvatar(this.#snapshot.user.id).then((bytes) => {
      if (run === this.#run) this.#showPicture(bytes)
    }, () => {})
    api.hasPasswordLogin().then((hasPassword) => {
      if (run === this.#run) this.#set({ hasPassword })
    }, () => {})
  }

  stop() {
    this.#run++
    if (this.#snapshot.picture) this.urls.revoke(this.#snapshot.picture)
    this.#snapshot = { user: this.#snapshot.user }
  }

  /** Changes the name others see the user by, in chats and on what they share. */
  rename = async (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Give a name.')
    await this.api().setOwnDisplayName(trimmed)
    this.#set({ user: { ...this.#snapshot.user, name: trimmed } })
  }

  /** Sets the user's picture (a small JPEG, `compressPicture`), or with null takes it away. */
  setPicture = async (bytes: Uint8Array | null) => {
    await this.api().setAvatar(bytes)
    this.#showPicture(bytes)
  }

  /** Changes the password the user signs in with, given the one they have now. */
  changePassword = async (current: string, next: string) => {
    const { id } = this.#snapshot.user
    const [currentHash, nextHash] = await Promise.all([this.hash(id, current), this.hash(id, next)])
    await this.api().changePassword(currentHash, nextHash)
  }

  #showPicture(bytes: Uint8Array | null) {
    const before = this.#snapshot.picture
    this.#set({ picture: bytes && bytes.byteLength > 0 ? this.urls.create(bytes) : undefined })
    if (before) this.urls.revoke(before)
  }

  #set(change: Partial<ProfileSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...change }
    for (const listener of this.#listeners) listener()
  }
}
