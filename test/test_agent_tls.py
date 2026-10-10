"""Agent 2.50.0 moves to Farmly's HTTPS (:4443/beacon), its CA pinned and checked.

    /Library/Developer/CommandLineTools/usr/bin/python3 -m unittest test/test_agent_tls.py   (3.9 + LibreSSL 2.8.3: the Macs)
    <python 3.14> -m unittest test/test_agent_tls.py                                        (the PCs' embeddable Python)

Imports agents/render_agent.py as a module (main() does not run). A temporary CA (openssl) signs a certificate for
127.0.0.1; a local HTTPS server stands in for Farmly's relay (401 "bad agent key" on /beacon/agent, its CA on
/api/tls/ca.pem) and a plain-http one for the address the agent reports to now. Launch plists are written in a temp
folder; nothing is relaunched (os.execv / subprocess.Popen / os._exit are recorded), no PowerShell runs, no real port.
"""
import hashlib
import http.server
import importlib.util
import json
import os
import plistlib
import shutil
import ssl
import stat
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agents", "render_agent.py")
OPENSSL = shutil.which("openssl") or "/usr/bin/openssl"


def load_agent():
    spec = importlib.util.spec_from_file_location("render_agent_tls", AGENT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _run(*args, cwd):
    subprocess.run([OPENSSL] + list(args), cwd=cwd, check=True, capture_output=True, timeout=60)


def make_ca(d, name="Farmly test CA"):
    """A CA (keyUsage + SKI: Python 3.13+ is strict) and a server certificate for 127.0.0.1 (SAN, AKI, serverAuth).
    Returns (ca.pem path, leaf pem, leaf key, the CA's SHA-256)."""
    with open(os.path.join(d, "ca.cnf"), "w") as f:
        f.write("[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=%s\n"
                "[v3]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n"
                "subjectKeyIdentifier=hash\n" % name)
    with open(os.path.join(d, "leaf.ext"), "w") as f:
        f.write("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n"
                "subjectAltName=IP:127.0.0.1\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n")
    _run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key", cwd=d)
    _run("req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-config", "ca.cnf", "-out", "ca.pem", cwd=d)
    _run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key", cwd=d)
    _run("req", "-new", "-key", "leaf.key", "-subj", "/CN=lan.renderfarmly.com", "-out", "leaf.csr", cwd=d)
    _run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2",
         "-sha256", "-extfile", "leaf.ext", "-out", "leaf.pem", cwd=d)
    with open(os.path.join(d, "ca.pem"), "rb") as f:
        der = ssl.PEM_cert_to_DER_cert(f.read().decode())
    return os.path.join(d, "ca.pem"), os.path.join(d, "leaf.pem"), os.path.join(d, "leaf.key"), hashlib.sha256(der).hexdigest()


class Relay:
    """Farmly's two listeners as far as an agent sees them: /api/tls/ca.pem (the CA served) on both, /beacon/agent
    answering 401 "bad agent key" (an unauthenticated request) on both."""

    def __init__(self, leaf, leaf_key, ca_bytes):
        self.served_ca = ca_bytes
        self.seen = []
        relay = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                relay.seen.append((self.server.scheme, self.path))
                if self.path == "/api/tls/ca.pem":
                    body, code = relay.served_ca, 200
                elif self.path == "/beacon/agent":
                    body, code = b"bad agent key", 401
                else:
                    body, code = b"{}", 404
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.http.scheme = "http"
        self.https = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.https.scheme = "https"
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(leaf, leaf_key)
        self.https.socket = ctx.wrap_socket(self.https.socket, server_side=True)
        for s in (self.http, self.https):
            threading.Thread(target=s.serve_forever, daemon=True).start()
        self.http_url = "http://127.0.0.1:%d/beacon" % self.http.server_address[1]
        self.https_url = "https://127.0.0.1:%d/beacon" % self.https.server_address[1]

    def close(self):
        for s in (self.http, self.https):
            s.shutdown()
            s.server_close()


