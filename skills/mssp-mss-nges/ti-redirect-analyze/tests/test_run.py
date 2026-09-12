import base64
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


class RequestException(Exception):
    pass


class SSLError(RequestException):
    pass


class HTTPAdapter:
    def init_poolmanager(self, *args, **kwargs):
        return None


requests_stub = types.ModuleType("requests")
requests_stub.adapters = types.SimpleNamespace(HTTPAdapter=HTTPAdapter)
requests_stub.exceptions = types.SimpleNamespace(SSLError=SSLError)
requests_stub.RequestException = RequestException
requests_stub.Session = object
requests_stub.post = mock.Mock()
sys.modules.setdefault("requests", requests_stub)

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run.py"
SPEC = importlib.util.spec_from_file_location("ti_redirect_run", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response:
    def raise_for_status(self):
        return None

    def json(self):
        key = base64.urlsafe_b64encode(b"public-key-bytes").decode("ascii")
        return {"code": 0, "data": {"token": "temporary&signature", "key": key}}


class TiRedirectTests(unittest.TestCase):
    def test_ioc_validation_preserves_existing_rules(self):
        self.assertEqual(MODULE.validate_ioc("domain", "Example.COM"), "example.com")
        self.assertEqual(MODULE.validate_ioc("ip", "1.2.3.4"), "1.2.3.4")
        with self.assertRaises(ValueError):
            MODULE.validate_ioc("md5", "not-md5")

    def test_key_request_keeps_original_url_body_and_transport_options(self):
        config = {
            "key_url": "https://ti.example.test/key",
            "device_id": "device",
            "source": "source",
            "request_timeout_seconds": 10,
            "verify_ssl": True,
        }
        with mock.patch.object(MODULE.requests, "post", return_value=Response()) as post:
            token, key = MODULE.request_rsa_info(config)
        post.assert_called_once_with(
            "https://ti.example.test/key",
            json={"di": "device", "s": "source"},
            timeout=10,
            verify=True,
        )
        self.assertEqual(token, "temporary")
        self.assertEqual(key, b"public-key-bytes")


if __name__ == "__main__":
    unittest.main()
