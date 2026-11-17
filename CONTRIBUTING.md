# How work happens here

1. **Issue first.** Every piece of work starts as an issue with a milestone and a label. No issue, no code.
2. **Branch per issue.** `test/m1-policy`, `fix/evm-chainid`, `docs/contributing`. Nothing is pushed straight to `main`.
3. **Small pull request.** One issue per PR. The description says what changed, how it was checked, and ends with `Closes #N`.
4. **Checks must pass.** Typecheck and tests run on every PR (see issue #5). A red PR is not merged.
5. **Merge when green.** A PR is squash-merged only after its checks pass; the branch is deleted after merge.
6. **Decisions are written down.** Anything the contracts do not say goes into `DECISIONS.md` in the same PR.
7. **English only.** Code, comments, commits, issues, PRs and docs in this repository are written in English.

## Commit messages

`<type>: <what changed>` — types: `feat`, `fix`, `test`, `docs`, `ci`, `chore`.
Example: `test: M1 boundary vectors for CAP and BUDGET`.

## Never committed

Keys, `.env`, keypair files, local state databases. The pre-commit hook (`scripts/secret-scan.mjs`) refuses them.
