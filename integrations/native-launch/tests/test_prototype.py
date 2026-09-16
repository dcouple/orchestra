import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import prototype
import runtime

class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();self.root=self.base/'config';self.target=self.base/'repo with spaces';self.target.mkdir()
        (self.root/'agents').mkdir(parents=True);(self.root/'workspaces').mkdir()
        p=self.root/'skills/proof';p.mkdir(parents=True)
        (p/'SKILL.md').write_text('---\nname: proof\ndescription: Test skill\n---\nTEST\n')
        (p/'helper.txt').write_text('SUPPORT')
        (self.root/'agents/planner.yaml').write_text('harness: claude\nmodel: sonnet\nskills: [proof]\nsubagents: {worker: worker}\n')
        (self.root/'agents/worker.yaml').write_text('harness: codex\nmodel: gpt-6-astra\nskills: [proof]\n')
        (self.root/'workspaces/test.yaml').write_text('connections:\n  docs:\n    type: mcp\n    auth: none\n    url: https://example.com/mcp\n')
    def build(self):return prototype.build(self.root,'planner',self.target,'test')
    def test_static_child_and_support_and_reuse(self):
        b=self.build();self.assertEqual(b,self.build())
        self.assertTrue((b/'main/dispatch/worker').exists())
        self.assertEqual((b/'main/worker/skills/proof/helper.txt').read_text(),'SUPPORT')
        manifest=json.loads((b/'manifest.json').read_text())
        self.assertEqual(manifest['nodes']['main/worker']['connections'],manifest['nodes']['main']['connections'])
        self.assertEqual(manifest['directory'],str(self.target))
    def test_changed_skill_leaves_original_bundle_intact(self):
        old=self.build();before=prototype.file_map(old)
        (self.root/'skills/proof/helper.txt').write_text('NEW')
        self.assertNotEqual(old,self.build());self.assertEqual(before,prototype.file_map(old))
    def test_corruption_rejected(self):
        b=self.build();(b/'main/agent.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'modified'):self.build()
    def test_nested_checksums_file_is_protected(self):
        (self.root/'skills/proof/checksums.json').write_text('{}')
        b=self.build();(b/'main/skills/proof/checksums.json').write_text('{"changed":true}')
        with self.assertRaisesRegex(ValueError,'modified'):self.build()
    def test_skill_mapping_rejected_as_invalid_input(self):
        p=self.root/'agents/planner.yaml'
        p.write_text('harness: claude\nmodel: sonnet\nskills: [{source: remote}]\n')
        with self.assertRaisesRegex(ValueError,'unique list'):self.build()
    def test_cycles_and_unknown_fields_fail_before_generation(self):
        p=self.root/'agents/worker.yaml';p.write_text(p.read_text()+'subagents: {parent: planner}\n')
        with self.assertRaisesRegex(ValueError,'cycle'):self.build()
        p.write_text('harness: codex\nmodel: test\nmax_calls: 2\n')
        with self.assertRaisesRegex(ValueError,'Unsupported'):self.build()
        self.assertFalse((self.target/'.orchestra').exists())
    def test_conflicting_inline_connections_fail(self):
        p=self.root/'agents/planner.yaml';p.write_text(p.read_text()+'connections:\n  docs:\n    type: mcp\n    auth: none\n    url: https://different.example/mcp\n')
        with self.assertRaisesRegex(ValueError,'Conflicting'):self.build()
    def test_secret_url_and_missing_skill_rejected(self):
        with self.assertRaises(ValueError):prototype.connections({'key':{'type':'mcp','auth':'native','url':'https://x/mcp?token=secret'}})
        (self.root/'skills/proof/SKILL.md').unlink()
        with self.assertRaisesRegex(ValueError,'Missing'):self.build()
    def test_claude_argv_keeps_working_directory_and_literal_message(self):
        b=self.build();argv,env,cwd=runtime.command(b,'main',message='$(not-a-command)',prepare=False)
        self.assertEqual(cwd,str(self.target));self.assertIn('--plugin-dir',argv)
        self.assertEqual(argv[-2:],['--','$(not-a-command)'])
        self.assertTrue(any(str(b/'main/dispatch/worker') in a for a in argv))
    def test_codex_home_references_auth_without_copying_payload(self):
        b=self.build();home=self.base/'home';original=home/'.codex';original.mkdir(parents=True)
        (original/'auth.json').write_text('SECRET-FIXTURE')
        (original/'config.toml').write_text('')
        with patch.dict(os.environ,{'HOME':str(home),'CODEX_HOME':str(original)},clear=True):
            argv,env,cwd=runtime.command(b,'main/worker')
        auth=Path(env['CODEX_HOME'])/'auth.json'
        self.assertTrue(auth.is_symlink());self.assertEqual(auth.resolve(),original/'auth.json')
        self.assertFalse(any('SECRET-FIXTURE' in p.read_text() for p in b.rglob('*') if p.is_file()))
        self.assertIn('--cd',argv);self.assertEqual(cwd,str(self.target))
    def test_profile_coexistence_does_not_edit_repo_instructions(self):
        (self.target/'AGENTS.md').write_text('ORIGINAL')
        first=self.build();second=prototype.build(self.root,'worker',self.target,'test')
        self.assertNotEqual(first,second);self.assertTrue(first.exists())
        self.assertEqual((self.target/'AGENTS.md').read_text(),'ORIGINAL')

if __name__=='__main__':unittest.main()
