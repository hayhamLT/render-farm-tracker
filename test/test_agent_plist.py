"""The agent's launch plist keeps the machine's Farmly key, so it must stay readable by its owner only.

    /usr/bin/python3 -m unittest test/test_agent_plist.py        (Apple's 3.9, what the Macs run)
    <python 3.14> -m unittest test/test_agent_plist.py

Imports agents/render_agent.py as a module (main() does not run) and works on plists in a temp folder.
"""
import importlib.util
import os
import plistlib
import stat
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("render_agent", os.path.join(HERE, "..", "agents", "render_agent.py"))
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


def _mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


def _write(path, args, mode):
    with open(path, "wb") as f:
        plistlib.dump({"Label": "com.tracker.agent", "ProgramArguments": args, "RunAtLoad": True}, f)
    os.chmod(path, mode)


ARGS = ["/usr/bin/python3", "/usr/local/tracker/render_agent.py",
        "--server", "http://10.10.10.55:4400", "--key", "OLDKEY", "--interval", "60"]


class PlistIsPrivate(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.pl = os.path.join(self.dir, "com.tracker.agent.plist")

    def tearDown(self):
        for f in os.listdir(self.dir):
            os.remove(os.path.join(self.dir, f))
        os.rmdir(self.dir)

    def test_rewrite_writes_0600_and_the_new_values(self):
        _write(self.pl, ARGS, 0o600)
        self.assertTrue(agent._rewrite_plist(self.pl, "http://10.10.10.55:4500/beacon", "NEWKEY"))
        self.assertEqual(_mode(self.pl), 0o600)
        with open(self.pl, "rb") as f:
            args = plistlib.load(f)["ProgramArguments"]
        self.assertEqual(args[args.index("--server") + 1], "http://10.10.10.55:4500/beacon")
        self.assertEqual(args[args.index("--key") + 1], "NEWKEY")
        self.assertFalse(os.path.exists(self.pl + ".new"))

    def test_rewrite_tightens_a_world_readable_plist(self):
        _write(self.pl, ARGS, 0o644)   # what agents before 2.49.0 left behind
        agent._rewrite_plist(self.pl, "http://x/beacon", "K2")
        self.assertEqual(_mode(self.pl), 0o600)

    def test_a_left_over_new_file_does_not_keep_its_mode(self):
        _write(self.pl, ARGS, 0o600)
        with open(self.pl + ".new", "wb") as f:
            f.write(b"stale")
        os.chmod(self.pl + ".new", 0o644)
        agent._rewrite_plist(self.pl, "http://x/beacon", "K3")
        self.assertEqual(_mode(self.pl), 0o600)

    def test_private_plist_repairs_only_a_readable_plist_with_a_key(self):
        _write(self.pl, ARGS, 0o644)
        self.assertTrue(agent._private_plist(self.pl))
        self.assertEqual(_mode(self.pl), 0o600)
        self.assertFalse(agent._private_plist(self.pl))        # already private: nothing to do
        nokey = os.path.join(self.dir, "other.plist")
        _write(nokey, ["/usr/bin/python3", "x.py"], 0o644)
        self.assertFalse(agent._private_plist(nokey))
        self.assertEqual(_mode(nokey), 0o644)
        self.assertFalse(agent._private_plist(os.path.join(self.dir, "missing.plist")))

    def test_version_is_2_49_0_or_newer(self):
        self.assertGreaterEqual(agent._version_tuple(agent.AGENT_VERSION), (2, 49, 0))   # the 0600 plists came in 2.49.0


if __name__ == "__main__":
    unittest.main()
