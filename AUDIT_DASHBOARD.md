# Athena Dashboard — Assurance Surface Audit (Phase 0 + Phase 1)

Adversarial code review of the assurance read/write surface. Method: read each
file in full and cross-check every snake_case→camelCase mapper key against the
backend that actually produces the JSON (`athena-backend/assurance/` —
`serializers.py`, `boundary.py`, `capability.py`, `route.py`, `views.py`,
`decision.py`, `receipt.py`, `models.py`). Findings are ranked and traced with
file:line, a concrete failure scenario, and a minimal fix. Review only — no code
was modified.

## Scope note: the AI-BOM does not exist in this tree

The brief named an `AiBomPanel` (with "Export JSON blob/URL handling") and a
backend `bom.py`. **Neither exists in the current code.**

- `client/src/pages/Assurance.tsx` contains no AI-BOM panel, and a repo-wide grep
  of `client/src` for `AiBom | ai-bom | bill of material | Export |
  createObjectURL | Blob` returns nothing.
- `athena-backend/assurance/` has no `bom.py`, and `urls.py` registers no `bom` /
  `ai-bom` route (routes: deployments, findings, assets, providers,
  provider-assertions, unknowns; plus the deployment detail actions recompute,
  receipt, data-boundary, capabilities, route-map).

So there is **no blob/object-URL export to review, and no BOM mapper to
cross-check.** If an AI-BOM was expected to have landed in this branch, it did
not; that is itself worth flagging to whoever set the scope. Everything below
covers the four panels that DO exist (boundary / capability / route / providers)
plus the deployment/finding/unknown surface.

---

## Severity summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 2 |
| MEDIUM   | 2 |
| LOW      | 3 |

---

## HIGH

### H1 — Manual "Recompute" silently clears an operator's PAUSED failsafe stop and persists it

**Files:** `client/src/pages/Assurance.tsx:1555-1557`;
`server/routes.ts:1625-1649`; `server/assurance.ts:869-893`; backend
`assurance/views.py:86-95` + `assurance/decision.py:42-93`.

**Trace.** The client recompute mutation is hardcoded:

```ts
mutationFn: async (uuid: string) =>
  (await apiRequest("POST", `/api/assurance/deployments/${uuid}/recompute`, { paused: false })).json(),
```

`paused:false` flows through the BFF (`recomputeSchema` default false → 1628,
1631) to the backend, where `recompute_decision(deployment, paused=False)`
**computes from findings and persists** (`decision.py:86-93`,
`deployment.save(update_fields=["decision", ...])`).

The failsafe/ingest path deliberately guards against exactly this. `ingest.py`
refuses to recompute a paused deployment:

```python
# A deployment an operator has PAUSED via the failsafe is left paused — an
# automated re-ingest must not silently clear a human's stop.
if deployment.decision != Deployment.Decision.PAUSED:
    recompute_decision(deployment)
```

The manual recompute button has **no such guard**. An admin who opens Assurance
and clicks "Recompute" on a deployment currently showing "Deployment paused"
overwrites it with a findings-derived decision (e.g. `ready` /
`ready_restricted`) and writes that to the system of record — defeating the very
guard `ingest.py` goes out of its way to honor. The client never even has the
deployment's live failsafe state to pass, so the documented contract of
`recomputeDecision` ("`paused` mirrors the operator failsafe state") is unwired.

**Failure scenario.** Operator pauses a deployment via the failsafe. Later an
admin recomputes decisions from the Assurance page; the paused state is silently
cleared and the deployment now reads deployable. A safety stop disappears with
no audit of intent.

**Minimal fix.** Mirror the ingest guard at the source of truth — in
`DeploymentViewSet.recompute`, preserve PAUSED when the caller did not explicitly
pass `paused=true` (skip the override, or return the existing decision
unchanged). Defense-in-depth on the client: hide/disable the Recompute control
when `d.decision === "paused"`.

### H2 — Two write controls are shown to non-admins (recompute, Unknown disposition); only boundary/provider controls are admin-gated

**Files:** `client/src/pages/Assurance.tsx` — Recompute button at
`1860-1873` (graph) and `2012-2027` (list); `UnknownCard` disposition `<select>`
at `808-824`, rendered at `1953-1960` and `2109-2116`. Contrast the gated
controls: `DataBoundaryPanel` (`admin &&` at 1331, 1434) and `ProvidersRegistry`
(`admin &&` at 540, 551, 625, 654).

**Trace.** `/assurance` is reachable by non-admins (`App.tsx:66` renders it
outside the `admin &&` route guards used for other admin pages). The page threads
`admin` into `ProvidersRegistry` and `DataBoundaryPanel` only. The Recompute
buttons and the Unknown disposition dropdown render unconditionally and, on
click, fire `POST …/recompute` / `PATCH …/unknowns/:uuid` — both `requireAdmin`
on the BFF (`routes.ts:1627`, `1696`) and `_require_admin` on the backend
(`views.py:87`, `313-316`). A non-admin therefore sees live controls that always
fail with a 403 toast ("Changing the assurance record requires an admin role.").

