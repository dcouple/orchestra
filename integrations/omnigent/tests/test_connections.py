"""Registry integrity, native ownership, and connection selection regressions."""
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import connections
import native_mcp
import launcher
import test_launcher

PUBLIC = {'type': 'mcp', 'url': 'https://example.com/mcp', 'auth': 'none'}


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'registry.json'

    def test_add_is_atomic_idempotent_and_preserves_other_entries(self):
        self.assertTrue(connections.add_connection('one', PUBLIC, self.path))
        old = self.path.read_bytes()
        self.assertFalse(connections.add_connection('one', PUBLIC, self.path))
        self.assertEqual(self.path.read_bytes(), old)
        connections.add_connection('two', PUBLIC, self.path)
        self.assertEqual(set(connections.read_registry(self.path)), {'one', 'two'})
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_replacement_is_explicit_and_only_changes_one_entry(self):
        connections.add_connection('one', PUBLIC, self.path)
        connections.add_connection('two', PUBLIC, self.path)
        updated = dict(PUBLIC, url='https://example.org/mcp')
        with self.assertRaisesRegex(ValueError, '--replace'):
            connections.add_connection('one', updated, self.path)
        connections.add_connection('one', updated, self.path, replace=True)
        self.assertEqual(connections.read_registry(self.path), {'one': updated, 'two': PUBLIC})

    def test_invalid_secret_bearing_and_unsupported_configs_are_rejected(self):
        for value in [dict(PUBLIC, headers={'Authorization': 'secret'}), dict(PUBLIC, auth='oauth'),
                      *[dict(PUBLIC, url=url) for url in ['http://example.com/mcp',
                         'https://u:secret@example.com/mcp', 'https://example.com/mcp?token=secret',
                         'https://example.com/mcp#secret', 'https://${HOST}/mcp', 'https://x:bad/', 'https://x/\n']]]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                connections.add_connection('one', value, self.path)
        self.assertFalse(self.path.exists())

    def test_missing_duplicates_and_invalid_names(self):
        with self.assertRaisesRegex(ValueError, 'Missing connection'):
            connections.resolve_connections(['one'], self.path)
        with self.assertRaisesRegex(ValueError, 'unique'):
            connections.resolve_connections(['one', 'one'], self.path)
        for name in ['../one', '', 'Upper', 'one-two', 'a'*49]:
            with self.assertRaises(ValueError):
                connections.resolve_connections([name], self.path)
        self.path.write_text('{"one":{},"one":{}}')
        with self.assertRaisesRegex(ValueError, 'Invalid JSON'):
            connections.read_registry(self.path)

    def test_symlink_registry_not_replaced(self):
        target = self.path.parent / 'target'
        target.write_text('{}')
        self.path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            connections.add_connection('one', PUBLIC, self.path)
        self.assertEqual(target.read_text(), '{}')


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {'HOME': self.tmp.name, 'CODEX_HOME': self.tmp.name + '/codex'})
        self.env.start()
        self.addCleanup(self.env.stop)

    def result(self, out='', code=0, err=''):
        return subprocess.CompletedProcess([], code, out, err)

    def actual(self, harness='claude', **kwargs):
        return dict(url=PUBLIC['url'], type='http' if harness == 'claude' else 'streamable_http',
                    enabled=True, custom_auth=False, **kwargs)

    def test_claude_effective_settings_and_scope(self):
        out='orchestra_one:\n  Scope: User config (available in all your projects)\n  Status: Needs authentication\n  Type: http\n  URL: https://example.com/mcp\n'
        with patch.object(native_mcp, '_run', return_value=self.result(out)):
            self.assertTrue(native_mcp.matches('claude', native_mcp.inspect_registration('claude', 'one'), PUBLIC))
        out=out.replace('User config', 'Project config')
        with patch.object(native_mcp, '_run', return_value=self.result(out)):
            self.assertFalse(native_mcp.matches('claude', native_mcp.inspect_registration('claude', 'one'), PUBLIC))

    def test_codex_custom_auth_is_not_overwritten(self):
        out=json.dumps({'enabled':True,'transport':{'type':'streamable_http','url':PUBLIC['url'], 'http_headers':{'Authorization':'secret'}}})
        with patch.object(native_mcp, '_run', return_value=self.result(out)):
            actual=native_mcp.inspect_registration('codex', 'one')
        self.assertNotIn('secret', json.dumps(actual))
        self.assertFalse(native_mcp.matches('codex', actual, PUBLIC))

    def test_native_failure_output_is_not_exposed(self):
        with patch.object(native_mcp, '_run', return_value=self.result('secret-token',1)):
            with self.assertRaises(ValueError) as caught:
                native_mcp.inspect_registration('claude','one')
        self.assertNotIn('secret-token', str(caught.exception))

    def test_conflict_causes_no_mutation_or_login(self):
        with patch.object(native_mcp, 'inspect_registration', return_value=self.actual()) as inspect, patch.object(native_mcp, '_run') as run:
            inspect.return_value['url']='https://different.example/mcp'
            with self.assertRaisesRegex(ValueError,'overwrite'):
                native_mcp.login('claude','one',PUBLIC)
            run.assert_not_called()

    def test_claude_registration_then_login_once(self):
        definition=dict(PUBLIC,auth='native')
        with patch.object(native_mcp,'inspect_registration',side_effect=[None,self.actual()]), patch.object(native_mcp,'_run',return_value=self.result()) as run, contextlib.redirect_stdout(io.StringIO()):
            native_mcp.login('claude','one',definition)
        self.assertEqual(run.call_count,2)
        self.assertEqual(run.call_args_list[0].args[0][:5], ['claude','mcp','add-json','--scope','user'])
        self.assertEqual(run.call_args_list[1].args[0], ['claude','mcp','login','orchestra_one'])

    def test_codex_new_registration_does_not_duplicate_automatic_login(self):
        with patch.object(native_mcp,'inspect_registration',side_effect=[None,self.actual('codex')]), patch.object(native_mcp,'_run',return_value=self.result()) as run, contextlib.redirect_stdout(io.StringIO()):
            native_mcp.login('codex','one',dict(PUBLIC,auth='native'))
        self.assertEqual(run.call_count,1)
        self.assertEqual(run.call_args.args[0],['codex','mcp','add','orchestra_one','--url',PUBLIC['url']])

    def test_existing_codex_login_runs_without_rewriting_registration(self):
        with patch.object(native_mcp,'inspect_registration',return_value=self.actual('codex')), patch.object(native_mcp,'_run',return_value=self.result()) as run, contextlib.redirect_stdout(io.StringIO()):
            native_mcp.login('codex','one',dict(PUBLIC,auth='native'))
        self.assertEqual(run.call_args.args[0],['codex','mcp','login','orchestra_one'])
        self.assertEqual(run.call_count,1)

    def test_public_existing_connection_needs_no_login(self):
        with patch.object(native_mcp,'inspect_registration',return_value=self.actual()), patch.object(native_mcp,'_run') as run, contextlib.redirect_stdout(io.StringIO()):
            native_mcp.login('claude','one',PUBLIC)
        run.assert_not_called()

    def test_private_codex_home_refused(self):
        with patch.dict(os.environ,{'CODEX_HOME':'/tmp/omnigent-codex-home-abcd'}):
            with self.assertRaisesRegex(ValueError,'ordinary terminal'):
                native_mcp.durable_env('codex')


