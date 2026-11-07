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
| 2 Persistence + Workflow API | Done | Mongo repo/queue, workflow service, seeding, Nest API; smoke 12 PASS / 5 FAIL (all 5 need trigger/webhook routes from Phase 3); 45 tests green |
| 3 Triggers + worker + nodes | Done | Engine, worker, trigger/webhook/runs API, 6 handlers; 80 tests green; live smoke **25 PASS / 1 FAIL** (approvals list = Phase 4) |
| 4 Approvals, gate, cancel | Done | Approval service/API + cancel; 90 tests green; **live smoke 28/28 PASS** |
| 5 Durability drill | Done | Drill A (kill during delay) + Drill B (kill after shipment call, before persist): `duplication_check.py` PASS both; evidence in VERIFICATION_REPORT.md |
| 6 AI node + tests | Done | Groq + heuristic providers, Ajv + one repair, tokens in trace; 110 tests; live: pay_001/002/003 + both injections + schema failure verified (VERIFICATION_REPORT §5) |
| 7 Console | Done | `/console` (and `/` redirect): workflows + trigger form, runs + trace, approvals; verified in the browser end to end |
| 8 Docs | Done | README, VERIFICATION_REPORT §6–§8 (outage + flaky drills, reviewer checks, limitations) |
| 9 Demo video | Script ready | `docs/DEMO_SCRIPT.md`; recording + submission by you |

**Open blockers / to-dos for you**
- [x] Python available: 3.13.17 at `C:\Program Files\Python313` (installed via Company Portal; terminals opened before the install need a restart to see it).
- [x] Atlas M0 cluster + DB user + IP allowlist; `MONGODB_URI` in `.env`; `npm run db:indexes` OK.
- [x] Groq key in `.env` (`/models` → 200).