The task's stated rule is that a write must be `requireAdmin` on the route **and**
the client shows the control only to admins. The route side is correct
everywhere; the client side is inconsistent — data-boundary and provider controls
obey it, recompute and unknown-disposition do not.

**Failure scenario.** A non-admin (analyst) opens Assurance, changes an Unknown's
disposition or clicks Recompute, and gets a red error toast. The write is
correctly refused server-side (no privilege escalation), but the UI advertised an
action the user can never take — the exact inconsistency the gating rule exists to
prevent.

**Minimal fix.** Pass `admin` into `UnknownCard` and gate the `<select>` (render
a read-only status label for non-admins); wrap both Recompute buttons in
`admin &&`. Server enforcement already holds, so this is a UX/consistency fix, not
a security patch.

---

## MEDIUM

### M1 — Editing a provider assertion does not invalidate the data-boundary assessment (stale panel)

**Files:** `client/src/pages/Assurance.tsx:1583-1639` (`invalidateProviders` +
the four provider mutations); consumed by `DataBoundaryPanel` query key
`1299-1301`.

**Trace.** The data-boundary flows are computed from each provider's declared
assertions — `region` and `trains_on_data` drive violation/unknown/approved
(`boundary.py:_assess_flow`, 85-130). But the provider create/update/delete
mutations only invalidate `["/api/assurance/providers"]`. The per-deployment
`["/api/assurance/deployments/<uuid>/data-boundary"]` queries are never
invalidated, and the boundary panel carries `staleTime: 30_000`.

**Failure scenario.** Admin records a provider's `region = eu-west-1` (closing an
"unknown"). The Providers list refreshes, but the open DataBoundaryPanel keeps
showing the flow as "Unknown" (or a stale "Violation") for up to 30s / until
remount — the flagship reconciliation misrepresents the boundary immediately
after the fact that would change it. Reverse case (recording a violating region)
is worse: the panel keeps reading "within boundary" briefly.

**Minimal fix.** In the provider-mutation `onSuccess` handlers, also invalidate
the boundary queries, e.g.
`queryClient.invalidateQueries({ predicate: q => String(q.queryKey[0]).includes("/data-boundary") })`.

### M2 — The four computed panels are not lazy; every deployment fetches all three on page load (comments claim otherwise)

**Files:** `client/src/pages/Assurance.tsx:1517` (`collapsed` starts empty →
all expanded), panels mounted at `1876-1903`; panel doc-comments at `881-884`
("Self-fetching (mounted only inside an expanded deployment)"), `1072-1075`,
`1289-1294`.

**Trace.** `collapsed` initializes to `new Set()`, and a card renders its panels
whenever `!isCollapsed`. Since nothing is collapsed by default, opening Assurance
mounts `RouteMapPanel` + `CapabilityPanel` + `DataBoundaryPanel` for **every**
deployment at once — 3×N control-plane round-trips on first paint (each is a
`prefetch_related` query in Django). The panels have no `enabled` guard, so there
is no throttle. The comments describing this as on-demand/lazy are misleading:
loading is on-demand only after a user has manually collapsed cards.

**Failure scenario.** A tenant with 20 deployments issues 60 backend requests on
every Assurance page load / refetch, none of which the reader asked to see.

**Minimal fix.** Default deployments to collapsed (or gate the panels with
`enabled: !isCollapsed`), so a panel fetches only when its card is actually
expanded — matching what the comments already claim. Correct the comments either
way.

---

## LOW

### L1 — AthenaScan severity counts and the rendered findings list come from two sources and can disagree

**Files:** `client/src/pages/AthenaScan.tsx:168-181`, `397-400`, `470-477`.

