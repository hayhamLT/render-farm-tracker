"""Every way out of an install job drops its tracker_job_<id>_* folder; old ones are cleared at start-up (agent 2.50.1).

    /usr/bin/python3 -m unittest test/test_agent_workdirs.py        (Apple's 3.9, what the Macs run)
    <python 3.14> -m unittest test/test_agent_workdirs.py

2026-10-11 sweep: 133 empty folders on AVA-01 (an NVIDIA rollout whose every download hit "No space left on device"),
a 3.2 GB installer on MARS-JUICY, 3 GB on NODE-03 and 1.3 GB on STARK, all from jobs that never reached the installer.
Imports agents/render_agent.py as a module (main() does not run); temp folders are made under a test folder.
"""
import importlib.util
import os
import shutil
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("render_agent", os.path.join(HERE, "..", "agents", "render_agent.py"))
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


class FakeServer:
    def __init__(self, fail_download=None, payload=b"installer bytes"):
        self.reports, self.fail, self.payload = [], fail_download, payload

    def report(self, job_id, status, msg=""):
        self.reports.append((status, msg))

    def download(self, package_id, dest, cancel=None):
        with open(dest, "wb") as f:
            f.write(self.payload)                      # some bytes arrive before it fails, as a real download
        if self.fail:
            raise self.fail


class WorkDirs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._old_tempdir = tempfile.tempdir
        tempfile.tempdir = self.tmp                    # mkdtemp in the job lands here
        self._saved = {k: getattr(agent, k) for k in ("prepare_for_install", "_installed_version", "verify_vendor_signature")}
        agent.prepare_for_install = lambda key: (True, "")
        agent._installed_version = lambda key: "1.0"

    def tearDown(self):
        tempfile.tempdir = self._old_tempdir
        for k, v in self._saved.items():
            setattr(agent, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def left(self):
        return [n for n in os.listdir(self.tmp) if n.startswith("tracker_job_")]

    def job(self, **kw):
        j = {"id": 42, "product_key": "redshift", "version": "2026.9", "kind": "installer", "filename": "rs.exe",
             "package_id": 1, "install_command": "{file} /S"}
        j.update(kw)
        return j

    def test_a_failed_download_leaves_nothing(self):
        srv = FakeServer(fail_download=OSError(28, "No space left on device"))
        agent.run_job(srv, self.job())
        self.assertEqual(self.left(), [])
        self.assertTrue(any(s == "failed" and "Download failed" in m for s, m in srv.reports))

    def test_a_checksum_refusal_leaves_nothing(self):
        srv = FakeServer()
        agent.run_job(srv, self.job(sha256="0" * 64))
        self.assertEqual(self.left(), [])
        self.assertTrue(any("SHA256 mismatch" in m for s, m in srv.reports))

    def test_a_signature_refusal_leaves_nothing(self):
        agent.verify_vendor_signature = lambda path, policy: (False, "not signed by the vendor")
        srv = FakeServer()
        agent.run_job(srv, self.job())
        self.assertEqual(self.left(), [])

    def test_a_check_that_raises_leaves_nothing(self):
        def boom(path, policy):
            raise RuntimeError("the checker broke")
        agent.verify_vendor_signature = boom
        with self.assertRaises(RuntimeError):
            agent._run_job(FakeServer(), self.job())
        self.assertEqual(self.left(), [])

    def test_a_cancel_during_the_download_leaves_nothing(self):
        srv = FakeServer(fail_download=agent.JobCancelled())
        agent.run_job(srv, self.job())
        self.assertEqual(self.left(), [])
        self.assertTrue(any(s == "cancelled" for s, m in srv.reports))

    def test_old_leftovers_are_cleared_at_start_and_nothing_else(self):
        now = time.time()
        old = os.path.join(self.tmp, "tracker_job_589_3t_9xtio")
        new = os.path.join(self.tmp, "tracker_job_900_abcdefgh")
        other = os.path.join(self.tmp, "tracker_sig_abcdefgh")
        mine = os.path.join(self.tmp, "tracker_job_notes")
        for d in (old, new, other, mine):
            os.makedirs(d)
        with open(os.path.join(old, "617.42-desktop.exe"), "wb") as f:
            f.write(b"x" * 1024)
        for d in (old, other, mine):
            os.utime(d, (now - 3 * 86400, now - 3 * 86400))
        gone = agent.sweep_work_dirs(now=now, roots=[self.tmp])
        self.assertEqual(gone, [old])
        self.assertFalse(os.path.exists(old))
        for d in (new, other, mine):                   # a day-old job, another prefix, a name that is not a job's: kept
            self.assertTrue(os.path.isdir(d))


if __name__ == "__main__":
    unittest.main()
