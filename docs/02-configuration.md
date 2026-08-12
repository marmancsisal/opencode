# 02 — Configuration reference

Four YAML files hold every decision the system can make. Nothing is hardcoded in JavaScript.

| File | Answers | May mention a model? |
| --- | --- | --- |
| [capabilities.yaml](../.opencode/capabilities.yaml) | WHAT | **never** |
| [policies.yaml](../.opencode/policies.yaml) | WHEN | **never** |
| [workflows.yaml](../.opencode/workflows.yaml) | HOW | **never** |
| [providers.yaml](../.opencode/providers.yaml) | WHO | yes — the only one |

A fifth file, [.opencode/opencode.json](../.opencode/opencode.json), is opencode's own runtime config
(provider endpoints and credentials). The CAAO paper calls it `config.json`; opencode requires the name
`opencode.json`.

---

## 1. `capabilities.yaml` — the capability registry

```yaml
version: 1

phases:            # name -> rank, used to layer the DAG
  analysis: 10
  plan: 20
  build: 30
  verify: 40
  validate: 50
  deliver: 60
  escalate: 70

defaults:
  confidence_floor: 0.70
  context: touched
  parallelizable: true
  mutates: false

capabilities:
  planning:
    title: Planning
    intent: Decompose a request into an executable dependency graph of independent units of work.
    phase: plan
    context: repo-wide
    parallelizable: false
    confidence_floor: 0.75
    requires: []
    may_request: [research]
    outputs: [dag, subtasks, risks]
    worker:
      objective: Produce a minimal dependency graph, never a linear script.
      checklist:
        - Split the work into units that can genuinely run in parallel.
        - Declare inputs, outputs and dependencies for every unit.
        - Never implement anything.
      output_contract: subtasks[{id,title,capability,depends_on,inputs,outputs}], risks, confidence
```

### Field reference

| Field | Type | Meaning |
| --- | --- | --- |
| `title` | string | Human label, used in the DAG rendering and in the worker prompt. |
| `intent` | string | One sentence describing the purpose. Injected into the worker brief. |
| `phase` | phase id | Determines position in the graph. Must exist in `phases`. |
| `context` | `diff` \| `tests` \| `touched` \| `repo-wide` | How much repository context the worker receives. |
| `parallelizable` | bool | `false` makes the node a barrier — it gets its own layer. |
| `mutates` | bool | `true` grants the generated agent `write`/`edit`/`patch` and makes it a merge contributor. |
| `confidence_floor` | 0–1 | Below this, the retry ladder fires. |
| `requires` | capability ids | Extra hard edges beyond the phase ordering. |
| `may_request` | capability ids | Capabilities this worker may pull in via `request_capabilities`. |
| `outputs` | strings | Declared artefacts, documentation only. |
| `worker.objective` | string | The worker's single mission statement. |
| `worker.checklist` | strings | Rendered as a mandatory checklist in the brief. |
| `worker.output_contract` | string | The exact shape the worker must return. |

### The 15 capabilities

| id | phase | mutates | parallel | floor | Purpose |
| --- | --- | --- | --- | --- | --- |
| `triage` | triage | – | ✗ | 0.50 | Understand what the developer actually means, before any work is planned. |
| `research` | analysis | – | ✓ | 0.60 | Resolve unknowns before deciding. |
| `planning` | plan | – | ✗ | 0.75 | Produce the subtask DAG. |
| `implementation` | build | ✓ | ✓ | 0.70 | Make the change. |
| `migration` | build | ✓ | ✗ | 0.85 | Reversible data/schema moves. |
| `refactoring` | build | ✓ | ✓ | 0.75 | Change structure, not behaviour. |
| `optimization` | build | ✓ | ✓ | 0.75 | Change performance, not behaviour. |
| `debugging` | build | ✓ | ✓ | 0.70 | Find and remove a root cause. |
| `testing` | verify | ✓ | ✓ | 0.75 | Prove the change. |
| `review` | validate | – | ✓ | 0.70 | Correctness and maintainability. |
| `security` | validate | – | ✓ | 0.85 | Adversarial review. |
| `architecture` | validate | – | ✓ | 0.75 | Boundaries and coupling. |
| `performance` | validate | – | ✓ | 0.75 | Runtime cost of the change. |
| `documentation` | deliver | ✓ | ✓ | 0.60 | Make the change discoverable. |
| `advisor` | escalate | – | ✗ | 0.50 | Decide what to do when the system is stuck. |

