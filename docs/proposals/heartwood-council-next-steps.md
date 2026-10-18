# Proposal: grimoire-lab next steps for Heartwood

Audience: Heartwood council. Author: grimoire-lab maintainers. Status: for evaluation.
Baseline: `@grimoire/core` 0.2.0 plus unreleased generic command adapter (#29/#30).

## 1. Where we are

The library work in `docs/design/library-api.md` is delivered and usable by Heartwood today:

| Heartwood need | Delivered |
| --- | --- |
| Installable package | ESM `@grimoire/core` with `exports`, `types`, `files`, `engines` (0.1.0) |
| Reproducible skill identity | Content digest, `loadSkillByDigest`, `SkillRef` pinning |
| Pluggable skill stores | `SkillSource` (`dirSource`, `gitSource`); read-only, 2-method interface |
| Rank inputs without rank policy | `SkillEvidence` / `evidenceFor`; core ships no ranks or thresholds |
| Statistical guard for promotion | `Comparison.ci` (Newcombe-Wilson 95%), `requireCiExcludesZero` gate (0.2.0) |
| Throughput and robustness | `concurrency` option, `resumeBench` / `grimoire resume` (0.2.0) |
| Bring-your-own agent | Injected `AgentAdapter`; generic `command` adapter via `--agent-config` (unreleased) |
| Version proposals | `proposeVersion` with an injected `SkillRewriter`; core generates no content |
| Library docs | README section "Using as a library" |

Invariants that every proposal below preserves: core never imports adapters; grimoire-lab never
depends on Heartwood; grimoire-lab reports measurements and never decides ranks or promotions;
the content digest is the identity of a skill.

## 2. Decisions requested from the council

Each proposal lists what it costs, what it unlocks, and which side owns it. The council is asked to
accept, reject, or defer each, and to answer the open questions in section 4.

### P1. Orca-backed `AgentAdapter` (recommended, highest value)

- **What:** an `AgentAdapter` that runs each benchmark trial inside a supervised Orca worker
  (worktree, terminal, transcript capture) instead of a local subprocess.
- **Why:** this is the stated integration path in the design doc: the adapter is injected, so
  `benchSkill` needs no change. It gives Heartwood supervised, isolated, observable trials and
  reuses `concurrency` and `resumeBench` unchanged.
- **Owner/placement:** Heartwood-side, or a separate `@grimoire/adapter-orca` package.
  Not in `@grimoire/core`, because core must not know Orca.
- **Cost:** adapter implementation plus mapping Orca worker results to the adapter result
  contract (final message, status `completed|timeout|error`, optional usage, transcript tool
  events so `skill_loaded` assertions work).
- **Risk:** the `command` adapter has no transcript tool events, so `skill_loaded` fails for it.
  The Orca adapter must emit them or those assertions are unusable.

### P2. Candidate flow: stage, edit by worker, bench (recommended)

- **What:** expose the three-step flow from the design doc: `stageCandidate`, an Orca-run worker
  edits the staged directory, then `benchProposal` compares candidate to baseline.
  `proposeVersion` with a `SkillRewriter` exists today; the worker-driven split lets Heartwood
  supervise the edit step.
- **Why:** keeps core free of any content generator while letting Heartwood own the
  authoring agent.
- **Cost:** small if the existing `propose.ts` pieces are exported separately; verify that staging
  and benching are already separable before committing to a size estimate.
- **Owner:** core for the two library calls, Heartwood for the worker step.

### P3. Minimum-sample and drift gates in `compare` (recommended)

- **What:** an opt-in `requireMinN` gate next to `requireCiExcludesZero`, recorded in
  `comparison.gate`, so a comparison cannot be `significant` on too few trials.
- **Why:** the design doc says cross-run drift with LLM agents is real and that consumers must
  require a minimum `n`. Today that rule lives only in Heartwood's code, where it is easy to
  skip. A core gate makes the safe path the default path.
- **Cost:** small, additive, no `schemaVersion` bump.
- **Policy boundary:** core exposes the knob; the threshold value is Heartwood's.

### P4. Consumer-side integration smoke test (recommended, small)

- **What:** extend `scripts/smoke-consume.mjs` to run the whole path against the packed tarball:
  `dirSource` -> `resolveSkill` -> `benchSkill` (stub adapter) -> `evidenceFor` -> `compareArms`.
- **Why:** the standalone CLI is the integration test per the design; this catches packaging
  regressions (missing `exports`, `files`) that unit tests miss, before Heartwood hits them.
- **Cost:** small.

### P5. Cost and latency evidence (optional)

- **What:** add per-arm tokens, wall time, and cost to `SkillEvidence`, so rank policy can weigh
  lift against cost.
- **Why:** a skill that lifts pass rate 5% at 3x the tokens may not deserve promotion.
- **Cost:** medium. Adapters must report usage; the `command` adapter currently reports none,
  so evidence would be partial for it. Needs an additive, optional schema field.
- **Question:** does any planned rank threshold actually use cost? If not, defer.

### P6. Multi-adapter single run (optional, defer by default)

- **What:** compare agents inside one `BenchResult`. The schema allows it later.
- **Why not now:** the current agent-vs-agent route (separate runs, `compareArms` checking suite
  digest) works, at the price of cross-run drift. Only worth it if Heartwood needs it for agent
  selection.

### P7. Remote source helper (optional, defer by default)

- **What:** a clone helper in front of `gitSource` for URL-based skill sources.
- **Why not now:** the design doc defers it. Callers can clone, then use `gitSource`.
  Heartwood can also implement `SkillSource` for its own stores.

## 3. Proposed sequencing

1. P4 and P3 together: small, no external dependencies, make the contract safe.
2. P1: the unlock. Can begin in parallel with step 1 if Heartwood supplies the Orca worker API.
3. P2: after P1 so the worker edit step and the trial adapter share the same Orca plumbing.
4. 0.3.0 release (minor, may be breaking per version policy) once P1-P4 land.
5. P5-P7 on demand, each needing an explicit consumer request.
6. `1.0.0` when the library API in the design doc is declared stable; semver applies from then.

## 4. Open questions for the council

1. **Placement of the Orca adapter (P1):** Heartwood repo, or a published `@grimoire/adapter-orca`?
   The second makes it reusable but adds a package with an Orca dependency to maintain.
2. **Minimum `n` default (P3):** should core ship a default (it would be a policy choice), or only
   the gate with no default, leaving the value to Heartwood?
3. **Evidence scope (P5):** which signals will rank thresholds actually consume? Anything unused
   should not enter the schema.
4. **API stability:** is the current surface frozen enough that Heartwood wants `1.0.0` soon, or
   should `0.x` flexibility continue while Heartwood integration is in progress?
5. **Transcript tool events:** will the Orca adapter provide them so `skill_loaded` assertions
   work, and in what shape?

## 5. Explicitly out of scope (unchanged)

Ranks, thresholds and promotion policy; composite or weighted scores; a skill registry, remote
publishing or draft storage; any content generation inside core.

## 6. Recommendation

Accept P1-P4. Defer P5-P7 until a concrete Heartwood consumer needs them. Decide the five
questions above before P1 starts, since question 1 and 5 shape its interface.
