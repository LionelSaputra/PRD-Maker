# PRD-Maker

Turn a raw app idea into a technical PRD and a task breakdown that an AI coding
agent can execute directly.

PRD-Maker is a small full-stack tool: a web dashboard and a CLI that share one
SQLite database. You describe an idea; it asks clarifying questions, then
produces a structured PRD (architecture, features, database schema, API
endpoints) plus an ordered task list. The CLI then reports execution progress
back to the same workspace, so the dashboard always reflects what the agent is
doing.

## Features

- **Clarification-first generation** — asks targeted follow-up questions before
  producing a spec, instead of guessing from a one-line prompt.
- **Structured PRD output** — tagline, summary, architecture, feature list,
  database schema, and API endpoints, generated as validated JSON.
- **Task breakdown** — each PRD becomes an ordered task list with a spec per
  task, ready to hand to a coding agent.
- **Progress tracking** — task states are `todo`, `in_progress`, `done`, and
  `failed`, with an optional failure reason.
- **CLI bridge** — link a local repo to a workspace, then report task state from
  the terminal while coding.
- **Per-workspace auth** — every workspace carries its own token, so the CLI can
  only reach the workspace it was connected to.

## Stack

- **Runtime:** Node.js
- **HTTP layer:** the built-in `http` module — no web framework
- **Database:** SQLite via `better-sqlite3` (WAL mode)
- **Frontend:** server-rendered HTML with vanilla JavaScript, no build step
- **AI provider:** OpenAI-compatible router, memakai model teks yang tersedia dari `/v1/models`; default server saat ini `oa/space-bunny-free`
- **API:** REST under `/api/v1`

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/models` | List available AI models |
| `GET` | `/api/v1/workspaces` | List workspaces |
| `POST` | `/api/v1/workspaces/clarify` | Generate clarifying questions for an idea |
| `POST` | `/api/v1/workspaces/generate` | Generate the PRD and task breakdown |
| `GET` | `/api/v1/workspaces/:id` | Read one workspace and its tasks |
| `DELETE` | `/api/v1/workspaces/:id` | Delete a workspace |

## CLI

```bash
# Link this repo to a workspace
ngodingai connect --workspace <ws_id> --token <token>

# Report progress as you code
ngodingai task start    <task_id>
ngodingai task complete <task_id>
ngodingai task fail     <task_id> --reason "why it failed"

# See what is currently in progress
ngodingai status
```

## Running locally

```bash
npm install
npm start          # serves on http://localhost:3333 by default
npm test
```

Set `PORT` to change the port. The database file is created automatically on
first run, and is ignored by git — it holds workspace tokens, so it must never
be committed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3333` | Port the HTTP server listens on |
| `PRDMAKER_API_KEY` | — | API key for the AI provider |
| `PRDMAKER_BASE_URL` | `http://127.0.0.1:20127/v1` | Base URL of the OpenAI-compatible AI endpoint |
| `PRDMAKER_MODEL` | — | Default model used for generation; config server saat ini `oa/space-bunny-free` |
| `PRDMAKER_CONFIG` | `~/.prdmaker/config.yaml` | Path to an optional YAML config file |
| `DB_PATH` | `./data.db` | SQLite database location |

Environment variables take precedence over the config file. If no API key is
found, the server still starts and serves the dashboard, but PRD generation
returns an error instead of failing silently.

## Data model

Two tables:

- **`workspaces`** — `id`, `name`, `token`, `summary`, `tech_stack`, `tagline`,
  `architecture`, `features_json`, `db_schema_json`, `api_endpoints_json`,
  timestamps.
- **`tasks`** — `id`, `workspace_id`, `title`, `spec`, `status`, `reason`,
  timestamps.

## License

No license specified yet.
