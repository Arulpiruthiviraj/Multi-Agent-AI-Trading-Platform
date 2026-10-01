# Archive

Code that is no longer part of the running application but is kept in the repo
for reference rather than deleted outright.

## python-platform/

A disconnected Python/FastAPI reimplementation of the trading platform. The
running Node/Express app (`server.ts`) never imports or calls anything in
here - it was moved out of the repo root into this archive so it stops
reading as an active second implementation while browsing the codebase.