`triage` is special: it never becomes a DAG node. The Execution Manager runs it *before* planning and
feeds its verdict into `caao_plan`. Its output contract is a single JSON object:

```json
{"intent": "debug", "complexity": "high", "domains": ["auth"],
 "rationale": "...", "ambiguities": [], "confidence": 0.87}
```

---

## 2. `providers.yaml` — the provider registry

```yaml
defaults:
  strategy: balanced
  timeout_ms: 300000
  max_attempts: 2

strategies:                       # how to rank candidates; "-" means descending
  fastest:            { rank_by: [-speed, cost] }
  cheapest:           { rank_by: [cost, -speed] }
  highest_reasoning:  { rank_by: [-reasoning, -quality] }
  highest_quality:    { rank_by: [-quality, -reasoning] }
  balanced:           { rank_by: [-quality, cost] }
  declared:           { rank_by: [] }        # keep the author's order

pools:
  opus-5:
    tier: heavy                   # heavy = slow, expensive, smart
    model: omniroute/github/claude-opus-5
    traits: { reasoning: 5, quality: 5, speed: 2, cost: 5 }
    temperature: 0.1
    context_limit: 200000
  kimi-code:
    tier: standard                # standard = fast and cheap
    model: omniroute/github/kimi-k2.7-code
    traits: { reasoning: 3, quality: 4, speed: 5, cost: 1 }
    temperature: 0.2
    context_limit: 131000

profiles:                         # a named *set* of models, not a single one
  heavy: { strategy: highest_reasoning, candidates: [opus-5, kimi-code] }
  fast:  { strategy: fastest,           candidates: [kimi-code, opus-5] }

bindings:
  planning:
    strategy: highest_reasoning
    candidates: [opus-5, kimi-code]

  implementation:
    strategy: balanced
    candidates: [kimi-code, opus-5]
    overrides:                    # first match wins, evaluated against the signals
      - when: { understanding: [uncertain, guessed] }
        profile: heavy
        reason: the request was not understood confidently — do not let a fast model guess
      - when: { complexity: critical }
        profile: heavy
        reason: critical blast radius outweighs latency and cost
      - when: { touches: [crypto] }
        profile: heavy
        reason: cryptographic code is not a place to save money
```

**How resolution works.** `candidates` are ranked with the strategy's `rank_by` over the pool traits.
The winner executes; the rest become the fallback chain, in order.
`resolveProvider(cfg, cap, {attempt, signals})` returns the *n*-th entry, which is exactly what the
retry ladder's `switch_provider` step consumes.

**Overrides** are checked before ranking is committed. The first `when` that matches wins; its target is
either a named `profile` or an inline `candidates` list (with an optional `strategy`). The `reason`
string is mandatory in spirit and is reproduced verbatim in the attribution recap, so nobody has to
guess why an expensive model was used.

### Pool fields

| Field | Meaning |
| --- | --- |
| `tier` | `heavy` or `standard`. Documentation for humans and grouping for the recap. |
| `model` | `provider/model` as declared in `opencode.json`. **The only place a model is named.** |
| `traits` | integers 1–5, fed to `rank_by`. Add your own and reference them in a new strategy. |
| `temperature`, `context_limit` | passed through to the generated agent. |

### Adding a second heavy model