`counts` (and therefore `totalFindings`, the big total figure and the "View all
findings" gate) come from `scan.test.criticalCount…lowCount`. The findings list
below comes from `scan.engine.findings` filtered to non-internal. These update on
different cadences and cover different sets (info-severity findings appear in the
list but never in `totalFindings`, which sums only crit/high/med/low). While a
scan is running the two can be transiently inconsistent (a list with items but
`totalFindings: 0`, or vice-versa). Not incorrect data, but the page can briefly
show a total that contradicts the list it sits above. Consider deriving the total
from the same list, or labeling the figure as graded-severity count.

### L2 — Shadow-destination React key can collide

**File:** `client/src/pages/Assurance.tsx:1494` —
`key={s.identifier || s.assetName}`. Two shadow destinations with empty
`identifier` and identical `assetName` produce duplicate keys. `boundary.py`
appends one shadow entry per unmanaged data-destination asset, so distinct assets
with a blank identifier and a shared name are possible. Rare; fix by appending
the array index: `key={`${s.identifier || s.assetName}-${i}`}`.

### L3 — Recompute can never represent or restore a paused decision (subset of H1)

Because the mutation is hardcoded to `paused:false` and the client has no access
to the live failsafe state, the Recompute action can only ever push a
findings-derived decision. Even setting H1 aside, there is no path in this UI to
recompute *into* a paused state. Folds into the H1 fix.

---

## Clean bill — verified solid

- **Mapper key fidelity (the main risk area): all correct.** Every
  snake_case→camelCase mapper in `server/assurance.ts` was cross-checked against
  the exact JSON producers:
  - `finding()` ↔ `FindingSerializer` (deployment_uuid, finding_type,
    business_impact, retest_required, evidence_class, asset_uuid, asset_name,
    change_status, change_label, age_days, stale, receipt, first_seen,
    last_seen) — all present, no typos.
  - `deployment()`, `asset()`, `unknown()`, `provider()`, `assertion()`,
    `evidence()`, `receipt()` ↔ their serializers — all keys match, including the
    nested `profile.declared_fields` / `profile.weakest_evidence` and
    `provider_uuid` (UUIDField, serialized as string; mapper uses `strOrNull`).
  - `capabilityMap()` ↔ `capability.py` (capabilities[].{key,label,category,
    description,risk,declared,shadow,sources[]}, categories[].{category,count,
    max_risk}, summary.{total,high_risk,elevated,baseline,declared,shadow}) —
    exact.
  - `mapRouteMap()` ↔ `route.py` (nodes/layers, edges.{source,target,kind,label,
    declared}, unresolved.{agent,tool_identifier}, summary.{node_count,edge_count,
    declared_edges,inferred_edges,shadow_nodes,unresolved_edges,layers_present,
    logs_observed}) — exact.
  - `dataBoundaryAssessment()` ↔ `boundary.py` (declared, policy.{allowed_regions,
    training_allowed,third_party_sharing_allowed,notes,updated_at},
    flows[].{provider_uuid,provider_name,kind,kind_label,assets,region,training,
    status,violations,unknowns}, posture.{value,evidence_class},
    shadow_destinations[].{asset_name,kind,kind_label,identifier}, summary) —
    exact. No silently-undefined field, no `0`/`""` fallback masking a real key.
  - Intentionally-unmapped backend fields (cvss_score, cvss_vector,
    control_mapping) are simply unused, not mis-keyed.
- **Enum vocabularies match the backend.** `DECISION_RANK`, `ASSET_CLASS_ORDER`,
  `UNKNOWN_STATUSES`, `IMPACT_TONE`, and the BFF write enums (EVIDENCE_CLASSES,
  ASSERTION_FIELDS, ASSERTION_SOURCES, PROVIDER_KINDS) were checked value-by-value
  against `models.py` (Decision, Classification, Unknown.Status/Impact,
  EvidenceClass, Provider.Kind, Asset.Kind) — every value lines up, so no control
  offers a choice the backend rejects and no rank map silently collapses to a
  default.
- **Per-panel query keys include the deployment uuid** (embedded in the URL
  string at `883`, `1074`, `1300`), so there is **no stale cross-deployment
  cache** — expanding deployment B never shows A's map.
- **Backend refusal pass-through is correct and consistent.**
  `PASSTHROUGH_STATUS = {400,403,404,409}` is returned verbatim (`{ok:false,
  status, detail}`) for recompute / setDataBoundary / patchUnknown / provider
  writes; the BFF re-emits that exact status (`routes.ts:1639,1671,1707,1774,…`).
  5xx and network failures become `ControlPlaneUnavailable` → 503; reads throw →
  503. Nothing launders a 4xx into a 503.
- **Route-level admin gating is complete.** recompute, data-boundary PUT, unknown
  PATCH, provider POST/PATCH, assertion POST/PATCH/DELETE are all behind
  `requireAdmin` (BFF) and `_require_admin` (backend, independently). (The client
  gap is H2; the server is airtight.)
- **Honesty / "never overstate" holds throughout.** cleared≠fixed (calm emerald
  tone + "no longer reported, NOT fixed"); declared vs inferred edges rendered
  distinctly (`1003-1012`); shadow capabilities/nodes/destinations flagged with
  risk raised, never hidden; unknown≠pass ("a gap to close, never a pass",
  `1379-1381`); provider profile surfaces the *weakest* evidence
  (`max(..., key=evidence_strength)` confirmed in serializers.py + models.py);
  `DecisionPill` renders a null decision as "Not assessed", never green
  (`atoms.tsx:117-131`); the status banner distinguishes unconfigured / unreachable
  / unauthorized / errored (`bannerHeadline`, `714-719`).
- **The four computed panels follow one consistent self-fetching pattern**
  (correct endpoints route-map / capabilities / data-boundary, correct query
  keys, matching loading/error/empty states). The only deviation is
  `DataBoundaryPanel` additionally owning the PUT mutation — correct, it is the
  one writable panel, and it invalidates its own key on success (`1316-1319`).
- **DELETE-assertion mutation correctly does not call `.json()`** on the 204
  (`1629-1632`), avoiding a parse throw; the 201/200 write paths do call it.
- **`pagedRows` / `nextPath`** correctly follow DRF pagination (absolute `next` →
  path+search), stop on a bare array, and cap at `MAX_PAGES` so a runaway `next`
  cannot spin forever.
- **No dead code of note** in the reviewed files: every lucide import in
  `Assurance.tsx` is used; every exported mapper/interface in `assurance.ts` is
  consumed by `routes.ts`; no leftover state or unreachable branch found.
