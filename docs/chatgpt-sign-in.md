# Sign in with ChatGPT

A user can run OpenAI models on their own ChatGPT subscription instead of an API key. OpenAI allows this for the subscriber's own use only, never pooled, so the design rests on one invariant:

**A ChatGPT model's token is handed out only to its owner, inside a workspace nobody else can reach at that moment.**

## Signing in

`chatgpt-oauth.ts` is pi's public-client flow (pi-ai's `auth/oauth/openai-chatgpt`): PKCE, state and nonce, the `dynamic_agent_client` client ID with a per-user agent host UUID, and the `chatgpt.tokens.use.direct` scope for `https://api.openai.com/v1`. OpenAI accepts only loopback redirects (`http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`; every https origin, `*.workers.dev` included, is refused), so a deployed Workshop can't receive the callback. The browser lands on `http://127.0.0.1:1455/auth/callback`, where nothing answers, and the user pastes that address into the providers page (`completeChatGptSignIn`), whose dialog shows what that error page looks like. A Workshop served from an http loopback address with a port, as in local development, gets the callback itself instead: `chatGptRedirectUri()` points OpenAI at its own `/connect/chatgpt` page, which completes the sign-in and tells the tab that started it.

The user object (`user.ts`) keeps one pending sign-in (10 minutes, single-use, so a second tab abandons the first) and the credential. `getChatGptAccessToken()` refreshes a token that is due, one refresh shared among concurrent calls, saves the result only if no sign-in or sign-out replaced the credential meanwhile, and forgets a sign-in that OpenAI revoked. Tokens, codes and callback addresses are never logged or returned to a client.

## Models

Completing a sign-in adds the OpenAI models `SUGGESTED_MODELS` offers (the hidden ones excepted) as ChatGPT models under `chatgpt/<model>`, leaving alone any the user already has under those IDs, so a user has models to pick right away. A model with `credential: "chatgpt"` is an OpenAI model with no API key, URL or headers. `getModel()` sends it directly to OpenAI whatever the deployment's gateway, with a placeholder key that tells pi it is a sign-in (pi then leaves out the fields the subscription refuses) and the real token set per request by the handle's `bearer`. It costs nothing and spends no free-tier quota. Without a token source `getModel()` throws, so such a model can never fall through to a gateway. It can't be the quick model, which also runs in workspaces other people own.

The admin's `chatGptSignInEnabled` (on by default) turns the whole feature off; on an AI Gateway deployment it also takes `userModelsEnabled`.

## Owner-only workspaces

`OverseerImpl.chatGptAccess(userId)` is the only way a token reaches a workspace. It refuses anyone but the owner, refuses a workspace that is shared, and otherwise locks the workspace to the owner (`ownerOnly`) before asking the owner's user object for the token. Agent turns call it before every request (a fresh token is reused until it expires, but the check runs every time), and a `LanguageModelGatekeeper` for a ChatGPT model asks the Overseer for it, for the user who minted the binding, before each of its requests. The owner unlocks the workspace with `Overseer.allowSharing()` once no turn is running; anything made while it was locked then fails closed until it is unshared. See "Owner-only workspaces" in `docs/sharing.md`.

So a locked workspace can't be shared, and a collaborator can't run their own ChatGPT model in someone else's workspace.