```yaml
pools:
  gpt-5:
    tier: heavy
    model: omniroute/github/gpt-5
    traits: { reasoning: 5, quality: 5, speed: 3, cost: 4 }
    temperature: 0.1

profiles:
  heavy: { strategy: highest_reasoning, candidates: [opus-5, gpt-5, kimi-code] }
```

Then `npm run caao:sync`. Nothing else in the system changes: new agent variants are generated, the
ranking strategy decides between the heavy models, and every escalation now has a real choice.

Traits are yours to define — add `context` or `tool_use` and reference it in a new strategy.

> Every capability **must** have a binding, and every pool referenced by a binding, profile or override
> **must** exist. `config.js` refuses to load otherwise.

### 2.x Pricing and budgets

Money lives in `providers.yaml` too, but strictly apart from routing:

```yaml
pools:
  opus-5:
    traits: { cost: 5, reasoning: 5 }   # abstract 1–5 — the router ranks with this
    pricing:                             # USD per million tokens — the ledger bills with this
      input_per_mtok: 15.00
      output_per_mtok: 75.00

defaults:
  currency: USD
  pricing: { input_per_mtok: 0, output_per_mtok: 0 }
  cached_multiplier: 0.1                # cached input costs a tenth of fresh input

budgets:
  monthly_total: 5000
  per_repo_monthly: 800
  per_run: 5.00
  warn_at: 0.80
```

Two rules make this safe:

1. **The router never reads `pricing`.** Rewiring engineering quality every time a vendor changes a
   price list is not a feature. Intent (`traits`) and cost (`pricing`) are separate inputs.
2. **Budgets never refuse work.** They colour the console amber or red. An orchestrator that quietly
   degrades at month-end is worse than one that reports honestly.

