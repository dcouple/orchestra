"""Validate canonical bundles using an installed, pinned Omnigent (no model calls)."""
import importlib.metadata
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launcher import INTEGRATION, OMNIGENT_VERSION, build_bundle
from omnigent.spec import load

assert importlib.metadata.version('omnigent') == OMNIGENT_VERSION
with tempfile.TemporaryDirectory(prefix='orchestra-omni-') as directory:
    for agent in ('planner', 'implementer'):
        for harness in ('claude', 'codex'):
            bundle = build_bundle(agent, harness, [INTEGRATION / 'connections/langfuse-docs.json'], cache=Path(directory))
            spec = load(bundle, expand_env=False)
            assert spec.executor.config['harness'] == f'{harness}-native'
            assert spec.instructions and spec.skills
            assert spec.mcp_servers[0].url == 'https://langfuse.com/api/mcp'
            print(f'{agent}/{harness}: upstream load + validation passed; {len(spec.skills)} skills')
