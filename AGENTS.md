# Repository Engineering Rules

<!-- repo-discipline:begin -->
## Engineering & Contract Discipline

### Hard Cut & Owner-Clean Architecture
- Maintain one current schema, API, and architecture contract. Avoid compatibility shims, dual read/write paths, legacy fallbacks, or version branches unless the project explicitly requires backward compatibility.
- Compare the quick patch against the long-lived owner-clean route and reject the patch unless a bounded constraint and explicit removal condition are recorded in-repo; never weaken the owning architecture or introduce dormant machinery merely to make a fix or test easier.
- Fail fast when input or persisted state violates the current contract, and update every active producer and consumer in the same change.

### Test & Proof Discipline
- Tests protect settled production contracts at the owning boundary—they do not choose architecture or invent owners (use test-first RED/GREEN only for settled deterministic behavior). Never add production hooks, flags, or APIs whose only consumer is a test harness.
- Every bug fix or concurrency/ordering invariant needs a **deterministic, deletion-sensitive** regression test: it must fail reliably when the fix is removed, without `sleep`, timing luck, or retry loops.
- After a contract cut, derive negative test cases from current constants and boundaries (e.g. `WIDTH - 1`, `WIDTH + 1`) rather than naming deleted fields or keeping legacy blacklists, tombstone registries, or source-substring gates.
- Report exact commands executed and honest residual risks; passing tests are evidence, not proof of absent edge cases.
<!-- repo-discipline:end -->
