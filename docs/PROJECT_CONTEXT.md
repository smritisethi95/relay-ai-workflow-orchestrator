# Relay — Project Context & Decision Log

Living document. Update it whenever a phase finishes, a decision is made, or the design changes.
Design: [ARCHITECTURE.md](ARCHITECTURE.md) · Build order: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)

---

## 1. Project in one paragraph
Relay is a durable workflow orchestrator (Airtribe capstone). Workflows are graphs of typed nodes (`http_request`, `condition`, `delay`, `notify`, `ai`, `approval`, `order_action`) triggered by webhook or API. A separate worker executes runs from a database-backed queue, persists every step, survives crashes without repeating side effects (idempotency keys), validates AI output against JSON Schema, pauses for human approvals that the AI cannot bypass, and stops runaway loops with a step cap. Graded by the pack's `smoke_test.py`, a kill-and-resume drill checked by `duplication_check.py`, injection payloads, docs, and a demo video.

## 2. Current status

| Phase | Status | Notes |
|---|---|---|
| 0 Foundation | Done | Atlas connected (5 collections + indexes), Groq key verified, Python + mock world verified |
| 1 Core domain | Done | types, errors, catalog, validator, resolver, json-schema, safe-keys; 32 tests green |
| 2 Persistence + Workflow API | Not started | |
| 3 Triggers + worker + nodes | Not started | |
| 4 Approvals, gate, cancel | Not started | |
| 5 Durability drill | Not started | |
| 6 AI node + tests | Not started | |
| 7 Console | Not started | |
| 8 Docs | Not started | |
| 9 Demo video | Not started | |

**Open blockers / to-dos for you**
- [x] Python available: 3.13.17 at `C:\Program Files\Python313` (installed via Company Portal; terminals opened before the install need a restart to see it).
- [x] Atlas M0 cluster + DB user + IP allowlist; `MONGODB_URI` in `.env`; `npm run db:indexes` OK.
- [x] Groq key in `.env` (`/models` → 200).

## 3. Environment facts
- OS: Windows, PowerShell. `python` / `py` = Python 3.13.17; `Stop-Process -Id <pid> -Force` instead of `kill -9`.
- Node 24.21.0 via NVM (was 22.12 at Phase 0), npm 10.9.0, Git 2.55.
- `npx` is blocked by the NVM trust policy (NVM4306) — always use npm scripts (`npm test`, `npm run build`), never `npx`.
- Package is ESM (`"type": "module"`); relative imports in `src` must end in `.js`.
- Commands: `npm run build`, `npm run typecheck`, `npm test`, `npm run db:indexes`, `npm run api`, `npm run worker`.
- Mock world: `python scripts/mock_world.py --port 9210`.
- Secrets live only in `.env` (git-ignored). Never paste the Atlas URI or Groq key into chat, docs, or commits.

## 4. Fixed external contract (must not drift)
- Routes the smoke test drives: `GET/POST /workflows`, `POST /workflows/{id}/publish`, `POST /workflows/{id}/trigger` `{"input":{}}`, `POST /hooks/{id}` (`X-Relay-Secret`), `GET /runs/{id}` (`status`, `steps[].node_id`, `steps[].status`), `GET /approvals?status=pending`, `POST /approvals/{id}/approve`.
- Run statuses: `queued`, `running`, `waiting_approval`, `succeeded`, `failed`, `cancelled` — nothing else, ever.
- Error body: `{"error":{"code","message"}}`.
- Seed workflow ids: `wf_support_triage`, `wf_expense_approval`, `wf_slow_fulfillment`, `wf_runaway` (max_steps 12).

## 5. Decision log

