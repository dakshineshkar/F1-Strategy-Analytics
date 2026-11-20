## Summary

<!-- What does this change do, and why? Use a Conventional Commit title, for example "fix(api): …". -->

## Checklist

- [ ] `make lint` and `make typecheck` pass
- [ ] `make test` and `make web-test` pass (and `make test-int` if the lake, Kafka, Redis or Spark code changed)
- [ ] Documentation and `CHANGELOG.md` are updated where the change affects them
- [ ] `results/` is unchanged (it changes only through a `RECORD=1` target), and no frozen spec was edited
- [ ] No secrets: no `.env`, credentials or tokens in the diff
