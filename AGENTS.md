<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Setting this project up, or operating it

Read `README.md`, then follow `SETUP.md` step by step. It is a runbook written for an agent, with a check after
every step (`npm run doctor`). Its "Rules for an agent" hold for all work here: never print a secret or ask for one
in chat, do not read `.env.local`, and run only the look-only form of a server script unless the person has named the
server and the change.