| ID | Date | Decision | Why | Alternatives considered |
|---|---|---|---|---|
| D-001 | 2026-11-05 | Source of truth = Airtribe brief + capstone pack docs/scripts | Grading uses the pack's scripts | — |
| D-002 | 2026-11-05 | Idempotency key `{run_id}:{node_id}:{sequence}`, never the attempt number | Stable across retries/resume; distinct per loop iteration | `{run_id}:{node_id}` (breaks legit loops) |
| D-003 | 2026-11-05 | Separate API and worker processes; API only enqueues | Clean kill-and-resume drill; matches approach doc | In-process worker (allowed but weaker) |
| D-004 | 2026-11-05 | Workflow keeps `draft_definition` + `published_definition`; runs snapshot the published one | Allows edit + republish while published versions stay frozen (reviewer check) | Fully immutable workflows (blocks edits) |
| D-005 | 2026-11-07 | **MongoDB Atlas** instead of PostgreSQL | User preference, no local Docker; pack allows NoSQL | Postgres via Docker / Neon |
| D-006 | 2026-11-07 | Queue = `jobs` collection, `_id = run_id`, atomic `findOneAndUpdate` lease claim | One live job per run; Mongo equivalent of SKIP LOCKED | Separate broker (Redis/BullMQ) — extra infra |
| D-007 | 2026-11-07 | **Groq** via OpenAI-compatible adapter; `heuristic` provider as fallback | User has a Groq key; fallback protects the demo from rate limits | Gemini, Ollama |
| D-008 | 2026-11-07 | `LEASE_MS = 30000` | Must exceed the 20 s AI timeout | 15 s (too short for LLM calls) |
| D-009 | 2026-11-07 | **NestJS 12** (not 10) | Nest 10 pulled vulnerable `body-parser` / `multer` (high severity) | Pin Nest 10 and accept audit findings |
| D-010 | 2026-11-07 | Project is **ESM**, compiled with `tsc`, run with `node dist/...` | NestJS 12 is ESM-only; `tsc` emits decorator metadata Nest needs | ts-node-dev (CJS-oriented) |
| D-011 | 2026-11-07 | **Vitest** instead of Jest | Native ESM + TS; Jest 29/30 ESM support is awkward and pulled vulnerable `glob`/`minimatch`/`deepmerge` | Jest + ts-jest |
| D-012 | 2026-11-07 | One-off commands live in `src/cli/` (`db-indexes.ts`, `seed.ts`) | Keeps infra modules side-effect free | Scripts inside `infra/` |
| D-013 | 2026-11-07 | Groq model **`openai/gpt-oss-120b`** | `llama-3.3-70b-versatile` no longer listed; probe: gpt-oss-120b JSON mode OK, 774 ms, strongest available model for injection resistance | `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (both also worked) |
| D-014 | 2026-11-07 | Validator also rejects keys starting with `$` or containing `.` (`invalid_key`) and warns on `approval_not_guaranteed`, `unreachable_node`, `unknown_template_ref`, `unknown_param` | NoSQL operator-injection guard; graph warnings help builders but the runtime gate stays the real guarantee | Reject (instead of warn) unguarded `order_action` — would block the reviewer's gate-bypass test |
| D-015 | 2026-11-07 | Template resolver: path segments `[A-Za-z0-9_-]`, roots only `trigger`/`nodes`, own-property lookup, single pass | Prevents prototype access and template injection through data | Expression language / filters (not required) |
| D-016 | 2026-11-07 | `core` stays pure (no `fs`); pack JSON is loaded by `src/infra/data/pack-data.ts` | Hexagonal boundary; tests reuse the same loader | Catalog reading files itself |

## 6. Change log

| Date | Change |
|---|---|
| 2026-11-05 | Analysed brief, approach and pack; wrote ARCHITECTURE.md and IMPLEMENTATION_PLAN.md (Postgres). |
| 2026-11-07 | Switched design to MongoDB Atlas + Groq (D-005..D-008). |
| 2026-11-07 | Phase 0: npm project (ESM), NestJS 12, mongodb, ajv, ulid, dotenv, Vitest; `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`; `src/config.ts`, `src/infra/db/mongo.ts`, `src/infra/db/indexes.ts`, `src/cli/db-indexes.ts`; pack files downloaded into `data/` and `scripts/`. `npm run build` OK, `npm test` OK (no specs yet), `npm audit` 0 vulnerabilities. |
| 2026-11-07 | Python 3.13 confirmed; `validate_pack.py` → Pack OK (7 node types, 4 seeds, 8 payloads, 15 NL cases); mock world `/health` OK on :9210. |
| 2026-11-07 | Phase 0 closed: Atlas `db:indexes` created 5 collections + indexes; Groq key verified; model switched to `openai/gpt-oss-120b` (D-013). |
| 2026-11-07 | Phase 1: `core/domain/{types,errors}.ts`, `core/catalog/{catalog,validator}.ts`, `core/templates/resolver.ts`, `core/validation/json-schema.ts`, `core/guardrails/safe-keys.ts`, `infra/data/pack-data.ts`; tests `validator.spec.ts` (19) + `resolver.spec.ts` (13) → 32/32 green. |

## 7. Known issues / risks being tracked
- `npx` blocked by NVM policy; use npm scripts only.
