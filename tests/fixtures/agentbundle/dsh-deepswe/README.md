# DeepSWE DSH bundle

This bundle adds a repository task workflow to the DSH harness through its
`system-prompt` component. Evaluator supplies the model, credentials, task
workspace, and independent verification environment at runtime.

The persona tells the agent to commit its work with git, matching the
DeepSWE-Bench collection semantics: only committed changes relative to the
task's base commit are exported as `model.patch` and graded.

The plugin does not contain benchmark answers or install additional tools.
Changes to `plugins/deepswe-guidance/cordis.patch.yml` change the bundle digest.

From the Evaluator repository root:

```powershell
node dist/runtimes/agentbundle/assets/cli.mjs --json verify tests/fixtures/agentbundle/dsh-deepswe --harness-version 0.2.2-rc.1
```
