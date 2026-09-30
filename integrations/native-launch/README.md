# Moved to Agent Farm

The native launcher, configuration compiler, tests, and generated dcouple plugin
now live in [dcouple/agent-farm](https://github.com/dcouple/agent-farm).
The plugin's authored configurations live in
[dcouple/skills](https://github.com/dcouple/skills), with the publishing setup in
[PR #114](https://github.com/dcouple/skills/pull/114).

Use the globally installed command from any repository:

```sh
agent-farm profiles list
agent-farm run astra-planner --workspace keycard
agent-farm run implementer --workspace keycard
```

Local configuration lives in ~/.config/agent-farm. No orchestra compatibility
command is installed. Old generated bundles and configuration are retained only
for sessions started before migration. See Agent Farm's README for installation,
configuration, load/unload, inspection, and plugin publishing.