A pool with no `pricing` block bills zero and is reported as *unpriced* rather than free.
Full treatment in [docs/06-dashboard.md](06-dashboard.md#3-the-cost-model).

---

## 3. `policies.yaml` — the policy engine

### 3.1 The `when` mini-language

Implemented in [match.js](../.opencode/caao/match.js). Top-level keys are ANDed.

| Form | Example | Meaning |
| --- | --- | --- |
| list signal | `intent: [debug, refactor]` | signal value ∈ list |
| list signal | `understanding: [uncertain, guessed]` | signal value ∈ list |
| list signal | `touches: [auth]` | list signal contains the value |
| numeric | `changed_files: { gt: 20 }` | `gt`, `gte`, `lt`, `lte`, `eq`, `neq` |
| numeric | `classification_confidence: { lt: 0.40 }` | an **absent** numeric signal never satisfies a comparison |
| keywords | `keywords: [oauth, sso]` | **any** keyword matches the text |
| keywords | `keywords_all: [rename, test]` | **all** keywords match |
| composition | `any: { ... }` | at least one sub-condition |
| composition | `all: { ... }` | every sub-condition |
| composition | `not: { ... }` | negation |
| always | `always: true` | unconditional (fallback rules) |

### Available signals

| Signal | Type | Values |
| --- | --- | --- |
| `intent` | list | `document` `migrate` `optimize` `refactor` `debug` `research` `rename` `implement` |
| `complexity` | list | `trivial` `medium` `high` `critical` |
| `touches` | list | `auth` `payments` `crypto` `database` `public_api` `infrastructure` `frontend` `tests` |
| `understanding` | list | `confident` `probable` `uncertain` `guessed` `keywords-only` |
| `classification_confidence` | numeric | `0.00`–`1.00`, or absent when no triage verdict was supplied |
| `changed_files` | numeric | integer |
| `capabilities` | list | the capability set built so far (augment stage only) |

Keyword matching is word-boundary based, and multi-word phrases tolerate arbitrary whitespace
(`slow query` matches `slow   query`). It never matches inside a longer word.

### 3.2 `classification`

```yaml
classification:
  intents:                       # first match wins
    - id: document
      keywords: [document, documentation, readme, changelog, docstring, api docs, adr, tutorial, guide]
    - id: implement
      default: true

  complexity:                    # first match wins
    - id: critical
      any:
        keywords: [monolith, rearchitect, entire codebase, whole system, rewrite, multi-service]
        changed_files: { gt: 50 }
    - id: trivial
      all:
        keywords: [rename, typo, whitespace, reformat, comment, bump version, constant]
        changed_files: { lte: 2 }
    - id: medium
      default: true

  domains:                       # all matches apply
    auth:
      keywords: [oauth, auth, authentication, jwt, token, session, password, credential]
      paths: ["**/auth/**", "**/*auth*", "**/login/**", "**/session/**"]
```

Domains match against **both** the request text and the changed file paths — so editing
`src/billing/invoice.ts` triggers the `payments` domain even if the request never says "billing".

#### `classification.semantic` — fusing the two layers

The keyword rules above produce a **prior**. The `triage` worker produces a **verdict** with a
self-reported confidence. This block declares, without touching any code, how much you trust it:

```yaml
classification:
  semantic:
    enabled: true
    complexity_order: [trivial, medium, high, critical]
    bands:
      - { id: confident, min: 0.80, adopt: semantic }
      - { id: probable,  min: 0.60, adopt: conservative }
      - { id: uncertain, min: 0.40, adopt: conservative, raise_complexity: 1 }
      - { id: guessed,   min: 0.00, adopt: keywords,     raise_complexity: 1 }
    domains: union
    on_disagreement: conservative
```

| Key | Meaning |
| --- | --- |
| `enabled` | `false` restores pure keyword classification. |
| `bands` | Evaluated top to bottom; the first band whose `min` is met wins. |
| `adopt: semantic` | Take the model's intent **and** complexity. |
| `adopt: conservative` | Take the model's intent, keep the **higher** of the two complexities. |
| `adopt: keywords` | Discard the model's reading entirely. |
| `raise_complexity` | Bump the final complexity *n* steps up `complexity_order`. |
| `domains` | `union` (recommended) or `semantic`. |
| `on_disagreement` | Adoption mode used when the two layers disagree on intent and the band is not `confident`. |

This is the control surface: **move a `min` and you change how eagerly the system spends a heavy model**,
because `understanding` feeds directly into the provider overrides in `providers.yaml`.

Two policies convert poor understanding into behaviour:

```yaml
augment:
  - id: unclear-request
    when: { understanding: [uncertain, guessed] }
    capabilities: [planning]
    reason: a request the system did not understand is decomposed before it is executed
  - id: understanding-collapsed
    when: { classification_confidence: { lt: 0.40 } }
    capabilities: [review]
    reason: work derived from a guessed interpretation is never delivered unreviewed
```

### 3.3 `base` — exclusive, first match wins

| id | when | capabilities |
| --- | --- | --- |
| `doc-only` | intent `document` | documentation |
| `trivial-change` | intent `rename` **or** complexity `trivial` | implementation |
| `defect` | intent `debug` | implementation, testing |
| `optimization` | intent `optimize` | planning, implementation, performance |
| `migration` | intent `migrate` | planning, migration, review |
| `large-refactor` | intent `refactor` + complexity `critical` | planning, refactoring, architecture, performance |
| `refactor` | intent `refactor` | planning, refactoring, review |
| `investigation` | intent `research` | research, planning |
| `critical-work` | complexity `critical` | planning, implementation, review, architecture |
| `high-complexity` | complexity `high` | planning, implementation, review |
| `medium-complexity` | complexity `medium` | implementation, review |
| `fallback` | always | implementation |

### 3.4 `augment` — additive, run to fixpoint

| id | when | adds | reason |
| --- | --- | --- | --- |
| `touches-auth` | touches `auth` | security | authentication surface requires an adversarial review |
| `touches-payments` | touches `payments` | security, architecture | money-handling code requires security and structural review |
| `touches-crypto` | touches `crypto` | security | cryptographic material must never be reviewed by the author only |
| `wide-change` | `changed_files > 20` | architecture | a change this wide can silently break module boundaries |
| `very-wide-change` | `changed_files > 60` | architecture, performance | repository-scale changes need structural and runtime validation |
| `public-contract` | touches `public_api` | documentation | a public contract that is not documented does not exist |
| `infrastructure` | touches `infrastructure` | architecture, security | infrastructure changes have blast radius beyond the repository |
| `migration-safety` | **capabilities contains `migration`** | testing | never ship an unverified migration |
| `mutating-work-needs-proof` | complexity high/critical **and** capabilities contains `implementation` | testing | non-trivial implementations must be proven |

The last two read the capability set itself. That self-reference is why the loop runs to a fixpoint and
why composition rules do not need a hand-written pipeline.

`reason` is not decoration — it is copied into the run's `policyTrace` and is what the Execution Manager
reports back to the developer.

### 3.5 `post` — evaluated on every recorded result

| id | when | adds | escalate |
| --- | --- | --- | --- |
| `low-confidence` | `confidence < 0.60` | advisor | – |
| `collapsed-confidence` | `confidence < 0.40` | advisor | ✓ run becomes `needs_human` |
| `blocking-findings` | `findings_blocking >= 1` | implementation | – |

---

## 4. `workflows.yaml` — execution strategies

```yaml
default: dag

selection:                       # first match wins
  - id: direct
    when: { capability_count: { lte: 1 } }
    strategy: direct
  - id: swarm
    when: { any: { complexity: [critical], capability_count: { gte: 5 } } }
    strategy: swarm
  - id: dag
    when: { always: true }
    strategy: dag
```

| Strategy | parallel | max_parallel | expand_plan | expand_limit | merge |
| --- | --- | --- | --- | --- | --- |
| `direct` | ✗ | 1 | ✗ | – | passthrough |
| `sequential` | ✗ | 1 | ✗ | – | sequential-apply |
| `dag` | ✓ | 6 | ✓ | – | sequential-apply |
| `swarm` | ✓ | 8 | ✓ | 40 | sequential-apply |

`max_parallel` is a budget, not a target. The engine never dispatches more than
this many workers at once; how many it *can* dispatch is decided by the shape of
the graph, described next.

### Shaping the graph: `execution.phase_depends_on`

This is the single most important lever on how fast a run completes. A phase does
not wait for "the previous phase" — it waits for exactly the phases you declare
it consumes the output of.

```yaml
execution:
  phase_order: [triage, analysis, plan, build, verify, validate, deliver, escalate]
  phase_depends_on:
    triage:   []
    analysis: []
    plan:     [analysis]
    build:    [plan]
    verify:   [build]          # tests read the build
    validate: [build]          # reviews read the same build
    deliver:  [build, verify, validate]
  worker_isolation: true       # workers never talk to each other
```

Because `verify` and `validate` both declare `[build]` and neither declares the
other, testing and the reviews are siblings: they start at the same moment
instead of queueing. That one line is what turns a four-wave run into a two-wave
run.

Rules the loader enforces, so a bad edit fails at startup rather than at runtime:

- every phase used by a capability must appear in `phase_order`;
- a phase may only depend on a phase that runs earlier in `phase_order` — a
  backwards or circular dependency is rejected;
- if none of a phase's declared dependencies are present in a given run, it falls
  back to the closest preceding phase that is, so a capability can never start
  before the context it needs exists.

Tightening the graph is equally declarative: give `validate` `[build, verify]`
and the reviews will wait for the tests again.

### Other sections

```yaml
confidence:
  accept: 0.80
  review: 0.60
  escalate: 0.40

retry:
  max_attempts: 2
  on: [error, timeout, low_confidence]
  ladder:
    - { action: retry_same_provider, reason: transient failures are the most common cause }
    - { action: switch_provider,     reason: use the next candidate from the provider fallback chain }
    - { action: escalate,            reason: hand the decision to the advisor capability }

merge:
  strategy: sequential-apply
  order_by: [phase, node_id]
  conflict: escalate             # escalate | last-write-wins | abort
  detect:
    - same_file_touched_by_multiple_nodes
    - contradictory_public_signature_change
    - test_and_implementation_disagreement

context:
  scopes:
    diff:      { include: [diff, node_inputs] }
    tests:     { include: [diff, test_files, node_inputs] }
    touched:   { include: [node_files, neighbours, node_inputs] }
    repo-wide: { include: [repo_map, conventions, node_inputs] }
  budget:
    max_files_per_worker: 25
    max_bytes_per_worker: 240000

validation:
  gates:
    review:       { blocking: true,  on_fail: reopen_build }
    security:     { blocking: true,  on_fail: reopen_build }
    architecture: { blocking: true,  on_fail: escalate }
    performance:  { blocking: false, on_fail: annotate }
    testing:      { blocking: true,  on_fail: reopen_build }
  max_reopen_cycles: 2
```

---

## 5. `opencode.json` — runtime provider

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "omniroute": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:20128/v1", "apiKey": "..." },
      "models": {
        "github/claude-opus-5": {},
        "github/kimi-k2.7-code": {}
      }
    }
  }
}
```

The plugin sets the default model from the `planning` binding, so `opencode` starts on the
highest-reasoning pool without a hardcoded value.

> Write this file **without a UTF-8 BOM**. Windows PowerShell's `Set-Content -Encoding utf8` adds one,
> and `JSON.parse` rejects it.

---

## 6. Startup validation

`config.js` cross-validates all four registries and throws
`CAAO configuration is invalid:\n- ...` when it finds:

- a capability whose `phase` is not declared in `phases`
- a `requires` / `may_request` pointing at an unknown capability
- a capability with **no** provider binding
- a binding using an unknown strategy or an unknown pool
- a policy selecting a capability that does not exist
- a workflow selection rule pointing at a missing strategy

Misconfiguration therefore fails at boot, never halfway through a run. A unit test asserts this against
[tests/fixtures/broken](../tests/fixtures/broken).

---

## 7. `catalog.yaml` — central MCP and skill distribution

Optional. A workspace without it is still valid; the console simply shows an empty catalog.

```yaml
mcp:
  - id: postgres-readonly
    title: Postgres (read-only)
    kind: local                                  # local | remote
    enabled: true
    scope:
      repos: [acme/billing-service]              # all | {repos: []} | {teams: []}
    owner: data-platform
    version: "0.9.2"
    command: ["npx", "-y", "@modelcontextprotocol/server-postgres", "{env:STAGING_DATABASE_URL}"]

skills:
  - id: acme-security-baseline
    enabled: true
    scope: all
    capabilities: [security, review, implementation]
    file: skills/acme-security-baseline.md
```

| Field | Applies to | Meaning |
| --- | --- | --- |
| `kind` | mcp | `local` requires `command`; `remote` requires `url` |
| `scope` | both | `all`, or `{repos: [...]}` / `{teams: [...]}` — a machine matches if **either** list matches |
| `enabled` | both | `false` retires an entry: out of every manifest, still visible with its history |
| `file` | skills | path to the skill markdown, relative to `.opencode/` |
| `capabilities` | skills | which CAAO capabilities the skill informs |
| `{env:NAME}` | both | a *reference* to an environment variable — secrets are never stored here |

`validateCatalog()` runs as part of config loading and rejects duplicate ids, a `local` entry with no
command array, a `remote` entry with no url, a skill with no file, and an invalid scope.

Full treatment in [docs/06-dashboard.md](06-dashboard.md#7-central-mcp-and-skill-distribution).

---

Next: [03 — Orchestration tools](03-tools.md)