class FarmlyHttps(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        try:
            self.ca, leaf, key, self.sha = make_ca(self.dir)
        except (OSError, subprocess.CalledProcessError) as e:
            self.skipTest("no openssl to make a test CA: %s" % e)
        with open(self.ca, "rb") as f:
            self.ca_bytes = f.read()
        self.relay = Relay(leaf, key, self.ca_bytes)
        self.agent = load_agent()
        self.agent.FARM_CA = os.path.join(self.dir, "farm-ca.pem")
        self.said = []
        self.agent.print = lambda *a, **k: self.said.append(" ".join(str(x) for x in a))
        self.plist = os.path.join(self.dir, "com.tracker.agent.plist")
        self.agent._plist_paths = lambda: [self.plist]
        with open(self.plist, "wb") as f:
            plistlib.dump({"Label": "com.tracker.agent", "RunAtLoad": True, "ProgramArguments": [
                "/Library/Developer/CommandLineTools/usr/bin/python3", "/usr/local/tracker/render_agent.py",
                "--server", self.relay.http_url, "--key", "MACHINEKEY", "--interval", "60"]}, f)
        os.chmod(self.plist, 0o600)
        self.relaunched = []
        self.real = (os.execv, os._exit, subprocess.Popen)            # agent.os IS os: restored in tearDown
        self.agent.os.execv = lambda exe, argv: self.relaunched.append(argv)
        self.old_opener = urllib.request._opener
        self.server = self.agent.Server(self.relay.http_url, "MACHINEKEY")

    def tearDown(self):
        urllib.request.install_opener(self.old_opener)
        os.execv, os._exit, subprocess.Popen = self.real
        if hasattr(self, "relay"):
            self.relay.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def args(self):
        with open(self.plist, "rb") as f:
            return plistlib.load(f)["ProgramArguments"]

    def offer(self, sha=None, url=None):
        return {"url": url or self.relay.https_url, "ca_sha256": sha or self.sha}

    def test_moves_to_https_with_the_named_ca_and_rewrites_the_plist_0600_with_the_same_key(self):
        self.agent.IS_MACOS, self.agent.IS_WINDOWS = True, False
        self.assertTrue(self.agent.farm_tls(self.server, self.offer(), 60))
        with open(self.agent.FARM_CA, "rb") as f:
            self.assertEqual(f.read(), self.ca_bytes)
        self.assertEqual(stat.S_IMODE(os.stat(self.agent.FARM_CA).st_mode), 0o644)
        a = self.args()
        self.assertEqual(a[a.index("--server") + 1], self.relay.https_url)
        self.assertEqual(a[a.index("--key") + 1], "MACHINEKEY")
        self.assertEqual(stat.S_IMODE(os.stat(self.plist).st_mode), 0o600)
        self.assertEqual(self.relaunched[-1][self.relaunched[-1].index("--server") + 1], self.relay.https_url)
        self.assertIn(("http", "/api/tls/ca.pem"), self.relay.seen)        # the CA over the http it had
        self.assertIn(("https", "/beacon/agent"), self.relay.seen)         # the probe over https, that CA alone

    def test_a_ca_that_is_not_the_one_named_is_never_trusted_and_nothing_moves(self):
        other = tempfile.mkdtemp()
        try:
            _, _, _, other_sha = make_ca(other, "Someone else's CA")
        finally:
            shutil.rmtree(other, ignore_errors=True)
        self.assertFalse(self.agent.farm_tls(self.server, self.offer(sha=other_sha), 60))
        self.assertFalse(os.path.exists(self.agent.FARM_CA))
        self.assertEqual(self.args()[self.args().index("--server") + 1], self.relay.http_url)
        self.assertEqual(self.relaunched, [])
        # nonsense in the answer: nothing, not even a request
        n = len(self.relay.seen)
        for bad in ({"url": "http://x/beacon", "ca_sha256": self.sha}, {"url": self.relay.https_url, "ca_sha256": "zz"},
                    {"url": self.relay.https_url.replace("/beacon", ""), "ca_sha256": self.sha}, None, "x"):
            self.agent._TLS["switch_after"] = 0
            self.assertFalse(self.agent.farm_tls(self.server, bad, 60))
        self.assertEqual(len(self.relay.seen), n)

    def test_https_that_does_not_answer_keeps_the_agent_where_it_is(self):
        dead = "https://127.0.0.1:%d/beacon" % self._free_port()
        self.assertFalse(self.agent.farm_tls(self.server, self.offer(url=dead), 60))
        self.assertEqual(self.args()[self.args().index("--server") + 1], self.relay.http_url)
        self.assertEqual(self.relaunched, [])
        self.assertFalse(self.agent.farm_tls(self.server, self.offer(), 60))      # not again for TLS_SWITCH_AGAIN_S

    def test_windows_rewrites_every_task_to_https_with_the_same_key(self):
        a = self.agent
        a.IS_MACOS, a.IS_WINDOWS = False, True
        rewrote, spawned = [], []
        a._rewrite_windows_launch = lambda script, srv, key, interval: (rewrote.append((srv, key, interval)) or (True, "TASK:x"))
        a.subprocess.Popen = lambda argv, **kw: spawned.append(argv)

        def leave(code):
            raise SystemExit(code)
        a.os._exit = leave
        with self.assertRaises(SystemExit):
            a.farm_tls(self.server, self.offer(), 60)
        self.assertEqual(rewrote, [(self.relay.https_url, "MACHINEKEY", 60)])
        self.assertEqual(spawned[-1][spawned[-1].index("--server") + 1], self.relay.https_url)

    def test_on_https_every_request_trusts_farmlys_ca_alone(self):
        with open(self.agent.FARM_CA, "wb") as f:
            f.write(self.ca_bytes)
        ctx = self.agent.farm_tls_context()
        self.assertEqual(len(ctx.get_ca_certs()), 1)                     # not the system's store, not Windows'
        self.assertTrue(ctx.check_hostname and ctx.verify_mode == ssl.CERT_REQUIRED)
        self.assertGreaterEqual(ctx.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.agent.install_farm_tls()
        base = self.relay.https_url.rsplit("/beacon", 1)[0]
        with urllib.request.urlopen(base + "/api/tls/ca.pem", timeout=10) as r:   # a plain urlopen: the agent's own
            self.assertEqual(r.read(), self.ca_bytes)
        # a certificate this CA did not sign: refused
        other = tempfile.mkdtemp()
        try:
            other_ca, _, _, _ = make_ca(other, "Another CA")
            shutil.copy(other_ca, self.agent.FARM_CA)
            self.agent.install_farm_tls()
            with self.assertRaises(urllib.error.URLError):
                urllib.request.urlopen(base + "/api/tls/ca.pem", timeout=10)
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_on_https_the_ca_bundle_follows_a_staged_root_over_https_only(self):
        with open(self.agent.FARM_CA, "wb") as f:
            f.write(self.ca_bytes)
        self.agent.install_farm_tls()
        srv = self.agent.Server(self.relay.https_url, "MACHINEKEY")
        other = tempfile.mkdtemp()
        try:
            other_ca, _, _, other_sha = make_ca(other, "The next root")
            with open(other_ca, "rb") as f:
                self.relay.served_ca = self.ca_bytes + f.read()
        finally:
            shutil.rmtree(other, ignore_errors=True)
        self.agent._TLS["ca_at"] = 0
        self.agent.farm_tls(srv, self.offer(), 60)                       # the root that signs is still the old one
        self.assertEqual(sorted(self.agent._held_ca_roots()), sorted([self.sha, other_sha]))
        self.assertNotIn(("http", "/api/tls/ca.pem"), self.relay.seen)   # over https, never http
        self.assertEqual(self.relaunched, [])                            # no move: it is on https already

    def test_the_self_update_code_is_unchanged(self):
        """2.50.0 must not change how an agent updates itself (it ships through config.agentCanary later)."""
        import ast
        with open(AGENT) as f:
            src = f.read()
        tree = ast.parse(src)
        bodies = {f.name: ast.get_source_segment(src, f) for f in ast.walk(tree)
                  if isinstance(f, ast.FunctionDef) and f.name in ("self_update", "update_refusal", "get_agent_code")}
        digest = hashlib.sha256(json.dumps(bodies, sort_keys=True).encode()).hexdigest()
        self.assertEqual(sorted(bodies), ["get_agent_code", "self_update", "update_refusal"])
        self.assertEqual(digest, SELF_UPDATE_SHA, "the self-update code changed: say so loudly, prove it with a version-only bump")

    @staticmethod
    def _free_port():
        import socket
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        p = s.getsockname()[1]
        s.close()
        return p


# The SHA-256 of self_update, update_refusal and Server.get_agent_code as agent 2.49.0 has them.
SELF_UPDATE_SHA = "10fea03f281c0efb0879a922f10c81c26ebd23be10afeb169d8b11ad9eb0de62"


if __name__ == "__main__":
    unittest.main()
