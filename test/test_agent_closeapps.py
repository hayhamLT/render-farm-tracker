"""An app left open is closed before its install; the Maxon App is reopened after (agent 2.51.0).

    /usr/bin/python3 -m unittest test/test_agent_closeapps.py        (Apple's 3.9, what the Macs run)

Rollout 21 (2026-10-14): the Maxon App 2027 installer stopped with "The application Maxon is still running ... Abort"
on 15 of 30 machines, every retry the same. Mike: "close any open app to update if needed".
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("render_agent", os.path.join(HERE, "..", "agents", "render_agent.py"))
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


class CloseApps(unittest.TestCase):
    def setUp(self):
        self.running = set()
        self.closed, self.reopened = [], []
        self._saved = {k: getattr(agent, k) for k in ("_proc_running", "_close_app", "_gpu_rendering", "_reopen_maxon_app", "_run_job_inner")}
        agent._proc_running = lambda names: any(n in self.running for n in names)
        agent._close_app = lambda names: (self.closed.extend(names), self.running.difference_update(names))
        agent._gpu_rendering = lambda: False
        agent._reopen_maxon_app = lambda: (self.reopened.append(True), True)[1]
        agent._CLOSED[:] = []

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(agent, k, v)
        agent._CLOSED[:] = []

    def test_the_maxon_app_is_closed_for_its_install_and_reopened_after(self):
        self.running.add(agent.MAXON_APP_GUI[0])
        self.assertEqual(agent.prepare_for_install("maxonapp"), (True, ""))
        self.assertIn(agent.MAXON_APP_GUI[0], self.closed)
        agent.reopen_closed()
        self.assertEqual(self.reopened, [True])
        agent.reopen_closed()                                        # once only
        self.assertEqual(self.reopened, [True])

    def test_a_render_still_defers_the_install_and_nothing_is_closed(self):
        render = agent._blockers("maxonapp")["render"][0]           # a command-line render
        self.running.update({render, agent.MAXON_APP_GUI[0]})
        ok, note = agent.prepare_for_install("maxonapp")
        self.assertFalse(ok)
        self.assertIn("rendering", note)
        self.assertEqual(self.closed, [])

    def test_a_busy_gpu_defers_even_with_only_the_app_open(self):
        agent._gpu_rendering = lambda: True
        self.running.add(agent._blockers("cinema4d")["gui"][0])
        self.assertFalse(agent.prepare_for_install("cinema4d")[0])
        self.assertEqual(self.closed, [])

    def test_an_open_cinema_4d_or_after_effects_is_closed_and_not_reopened(self):
        c4d = agent._blockers("cinema4d")["gui"][0]
        self.running.add(c4d)
        self.assertTrue(agent.prepare_for_install("cinema4d")[0])
        self.assertIn(c4d, self.closed)
        agent.reopen_closed()
        self.assertEqual(self.reopened, [])                          # a person's app: not put back

    def test_blender_is_never_closed(self):
        self.assertEqual(agent._blockers("blender")["gui"], [])

    def test_the_maxon_app_comes_back_whatever_the_install_did(self):
        def boom(server, job):
            agent._CLOSED.append("maxonapp")
            raise RuntimeError("installer exploded")
        agent._run_job_inner = boom
        with self.assertRaises(RuntimeError):
            agent._run_job(None, {"id": 1})
        self.assertEqual(self.reopened, [True])


if __name__ == "__main__":
    unittest.main()
