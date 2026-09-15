import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

INTEGRATION = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION))
import launcher


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.integration = self.root / 'integration'
        self.cache = self.root / 'cache'
        for directory in ('claude/skills', 'claude/agents', 'codex/skills', 'references'):
            (self.repo / directory).mkdir(parents=True)
        self.write('claude/skills/discussion/SKILL.md', 'Read `.references/check.md` and `.claude/agents/reviewer.md`.\n')
        self.write('claude/skills/discussion/references/helper.sh', '#!/bin/sh\necho ok\n')
        (self.repo / 'claude/skills/discussion/references/helper.sh').chmod(0o755)
        self.write('claude/skills/unselected/SKILL.md', 'unselected\n')
        self.write('codex/skills/reviewer/SKILL.md', 'Read `.references/check.md`.\n')
        self.write('claude/agents/reviewer.md', 'Read `.references/check.md`.\n')
        self.write('references/check.md', 'Preserve .codex-dispatches/local and ~/.references/personal.md.\n')
        self.agent = self.integration / 'agents/planner'
        self.agent.mkdir(parents=True)
        (self.agent / 'config.json').write_text(json.dumps({'spec_version': 1, 'name': 'test-planner', 'description': 'Plan', 'prompt': 'Plan the task.', 'skills': 'all', 'tools': {}}))
        (self.agent / 'skills.json').write_text(json.dumps({'claude': ['discussion'], 'codex': ['reviewer']}))

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def build(self, harness='claude', tools=()):
        return launcher.build_bundle('planner', harness, tools, integration=self.integration, repo=self.repo, cache=self.cache)

    def test_shared_sources_and_only_selected_active_skills(self):
        original = (self.repo / 'claude/skills/discussion/SKILL.md').read_bytes()
        bundle = self.build()
        self.assertEqual([p.name for p in (bundle / 'skills').iterdir()], ['discussion'])
        self.assertTrue((bundle / 'agents/reviewer.md').is_file())
        self.assertTrue((bundle / 'support/claude/skills/unselected/SKILL.md').is_file())
        self.assertIn(str(bundle / 'support/references/check.md'), (bundle / 'skills/discussion/SKILL.md').read_text())
        self.assertEqual((bundle / 'support/references/check.md').read_bytes(), (self.repo / 'references/check.md').read_bytes())
        self.assertTrue(os.access(bundle / 'skills/discussion/references/helper.sh', os.X_OK))
        self.assertEqual(original, (self.repo / 'claude/skills/discussion/SKILL.md').read_bytes())
        self.assertEqual(json.loads((bundle / 'config.yaml').read_text())['executor']['config']['harness'], 'claude-native')

    def test_codex_bundle_uses_codex_sources(self):
        bundle = self.build('codex')
        self.assertTrue((bundle / 'skills/reviewer/SKILL.md').is_file())
        self.assertFalse((bundle / '.claude-plugin').exists())
        self.assertIn(str(bundle / 'support/references/check.md'), (bundle / 'skills/reviewer/SKILL.md').read_text())

    def test_cache_reuse_and_source_changes_preserve_previous_bundle(self):
        old = self.build()
        old_content = (old / 'skills/discussion/SKILL.md').read_bytes()
        self.assertEqual(old, self.build())
        self.write('references/check.md', 'New guidance\n')
        new = self.build()
        self.assertNotEqual(old, new)
        self.assertEqual(old_content, (old / 'skills/discussion/SKILL.md').read_bytes())
        self.assertEqual('New guidance\n', (new / 'support/references/check.md').read_text())

    def test_corrupt_cache_is_not_silently_reused(self):
        bundle = self.build()
        (bundle / 'skills/discussion/SKILL.md').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'Cached bundle has changed'):
            self.build()

    def test_extra_active_skill_is_not_silently_reused(self):
        bundle = self.build()
        extra = bundle / 'skills/extra/SKILL.md'
        extra.parent.mkdir()
        extra.write_text('Unexpected skill')
        with self.assertRaisesRegex(ValueError, 'file set has changed'):
            self.build()

    def test_missing_skill_fails_before_cache_write(self):
        (self.agent / 'skills.json').write_text('{"claude": ["missing"]}')
        with self.assertRaisesRegex(ValueError, 'Missing canonical'):
            self.build()
        self.assertFalse(self.cache.exists())

    def test_path_traversal_and_symlink_sources_rejected(self):
        (self.agent / 'skills.json').write_text('{"claude": ["../references"]}')
        with self.assertRaisesRegex(ValueError, 'directory names'):
            self.build()
        (self.agent / 'skills.json').write_text('{"claude": ["discussion"]}')
        (self.repo / 'references/linked.md').symlink_to(self.agent / 'config.json')
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            self.build()

    def test_connections_merge_without_expanding_credentials(self):
        connection = self.root / 'tools.json'
        connection.write_text(json.dumps({'keycard': {'type': 'mcp', 'url': '${KEYCARD_MCP_URL}', 'headers': {'Authorization': 'Bearer ${KEYCARD_MCP_ACCESS_TOKEN}'}}}))
        with patch.dict(os.environ, {'KEYCARD_MCP_ACCESS_TOKEN': 'must-not-be-copied'}):
            bundle = self.build(tools=[connection])
        config = (bundle / 'config.yaml').read_text()
        self.assertIn('${KEYCARD_MCP_ACCESS_TOKEN}', config)
        self.assertNotIn('must-not-be-copied', config)
        with self.assertRaisesRegex(ValueError, 'Duplicate tool'):
            self.build(tools=[connection, connection])


