# free-model-aggregator-01

A zero-dependency Node 22 entry for the make.fun competition `free-model-aggregator-01`: one
long-running server that stands in front of ten simulated free-tier model providers and answers
every request with the strongest free model that can serve it.

The server speaks both client wires — OpenAI Chat Completions (`POST /v1/chat/completions`) and
Anthropic Messages (`POST /v1/messages`), each in JSON and in server-sent events — plus a
`GET /v1/models` route that answers in the wire its auth header names. It discovers the provider
catalog at runtime, registers itself with the trial env, serves the client's requests with
quality-ordered failover, and exits 0 when the workload is done.

## Running

```
node main.ts --list
```

prints the catalog as one JSON document and exits 0 without starting the server. Inside a trial
the same document is the `catalog` field of the `POST /register` body, byte for byte.

```
node main.ts
```

runs the trial server. The environment provides:

- `MAKEFUN_ENV_URL` — the env base URL (`/register`, `/work`, `/instance`, providers under `/p/<id>`)
- `MAKEFUN_PROMPT_FILE` — the brief: provider directory, quality table, workload manifest
- `MAKEFUN_TRIAL_SEED` — seed for any randomness (this entry is fully deterministic and uses none)

Outside a trial (no brief and no env URL) `node main.ts --list` prints `{"providers":[]}`.

## Design

**Startup.** The entry parses the three embedded JSON documents from the prompt file (provider
directory, ratings table, workload manifest — recognized by their `schema` fields), fetches
`GET $MAKEFUN_ENV_URL/instance` for the diallable provider directory (absolute base URLs, keys,
auth schemes) and the workload manifest, then probes every provider's own model endpoint
(`GET /v1/models` on the OpenAI and Anthropic wires, `GET /v1beta/models` on the Gemini wire,
with each provider's own auth header). The result is the catalog: one entry per provider with
`id`, `base_url` (the provider's own path, e.g. `/p/groq`, never joined to the env URL),
`key_env`, `wire`, and `models` (`id`, `free`, `context_length`), paid models included with
`free: false`. If a provider's endpoint cannot be reached, its slice of the brief's quality table
stands in. The server then listens on `0.0.0.0`, registers
`{protocol_version: 1, port, catalog}`, and polls `GET /work` until it answers `{"done": true}`,
at which point the process exits 0.

**Routing policy.** Every request names model `auto`; the model is chosen here. For each incoming
request the entry collects the candidate (provider, model) pairs that are:

1. **free** — a paid model is never a legal pick;
2. **capable** — the model's `tools`, `vision`, `json` and `context_length` (from the provider's
   own catalog, matched with the request's requirements from the workload manifest and the
   request body itself) cover what the request needs;
3. **wire-compatible** — a JSON-mode request (`response_format` on the OpenAI wire) is routed only
   to a wire that can carry it (OpenAI or Gemini, never the Anthropic wire), because the provider
   must echo `json_mode` back exactly as the client sent it;
4. **available** — providers that refused for budget or outage reasons are demoted, not retried
   blindly.

Candidates are ordered by the sealed quality table's `rating_milli` (descending), so each request
is served by the highest-rated legal model. The request is forwarded through the chosen
provider's wire; on a refusal (429 budget/failure-schedule, 402 payment required, concurrent-call
429) the failure is counted and the next candidate serves the same request, so a request whose
first provider call refused is still answered — the failover component. Exactly one successful
provider call backs each answer.

**Wire fidelity.** A request passes through untouched in the provider's wire: system prompt, user
text, images, tools, stop sequences, `max_tokens` and JSON mode all survive so the provider's
echo matches what the client sent. When the client's wire differs from the provider's, the entry
translates in both directions while preserving exactly those echo-relevant fields, and returns
the answer in the wire the client used, streamed or not as it asked, with the provider's text
whole and its usage counts as that wire reports them. Stop reasons map across wires
(`end_turn`→`stop`, `max_tokens`→`length`, `tool_use`→`tool_calls`, `refusal`→`content_filter`).

**Determinism.** Every route is a function of the brief, the requests and the providers' answers.
No wall clock enters any request; all randomness would be seeded from `MAKEFUN_TRIAL_SEED`
(none is needed); requests to the env — discovery, register, `/work` polls and provider calls —
are issued one at a time through a single gate.

## Testing locally

With the kit's CLI (from the kit directory, against this repository):

```
makefun grade-local --kit . --bot /path/to/this/repo --driver process
```

`grade-local` runs the practice trials live against the sealed env, replays them, and prints the
score breakdown (quality 60, served 15, wire 10, failover 10, catalog 5).

A quick manual smoke test against the practice trial:

```
KIT=/path/to/free-model-aggregator-01-kit
MAKEFUN_ENV_DATA_DIR=$KIT/practice/trial-0/input/env \
MAKEFUN_STATE_DIR=/tmp/state MAKEFUN_ENV_PORT=18080 \
  node $KIT/program/env/server.mjs &
MAKEFUN_ENV_URL=http://127.0.0.1:18080 \
MAKEFUN_PROMPT_FILE=$KIT/practice/trial-0/input/prompt.txt \
  node main.ts
```

The env's client drives 20 requests through the server; when `GET /work` reports done, the entry
exits 0 and the env's SIGTERM export can be scored with the kit's scorer:

```
MAKEFUN_OUTPUT_DIR=/tmp/state/export MAKEFUN_REFERENCE_DIR=$KIT/practice/trial-0/reference \
  node $KIT/program/scorer/score.mjs
```

## Files

- `main.ts` — the whole entry (Node 22 standard library only, erasable TypeScript)
- `LICENSE` — MIT
