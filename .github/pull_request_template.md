<!-- The PR title becomes the squash-merge commit and drives the release:
     feat: = minor, fix:/perf:/deps: = patch, `!` or BREAKING CHANGE = minor while 0.x.
     chore/docs/ci/test/build/refactor do not release. -->

## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How it was verified

<!-- Commands you ran and what you observed. For bench/adapter changes, a real run counts for more than unit tests. -->

## Checklist

- [ ] `pnpm lint`, `pnpm build` and `pnpm test` pass
- [ ] Changed source files have at least 90% coverage (`pnpm coverage:changed`)
- [ ] New behavior has tests; bug fixes have a regression test
- [ ] README updated if usage, the skill format or the suite schema changed

## Risks

<!-- Breaking changes to the suite schema, result store or adapter interface; anything that touches how agents are sandboxed. -->