## 3. Environment facts
- OS: Windows, PowerShell. `python` / `py` = Python 3.13.17; `Stop-Process -Id <pid> -Force` instead of `kill -9`.
- Node 24.21.0 via NVM (was 22.12 at Phase 0), npm 10.9.0, Git 2.55.
- `npx` is blocked by the NVM trust policy (NVM4306) — always use npm scripts (`npm test`, `npm run build`), never `npx`.
- Package is ESM (`"type": "module"`); relative imports in `src` must end in `.js`.
- Commands: `npm run build`, `npm run typecheck`, `npm test`, `npm run db:indexes`, `npm run seed`, `npm run api`, `npm run worker`.
- **Port 8080 is taken on this machine** by another Node process (PID 15496, not Relay). Run Relay with `PORT=8090` (`$env:PORT='8090'` or set it in `.env`) and point the smoke test at `--url http://localhost:8090`.
- A terminal opened before the Python install needs its PATH refreshed: `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.
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
| D-017 | 2026-11-07 | `POST /workflows` stores any **storable** draft (object, valid id/name, no unsafe keys) and returns a validation preview; full catalog validation blocks only at **publish** (422 `validation_failed`, all issues in `details`) | Matches draft → publish lifecycle; smoke test accepts rejection at publish | Reject invalid drafts at create |
| D-018 | 2026-11-07 | Job enqueue/remove are `Repository` methods (transactional); `Queue` port only does `claim`/`release` | Trigger, approve and step completion must write run + job atomically | Separate queue with its own writes (dual-write risk) |
| D-019 | 2026-11-07 | `Repository.transaction(fn)` hands `fn` a session-bound repository; `fn` may be retried by the driver so it must only touch `tx` | Keeps core free of Mongo types while using real multi-doc transactions | Passing `ClientSession` through core |
| D-020 | 2026-11-07 | Approvals inserted via `findOneAndUpdate` upsert on (run_id, node_id, step_sequence) instead of insert + catch duplicate | A duplicate-key error inside a Mongo transaction aborts the whole transaction | insert + catch 11000 |
| D-021 | 2026-11-07 | Workflow updates/publish are optimistic on `updated_at` → 409 `workflow_modified` on conflict | Prevents publishing a draft that changed mid-request | Last-write-wins |
| D-022 | 2026-11-07 | Nest app is a dynamic module over objects built in `api/context.ts`; controllers use explicit `@Inject(Token)` | Core classes stay decorator-free; no reliance on emitted metadata for DI | Nest-managed services with `@Injectable` in core |
| D-023 | 2026-11-07 | Mongo client `ignoreUndefined: true` | Optional fields are omitted instead of stored as `null` | Manual stripping |
| D-024 | 2026-11-07 | `renewJobLease` replaces `holdsJobLease`: every engine transaction first extends the lease **only if this worker still holds it** (fencing + heartbeat in one atomic update) | Long runs never lose their lease mid-claim; a worker whose lease expired can't write | Separate heartbeat timer |
| D-025 | 2026-11-07 | One claim keeps advancing a run until it must wait (delay/backoff/approval) or finishes; capped at 500 transitions per claim | Fewer queue round-trips; the step cap still bounds the run | One node per claim |
| D-026 | 2026-11-07 | Requeues for delay/backoff reset `claim_count`; only claims that end without progress (crashes) count towards `MAX_CLAIMS` | Long-running healthy runs must not look like poison jobs | Never reset |
| D-027 | 2026-11-07 | Delay resume time = step `started_at` + seconds | A crash during the delay never restarts the wait | `now + seconds` at each execution |
| D-028 | 2026-11-07 | Gate and template failures are recorded as a **failed step** before the run fails | The trace shows exactly where and why the run stopped | Fail the run without a step |
| D-029 | 2026-11-07 | Approval and order_action handlers built in Phase 3 (engine needed them); Phase 4 is now API + cancel only | Engine paths could be tested end-to-end earlier | Stubs |
| D-030 | 2026-11-07 | Manual trigger allowed for every published workflow; webhook only for `trigger.type = webhook` (409 otherwise) | Demos/tests can start any workflow; webhooks stay secret-guarded | Manual only for manual workflows |
| D-031 | 2026-11-07 | `HttpWorldClient` uses `redirect: 'manual'` | A 30x to an internal host can't bypass the URL allow-list | Follow redirects |
| D-032 | 2026-11-07 | Approve = one transaction: approval `pending→approved` (guarded), approval step `waiting→succeeded` with `next`, run `waiting_approval→running`, job enqueued now. Reject = approval `rejected`, step `cancelled`, run `cancelled` (`ended_by: rejected`), job removed | Decision and resume can never be half-applied; double decisions get 409 | Approve only flips the approval and lets the engine discover it |
| D-033 | 2026-11-07 | Cancel: queued / waiting_approval cancel immediately; running sets `cancel_requested` and **expedites** an unleased job so a run sleeping on a delay or backoff stops promptly; in-flight step is allowed to finish | Matches the pack's cooperative-cancel contract without stealing a leased job | Waiting until the delay expires |
| D-034 | 2026-11-07 | `decided_by` is the constant `demo-user` (single demo token) | Pack: field must exist even with one token; role separation is Good To Have | Per-token identities |
| D-035 | 2026-11-07 | Drill-only crash hook `RELAY_CRASH_AFTER_CALL=<node_id>` (decorates the WorldClient; `process.exit(137)` after the first 2xx for that node). Off unless the env var is set | The crash-after-call window can't be hit reliably by hand; this makes the strongest exactly-once proof reproducible | Manual timing; test-only proof |
| D-036 | 2026-11-07 | AI call = fixed guard **system** message (treat customer text as data, don't copy addresses/URLs/instructions) + the output schema; the workflow prompt goes in the **user** message | Separates engine instructions from untrusted data; giving the model the schema raises first-try validity | Single combined prompt |
| D-037 | 2026-11-07 | Exactly one repair call with the Ajv errors appended; second failure = **permanent** `ai_output_invalid` (no transient retries). Provider timeouts/429/5xx stay transient | Pack FAQ: invalid output is not a transient error; don't burn retries re-asking | Retry invalid output with backoff |
| D-038 | 2026-11-07 | `StepError.trace` carries tokens + AI attempts so a failed AI step still shows both attempts and its token cost | Trace must show attempts and tokens even on failure | Lose them on failure |
| D-039 | 2026-11-07 | Groq `json_validate_failed` (HTTP 400) is treated as an invalid model answer (goes through schema validation + repair), not a client error | It is the model's output that was bad, not our request | Fail the step permanently |
| D-040 | 2026-11-07 | Runtime `AI_PROVIDER` = `openai` (Groq) or `heuristic`; scripted fakes live only in `test/fakes/fake-ai.ts` | Keeps test doubles out of production wiring | `AI_PROVIDER=fake` |
| D-041 | 2026-11-07 | `reasoning_effort: low` + `max_completion_tokens: 2048` for `openai/gpt-oss-*` | Classification needs little reasoning; keeps latency (~1 s) and tokens down | Default reasoning |
| D-042 | 2026-11-07 | Console = one static HTML file with vanilla JS, served by the API at `/console` (read from disk per request), same-origin API calls with the bearer token from a header field | No build step, no extra dependencies, no CORS; editable without restarting | React/Vite SPA |
| D-043 | 2026-11-07 | Console renders only through text nodes and ships a strict CSP (`default-src 'none'`, `connect-src 'self'`, `frame-ancestors 'none'`) | Payloads (incl. injection text) are displayed, never interpreted as markup | `innerHTML` templates |
| D-044 | 2026-11-07 | `GET /samples` (authenticated) exposes the pack's sample payloads for the trigger form | One-click demo of every scenario | Hard-coding samples in the HTML |
| D-045 | 2026-11-07 | `npm run db:reset-demo` (CLI, requires `--yes`) wipes runs/steps/approvals/jobs/workflows and re-seeds | Clean, reproducible demo state; destructive action is explicit | Deleting collections by hand in Atlas |

## 6. Change log

| Date | Change |
|---|---|
| 2026-11-05 | Analysed brief, approach and pack; wrote ARCHITECTURE.md and IMPLEMENTATION_PLAN.md (Postgres). |
| 2026-11-07 | Switched design to MongoDB Atlas + Groq (D-005..D-008). |
| 2026-11-07 | Phase 0: npm project (ESM), NestJS 12, mongodb, ajv, ulid, dotenv, Vitest; `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`; `src/config.ts`, `src/infra/db/mongo.ts`, `src/infra/db/indexes.ts`, `src/cli/db-indexes.ts`; pack files downloaded into `data/` and `scripts/`. `npm run build` OK, `npm test` OK (no specs yet), `npm audit` 0 vulnerabilities. |
| 2026-11-07 | Python 3.13 confirmed; `validate_pack.py` → Pack OK (7 node types, 4 seeds, 8 payloads, 15 NL cases); mock world `/health` OK on :9210. |
| 2026-11-07 | Phase 0 closed: Atlas `db:indexes` created 5 collections + indexes; Groq key verified; model switched to `openai/gpt-oss-120b` (D-013). |
| 2026-11-07 | Phase 1: `core/domain/{types,errors}.ts`, `core/catalog/{catalog,validator}.ts`, `core/templates/resolver.ts`, `core/validation/json-schema.ts`, `core/guardrails/safe-keys.ts`, `infra/data/pack-data.ts`; tests `validator.spec.ts` (19) + `resolver.spec.ts` (13) → 32/32 green. |
| 2026-11-07 | Phase 2: ports (`repository`, `queue`, `clock`), `guardrails/{redact,ids}.ts`, `services/workflow.service.ts`, `infra/repositories/mongo-repository.ts`, `infra/queue/mongo-queue.ts`, `api/{main,app.module,context,auth,http-error.filter,error-response,presenters}.ts`, controllers `system` + `workflows`, `cli/seed.ts`; tests `workflow-service.spec.ts`, `guardrails.spec.ts`, fake `in-memory-repository.ts` → 45/45 green. Live check on :8090 against Atlas: seeds published, secrets redacted, 401/404/409/422/400 shapes correct. Smoke: 12 PASS, 5 FAIL (trigger/webhook routes pending). |
| 2026-11-07 | Phase 3: `core/engine/{engine,retry}.ts`, `core/nodes/{types,index,condition,delay,notify,http-request,approval,order-action}.ts`, ports `world-client`/`ai-provider`, guardrails `secrets`/`url-allowlist`, services `trigger`/`run`, `infra/world/http-world-client.ts`, controllers `hooks`/`runs` + trigger route, `worker/main.ts`; tests `engine.spec.ts` (crash re-execution with same key, retries, fail-fast, step cap, gate bypass, wrong-branch approval, template failure, SSRF, snapshot isolation, lease fencing, poison job, webhook checks) + `retry.spec.ts` → 80/80. Live (API :8091 + worker + mock world + Atlas): **smoke 25 PASS / 1 FAIL** (approvals list). |
| 2026-11-07 | Phase 4: `services/approval.service.ts`, `RunService.cancel`, `Repository.expediteJob` (Mongo + in-memory), engine marks a waiting step `cancelled` on cancel, `controllers/approvals.controller.ts`, `POST /runs/:id/cancel`; tests `approvals.spec.ts` (approve/resume, 409 re-decide, reject, gated refund once with key, snapshot integrity across republish while paused, cancel queued/waiting/running/terminal) → 90/90. **Live smoke 28 PASS / 0 WARN / 0 FAIL.** Live HTTP probe: reject → cancelled/rejected, re-approve 409, cancel terminal 409, cancel during delay → cancelled with no shipment. |
| 2026-11-07 | Phase 5: kill-and-resume drills on `wf_slow_fulfillment`. Drill A: worker hard-killed during `pack_delay` → new worker resumed → duplication check PASS (3 executed, 0 replays). Drill B: worker exited right after the shipment call reached the world, before persisting → new worker reclaimed after lease expiry (claim#2), re-sent the same key → duplication check PASS (3 executed, 1 replay absorbed). Added `infra/world/crash-after-call.ts` + worker wiring. Created `docs/VERIFICATION_REPORT.md` with smoke + drill outputs. |
| 2026-11-07 | Phase 6: `core/nodes/ai.ts`, `StepError.trace` + engine records tokens/attempts on failure, `infra/ai/{openai-compatible,heuristic}.provider.ts`, `infra/ai/create-provider.ts`, worker wiring, `AI_PROVIDER` limited to openai|heuristic; tests `ai-node.spec.ts` + `ai-triage.spec.ts`, fake `fake-ai.ts` → 110/110. Live with Groq `openai/gpt-oss-120b`: pay_001 complaint→#support, pay_003 question→#support, pay_002 refund→gate→approve→refund once→email, pay_inject_001 refund_request→**parked at gate, 0 refunds**→reject→cancelled, pay_inject_002→only #support chat, model flagged the message as malicious; unsatisfiable schema → 2 attempts with Ajv errors → `ai_output_invalid`. Report §5 added. |
| 2026-11-07 | Phase 7: `src/api/console/index.html` + `SystemController` routes `/` (redirect), `/console` (CSP headers), `/samples`. Browser check: runs list + trace (pay_inject_001 shows `ended_by: rejected`, tokens, 3 steps), trigger `pay_101` from the UI → approve with comment from the UI → `succeeded`. Fixed a dropped-render race (renders requested during an in-flight render are now queued). |
| 2026-11-07 | Console layout fix: runs table overflowed its 520 px panel and spilled into the trace. Now a 620 px scrollable list panel, single-line run id / status / time cells, truncated workflow names (full name on hover), and panels stack below 1100 px width. Verified at 1230 px. |
| 2026-11-07 | Resilience drills: Drill C (world `down` → 2× HTTP 503 with backoff → restored → attempt 3 succeeded, same key) and Drill D (`fail_rate 0.3`, 8/8 runs succeeded, 3 retries absorbed; duplication check PASS, 9 executed). |
| 2026-11-07 | Added `src/cli/reset-demo.ts` + `npm run db:reset-demo`; ran it (deleted 32 runs, 105 steps, 7 approvals, 23 workflows; re-seeded 4) and reset the mock-world ledger. Run ids in the report no longer exist in the DB (outputs kept verbatim). |
| 2026-11-07 | Phase 8/9: README.md (setup, config, architecture, state machine, exactly-once, guardrails, API, testing, decisions, limitations), VERIFICATION_REPORT §6–§8, `docs/DEMO_SCRIPT.md`, `docs/demo/wf_schema_demo.json` (validated). |

## 7. Known issues / risks being tracked
- `npx` blocked by NVM policy; use npm scripts only.
- Port 8080 occupied by an unrelated Node process → use 8090 (or free 8080 before the demo).
- An API started from your own terminal at 7:02 PM is still on 8090 running the **Phase 2 build** (no trigger/runs routes). Restart it (`Ctrl+C`, then `$env:PORT='8090'; npm run api`) to pick up Phase 3. The worker must be started separately: `npm run worker`.
- **After every phase, restart your API and worker** (`Ctrl+C` then `npm run api` / `npm run worker`): `npm run api`/`worker` rebuild, but a running process keeps the old code. As of Phase 4 your 8090 API and worker are the Phase 3 build.
- **After Phase 5 no worker is running**: your worker (PID 25440) was hard-killed by Drill A, and the recovery workers I started were stopped. Start one again with `npm run worker`.
- Smoke-test and probe runs leave `wf_smoke_*` / `wf_bad_*` / `wf_probe_*` drafts in Atlas — cleared by `npm run db:reset-demo` (run it again right before recording).
