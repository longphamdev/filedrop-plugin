# Feature Intake

Choose the smallest lane that honestly covers blast radius, reversibility, uncertainty, and proof strength. **A label or keyword alone does not force a higher lane—material impact, irreversibility, uncertainty, or weak proof does.**

## Lanes

- **Tiny:** Local, low-risk, reversible, directly verifiable. Patch directly and keep affected docs current.
- **Normal:** Bounded owner and contract, local rollback, clear verification path. A bounded Task Brief is enough; create no ExecPlan unless restart/handoff is needed.
- **High-Risk:** Requires an active ExecPlan (`docs/EXEC_PLAN.md` or `docs/exec-plans/active/`) before implementation.

## Material High-Risk Hard Gates

Classify work as **High-Risk** when it introduces **material** impact in any of:
- Authentication, authorization, privacy, audit, or secret handling
- Data loss, irreversible migration, retention, replay, or crash recovery
- Money, credentials, user-visible delivery, or non-idempotent external side effects
- Coordinated contract cutover or state reset/rebuild
- Runtime ownership, concurrency, lifecycle, or ordering invariants
- Weak proof protecting a real security, data, or external-system claim

## Design Gate

- Before implementation, settle material ownership, behavior, safety, compatibility, or data choices; record constraints, meaningful alternatives, the decision, and likely failure modes—never implementation steps.
- When the claim is about real-world inputs (perception, heuristics, device behavior), the acceptance bar must include real samples from the target environment; look for existing ones before accepting a synthetic-only bar.
- Ask Human whenever requested behavior, destructive scope, or proof weakening remains materially ambiguous; ordinary intake cannot authorize a backward-compatibility shim or dual read/write path.

## Intake Summary Format

```text
Lane: tiny | normal | high-risk
Reason: <material risk or why smaller lane suffices>
Owners: <canonical docs/contracts>
Plan: <active ExecPlan path or none>
Validation: <claim-shaped evidence>
```
