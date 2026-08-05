# Cloudflare OS: An AI productivity environment

Cloudflare OS is an "operating system" for AI productivity originally developed for use inside Cloudflare. A large portion of Cloudflare's workforce -- from engineering to sales and everything in between -- uses Cloudflare OS every day to help them do their jobs.

![A Q3 planning workspace in Cloudflare OS, with an AI-generated slide deck](docs/images/q3-planning-workspace.png)

This is not a traditional computer operating system. We use the term "operating system" in two senses:

* An operating system for *the company* to be productive with AI, in a way that is safe, so that the security team can sleep at night.
* An operating system for AI workloads, analogous to the sense in which a traditional operating system manages compute workloads.

Cloudflare OS provides three things in particular:

1. An agent chat UI where you can ask agents to do tasks, preloaded with knowledge about how your company operates.
2. Sandboxed application development, so that you can ask agents to build "gadgets" (small personal apps) and safely share what you've built with others.
3. A security framework, called Gatekeepers, that applies guardrails to both agents and apps such that non-technical users can safely "go nuts" and nothing bad will happen.

We are making Cloudflare OS open source so that others can copy it and customize it for their own company. The idea is not that your company uses Cloudflare OS, but rather that you make it "*Your Company* OS".

## Quick Start

To quickly run Cloudflare OS locally, [install pnpm](https://pnpm.io/), then do:

    pnpm run-local

Then visit: http://localhost:8787

This runs the whole stack locally on wrangler and workerd. This is not meant for production use, but is a quick way to see what the product does.

Alternatively, you can [deploy to your Cloudflare account](https://os.cloudflare.app/deploy).

(More options at the end of this readme.)

### What to try

Try prompts like:

* "Make slides for my upcoming meeting with a customer." (This will use the built-in slides blueprint.)
* "Make a collaborative whiteboard app." (This will create a new app from scratch.)
* "Make a tic tac toe game." followed by "I'll be X and you be O. I've made my first move. Your turn."
* "Make an issue dashboard for this GitHub repo." (Attach a repo; requires that the GitHub integration is configured.)
* "Fix the typos in this Google Doc." (Attach a doc; requires that the Google integration is configured.)

### WARNING: Early access

Cloudflare OS is in a state of heavy development. This repository is actually version 2, a complete rewrite taking what we learned from version 1 and putting it on a new foundation.

As of the August 2026 release, Cloudflare OS v2 is very capable, but still has many rough edges. We know, and we're working on it. For now, consider this an "early access" release.

## Overview: What is Cloudflare OS really?

### Gadgets: A new way of thinking about software

Cloudflare OS is more than just another chatbox with connectors. The system revolves around a new approach to software, where every user runs their own copy of the productivity apps they use.

When you create a slide deck in Cloudflare OS, you are not calling out to some SaaS software running in the cloud. The system creates a *private instance* of the slide deck software *just for you*. We call this a "gadget". This instance runs in a separate sandbox from everyone else's slide decks.

This has two profound effects:
1. It's impossible for the slide deck app to have a security bug that leaks your slides to an attacker. The Cloudflare OS sandbox controls all access to your private instance of the app.
2. If you want, you can freely modify the code. If the slide deck app is missing a feature you need, you can just ask your agent to add it. And because of point 1, it's totally safe to do so.

This is a big departure from the last 25 years of cloud architecture and "Software as a Service", but we think AI has changed the equation. When any user is capable of prompting an agent to add the features they need, the centralized model of software stops making sense.

### Gatekeepers: A capability-based security layer

Gatekeepers are like supercharged MCP servers.

When you introduce an agent or Gadget to an external resource, a Gatekeeper is created to manage that access. The Gatekeeper is a piece of software specific to each external service which moderates a Gadget's connection to that service. It:
* Provides a clean Cap'n Web API to the service (wrapping whatever API the service provides natively).
* Handles authorization (e.g. via OAuth).
* Enforces narrow access to only the specific resource the user intended.
* Logs every action the Gadget (or agent) performs, for your review.
* For any action which has side effects, provides the human user an opportunity to approve or deny the action ("human in the loop").

On the last point, Gatekeepers implement a significant advancement in the state of the art. Traditionally, human-in-the-loop setups require the human to approve actions *synchronously*. When the agent wants to do something, it has to *stop* and wait for said approval before it can continue. This is annoying: you give your agent a task, then walk away and get a coffee, only to come back and find the agent got stuck on an approval on the first step and has made no progress. As a result, people often give in and set their agents to "auto-approve", or `--dangerously-skip-permissions`, which is, obviously, unsafe.

Gatekeepers provide a better way: When the agent (or Gadget) performs an action that requires approval, the Gatekeeper will *simulate* the outcome locally, allowing the agent to proceed and queue up more actions. The Gatekeeper tells the agent that the action completed, and if the agent tries to read back the results, the Gatekeeper gives it simulated results. Once the agent is done, the user may approve or reject the actions in bulk, or one-by-one, but either way, they can do it later, when it is convenient.

Logistically, each Gatekeeper is implemented as a separate Worker. In the future, we envision Gatekeeper services being deployed and maintained independently from OS instances, but the details have yet to be worked out. For now, we have provided a few interesting Gatekeepers in this repository which you can deploy together with your own OS instance.

### Think of an office suite

The basic user experience of Cloudflare OS is something like an online office suite, like Google Docs or MS Office. But, imagine that instead of a fixed set of file types (document, spreadsheet, slide deck), each file -- or "Gadget" -- is potentially its own custom application, written by AI to serve exactly your needs.

Just like office docs, each gadget is private by default, but can be shared -- securely -- in order to collaborate with your team or your friends.

Just like office docs, you can have thousands of them. You can create them on a whim.

Just like office docs, you can start from "templates" -- called "Blueprints". But where an office template is just some content, a Blueprint specifies a whole application.

Like office docs, you can create new templates (blueprints) from your own docs (Gadgets) and share them with others. But when you do so, you are sharing the code for a whole app.

### It kind of is an Operating System

The OS terminology isn't *entirely* marketing. Cloudflare OS is actually analogous to an operating system on a technical level.

| Normal OS      | Cloudflare OS              |
|----------------|----------------------------|
| kernel         | packages/workshop-backend  |
| device drivers | packages/gatekeeper-*      |
| shell          | packages/workshop-frontend |
| processes      | gadgets                    |
| executables    | blueprints                 |
| users          | users                      |
| ACLs           | shared permissions         |
| ???            | agents                     |

Our "kernel" is in the workshop-backend package. The backend legitimately does a lot of things similar to real OS kernels: it connects users to programs and devices (Gadgets and Gatekeepers, as we call them) while implementing security by sandboxing applications and enforcing access control.

In this analogy, Gatekeepers -- which connect users and agents to external services -- are like drivers -- which connect users and programs to external devices.

There is one thing that traditional OSes don't really manage today, but Cloudflare OS does: AI agents. If you think about it, this is really a missing feature in traditional OSes. We believe that AI agents cannot simply be treated as users. They must be accountable to a human user, while at the same time having their own restricted permissions. Agents do work by writing snippets of code and executing them on the fly. The ideal security model for all of this is capability-based security, not access control lists. See what I mean? Perhaps traditional OSes ought to give AI agents special treatment, too.

### Built on Workers, by the Workers team

Cloudflare OS is built on [Cloudflare Workers](https://workers.cloudflare.com), making heavy use of [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/), and [Facets](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/) in particular. Every workspace is its own Durable Object, every Gadget runs in a Dynamic Worker Facet, and Gatekeepers also install facets into each workspace to manage access to remote services.

Cloudflare OS is, in fact, built by the very people who built Workers itself. It uses cutting-edge features of the Workers Runtime -- in fact, Dynamic Workers, Facets, and several other features were added to the runtime specifically to support Cloudflare OS, with more to come. Studying the Cloudflare OS source code is a great way to understand how the Workers Runtime team thinks Workers should be used.

Being built on Workers does not mean that Cloudflare OS can only run on Cloudflare. In fact, [`workerd`, the Cloudflare Workers Runtime, is itself open source](https://github.com/cloudflare/workerd), and Cloudflare OS can run entirely on top of it on your own servers.

## Features

### General multi-purpose agent

The Cloudflare OS coding agent is actually a fully multi-purpose agent that can perform arbitrary tasks; like other popular coding agents, you don't have to code with it. You can use it to build Gadgets, but you can also skip the Gadget and just have the agent perform tasks directly. The Cloudflare OS agent is a [Code Mode](https://blog.cloudflare.com/code-mode/) agent -- it performs tasks by writing and immediately executing snippets of code. It can be connected to external resources using Gatekeepers (like MCP -- see below).

### Build apps with AI

While you can code a Gadget by hand if you want, the expectation is that AI writes the code for you. Cloudflare OS features a built-in coding agent that will build whatever you ask it, test it for you, and debug errors.

You can choose your LLM. Cloudflare OS works with many major AI model providers and self-hosted models, with more providers being added all the time.

Because of the tightly-integrated and simplified nature of the platform, even when using the same underlying AI models, the Cloudflare OS coding agent often performs better and faster with fewer tokens than a general-purpose coding agent would.

### Collaborate with AI

Every app built with Cloudflare OS automatically has an agent-friendly API. That means, after you've asked AI to build the app, you can also ask AI to collaborate with you *inside* the app. No need to build an MCP server nor integrate a custom agent loop. It's just there by default.

This works because the client and server portions of a Gadget are required to communicate via [Cap'n Web RPC](https://github.com/cloudflare/capnweb). This is a win-win:
1. Cap'n Web is extremely low-boilerplate, which makes it easy for agents to work with. You basically just define a method on your server, then call it from your client, as if it were a local call.
2. Meanwhile, it means that the server necessarily exposes an easy-to-understand API which could be called directly by an agent. The AI Agent harness uses [Code Mode](https://blog.cloudflare.com/code-mode/) for tool calling, making it trivial to expose the Gadget's API directly for the agent to invoke.

### Real-time Multiplayer

You can share your Gadget just like you'd share a document in a typical online office suite. You can give specific users access, or create a share link that provides access to anyone who opens it. And just like those online office suites, you'll be able to see your collaborators' actions in real time.

This works because every Gadget is backed by a [Durable Object](https://developers.cloudflare.com/durable-objects/), Cloudflare's stateful serverless primitive which makes real-time multiplayer collaboration easy. It's so easy that the coding agent just implements it by default, without being asked.

### Blueprints: Share your code

If you've created a Gadget that might be useful to others, but you don't want to share the Gadget itself, you can instead share a Blueprint, allowing other people to create their own copy of the Gadget. A Blueprint is essentially a copy of the code.

It may sound simple, but Blueprints are a major change from cloud software tradition. Traditionally, if you create a web app that you want to share with other users, you host the app on your server, and the users connect to that. Blueprints are much more like mobile apps and traditional PC apps: every user runs their own copy of the software.

In the age of AI, this change is critically important. On one hand, AI empowers an individual developer to build more than ever, but it is still difficult for an individual developer to maintain an online service; this eliminates the need. On the other hand -- and even more importantly -- allowing each user to run their own copy of the software empowers the user to *change* the software to meet their needs, using AI. No need to file a feature request, no need to beg the developer to prioritize it. The end user can solve their own problems.

### Sandboxed and secure by default

Each Gadget runs in a secure sandbox that prevents it from talking to the internet at all without your explicit consent. In particular:
* The server runs in a [Dynamic Worker](https://blog.cloudflare.com/dynamic-workers/) which has had its access to the internet disabled. It can only communicate with specific external resources that you have explicitly designated, via [Workers Bindings](https://blog.cloudflare.com/workers-environment-live-object-bindings/).
* The client code runs in a sandboxed iframe. This iframe can communicate with its server only via a Cap'n Web RPC session provided over `postMessage()` to the parent frame. The iframe is otherwise blocked from accessing the internet (to the maximum extent allowed by browsers, via `Content-Security-Policy` and iframe sandbox settings).

### Capability-based access control

Each agent, and each Gadget, by default has access to nothing. Even if you've configured the Gadget Workshop with access to external accounts, agents and Gadgets do NOT automatically get to use them.

Instead, you must *introduce* each agent (or Gadget) to any particular resources you want it to access. For instance, you may introduce a GitHub repository by pasting a link to it, or clicking "add resource" and selecting it via the UI. An agent can also request an introduction to a resource it thinks it needs, which you can then provide or deny.

This differs from most agent harnesses, where MCP servers are configured upfront, making broad access to all your services ambiently available to the agent in every chat. Capability-based introductions keep each agent restricted to only the access it actually needs for the job at hand.

## Get Started

### Deploy to your Cloudflare account

We've built an online flow that helps you deploy to your own Cloudflare account:

https://os.cloudflare.app/deploy

Or, for more sophisticated deployment, with your gatekeepers and potentially code changes, check out our deployment starter repo:

https://github.com/cloudflare/cloudflare-os-starter

### Run locally

To quickly run Cloudflare OS locally, [install pnpm](https://pnpm.io/), then do:

    pnpm run-local

Then visit: http://localhost:8787

This runs Cloudflare OS using `wrangler`, the Workers developer tooling CLI. This is not the right way to run the OS on a production server, but it works fine for trying it out on your local machine.

Your data will be stored in a subdirectory named `.wrangler`.

### Deploy to your own server using `workerd`

**COMING SOON**

Cloudflare OS can run entirely on `workerd`, Cloudflare's open source runtime for Workers. In fact, the "run locally" instructions above use `workerd` under the hood. We are still working on documentation and tooling to help you smoothly deploy the OS on top of `workerd` on your own servers. If you are feeling adventurous, [read the low-level documentation for workerd config](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) (or point your agent at it) and have a go.

#### Configuring external services

Many Gatekeepers require configuration in order to be able to connect to third-party services, including obtaining OAuth client credentials for each service. Unfortunately, many service providers intentionally do not make this easy, since the intended audience for OAuth is developers.

Each gatekeeper package contains instructions for how to set it up:

* [GitHub API](packages/gatekeeper-github/README.md)
* [Google API](packages/gatekeeper-google/README.md)
* [Cloudflare API](packages/gatekeeper-cloudflare/README.md)
* [Supabase API](packages/gatekeeper-supabase/README.md)
* [Notion API](packages/gatekeeper-notion/README.md)
* [Confluence API](packages/gatekeeper-confluence/README.md)
* [Email Workers](packages/gatekeeper-email/README.md)
* [Home Assistant](packages/gatekeeper-homeassistant/README.md)
* [Slack API](packages/gatekeeper-slack/README.md)
* [Spotify](packages/gatekeeper-spotify/README.md)
* [ZoomInfo API](packages/gatekeeper-zoominfo/README.md)

## Developing

When developing, you'll want to run the front-end and back-end as two separate commands in two terminals:

    pnpm dev-server
    pnpm dev-client

Then visit: http://localhost:3000

### Contributing

At this time, we are not seeking outside contribution.

AI has made writing code easy. The hard part, today, is not writing the code, but reviewing it, making sure quality stays high, and keeping the product coherent. In that light, unfortunately, external code contributions are "donating" the easy part of the job, while creating more of the hard work.

With that said, we are happy to accept small, trivially-verified PRs that fix a problem. However, we ask that you refrain from submitting low-value PRs (e.g. typo fixes) or PRs that are more than a dozen or so lines. Such PRs will be closed with a reference to this guideline.

If you have a big idea you'd like us to consider, feel free to [open a discussion](https://github.com/cloudflare/cloudflare-os/discussions) about it.

This policy may change in the future as the project matures. Until then, thank you for your understanding.

## Credits

Cloudflare OS has far too many open source dependencies to list here. But, we'd like to highlight a few that do particularly heavy lifting:

* [Pi](https://pi.dev/) (specifically, `pi-agent-core`), which made it easy to support every LLM provider with one API.
* [Monaco](https://microsoft.github.io/monaco-editor/) which makes it too easy to embed a beautiful text editor -- for those of us who still look at the code.
* [Yjs](https://yjs.dev/), which we use extensively to sync code changes between clients and agents and replay histories.
* [Vite](https://vite.dev/), which makes the development loop so pleasant.