class LaunchTests(unittest.TestCase):
    def test_native_claude_preserves_auth_and_interactive_initial_message(self):
        args = launcher.parser().parse_args(['run', 'claude', '--message', 'Read $HOME; `literal`', '--model', 'sonnet'])
        self.assertEqual(launcher.launch_args(args), ['omni', 'claude', '--server', '', '--use-native-config', '-p', 'Read $HOME; `literal`', '--model', 'sonnet'])

    def test_codex_resume_does_not_turn_into_a_new_task(self):
        args = launcher.parser().parse_args(['run', 'codex', '--resume', 'conv_123'])
        self.assertEqual(launcher.launch_args(args), ['omni', 'codex', '--server', '', '--resume', 'conv_123'])

    def test_bundle_task_explicitly_uses_generic_run(self):
        args = launcher.parser().parse_args(['agent', 'planner', '--harness', 'claude', '--task', 'Plan'])
        self.assertEqual(launcher.launch_args(args, Path('/cache/bundle')), ['omni', 'run', '/cache/bundle', '--server', 'local', '-p', 'Plan'])

    def test_ambiguous_resume_and_blank_message_fail(self):
        for extra in (['--message', ' '], ['--resume', 'conv_123', '--message', 'hello']):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(launcher.main(['run', 'codex', '--dry-run', *extra]), 1)

    def test_agent_cache_cannot_land_in_target_project(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            with patch.dict(os.environ, {'ORCHESTRA_OMNI_CACHE': str(project / 'cache')}), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(launcher.main(['agent', 'planner', '--harness', 'claude', '--project', directory, '--dry-run']), 1)
            self.assertEqual(list(project.iterdir()), [])

    def test_actual_symlink_entrypoint_and_project_argument_forwarding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project with spaces'
            project.mkdir()
            (project / 'AGENTS.md').write_text('Repository owned instructions.\n')
            binary = root / 'omni'
            binary.write_text('#!/usr/bin/env python3\nimport json,os,sys\nif sys.argv[1:] == ["--version"]: print("omnigent 0.13.0")\nelse: print(json.dumps({"argv":sys.argv[1:],"cwd":os.getcwd()}))\n')
            binary.chmod(0o755)
            for name in ('tmux', 'claude'):
                path = root / name
                path.write_text('#!/bin/sh\nexit 0\n')
                path.chmod(0o755)
            entry = root / 'orchestra-omni'
            entry.symlink_to(INTEGRATION / 'bin/orchestra-omni')
            environment = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            result = subprocess.run([str(entry), 'run', 'claude', '--project', str(project), '--message', 'Literal $(hello)'], text=True, capture_output=True, env=environment, check=True)
            payload = json.loads(result.stdout)
            self.assertEqual(payload['cwd'], str(project.resolve()))
            self.assertEqual(payload['argv'][-2:], ['-p', 'Literal $(hello)'])
            self.assertEqual([p.name for p in project.iterdir()], ['AGENTS.md'])

    def test_wrong_runtime_version_fails_before_launch(self):
        result = subprocess.CompletedProcess(['omni', '--version'], 0, 'omnigent 0.12.0\n', '')
        with patch.object(launcher.shutil, 'which', return_value='/bin/stub'), patch.object(launcher.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'requires Omnigent 0.13.0'):
                launcher.check_runtime('codex')


if __name__ == '__main__':
    unittest.main()