class SelectionTests(unittest.TestCase):
    write = test_launcher.BundleTests.write
    # Reuse the canonical fake repo fixture; these exercise actual bundle generation.
    def setUp(self):
        test_launcher.BundleTests.setUp(self)
        self.registry=self.root/'registry.json'
        connections.add_connection('one',PUBLIC,self.registry)

    def build_selected(self, tools=()):
        return launcher.build_bundle('planner','claude',tools, integration=self.integration,repo=self.repo,cache=self.cache,
                                     connection_names=['one'],connections_file=self.registry)

    def test_selected_metadata_is_recorded_but_not_an_upstream_tool(self):
        bundle=self.build_selected()
        config=json.loads((bundle/'config.yaml').read_text())
        manifest=json.loads((bundle/'orchestra-bundle.json').read_text())
        self.assertNotIn('connections',config)
        self.assertEqual(config['tools'],{})
        self.assertEqual(manifest['connections'],{'one':PUBLIC})
        self.assertEqual(manifest['connection_route'],'native-user-registration')

    def test_registry_change_creates_new_snapshot(self):
        old=self.build_selected()
        connections.add_connection('one',dict(PUBLIC,url='https://different.example/mcp'),self.registry,replace=True)
        new=self.build_selected()
        self.assertNotEqual(old,new)
        self.assertEqual(json.loads((old/'orchestra-bundle.json').read_text())['connections']['one'],PUBLIC)

    def test_double_routing_same_endpoint_is_rejected(self):
        fragment=self.root/'tools.json'
        fragment.write_text(json.dumps({'different_name': {'type':'mcp','url':PUBLIC['url']}}))
        with self.assertRaisesRegex(ValueError,'both native'):
            self.build_selected([fragment])

    def test_agent_defaults_and_duplicate_cli_selection(self):
        config=self.agent/'config.json'
        data=json.loads(config.read_text());data['connections']=['one'];config.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'unique'):
            self.build_selected()
        bundle=launcher.build_bundle('planner','claude',integration=self.integration,repo=self.repo,cache=self.cache,connections_file=self.registry)
        self.assertEqual(json.loads((bundle/'orchestra-bundle.json').read_text())['connections'],{'one':PUBLIC})

class CommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.registry = Path(self.tmp.name) / 'connections.json'
        connections.add_connection('one', PUBLIC, self.registry)

    def test_dry_run_resolves_registry_without_native_access(self):
        with patch.object(launcher, 'inspect_registration') as inspect, patch.object(launcher, 'require_registrations') as require, contextlib.redirect_stdout(io.StringIO()) as out:
            code = launcher.main(['run', 'codex', '--connection', 'one', '--connections-file', str(self.registry), '--dry-run'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())['connections'], {'one': PUBLIC})
        inspect.assert_not_called()
        require.assert_not_called()

    def test_missing_native_registration_prevents_launch(self):
        with patch.object(launcher, 'check_runtime'), patch.object(native_mcp, 'inspect_registration', return_value=None), patch.object(launcher.os, 'execvp') as launch, contextlib.redirect_stderr(io.StringIO()) as err:
            code = launcher.main(['run', 'codex', '--connection', 'one', '--connections-file', str(self.registry)])
        self.assertEqual(code, 1)
        self.assertIn('connections login one --harness codex', err.getvalue())
        launch.assert_not_called()

    def test_check_does_not_claim_authentication_or_login(self):
        with patch.object(launcher, 'inspect_registration', return_value=None), patch.object(launcher, 'login') as login, contextlib.redirect_stdout(io.StringIO()) as out:
            code = launcher.main(['connections', 'check', 'one', '--harness', 'codex', '--connections-file', str(self.registry)])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())['authentication'], 'not verified')
        login.assert_not_called()


if __name__ == '__main__':
    unittest.main()
