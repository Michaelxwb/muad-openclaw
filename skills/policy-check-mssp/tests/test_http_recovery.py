import os
import sys
import unittest
from unittest.mock import MagicMock, patch

import requests

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from shared.http import MSSPRequestError, request, request_json
from shared.session import MSSPSession


def http_error(status: int, body: bytes = b"", content_type: str = "text/html"):
    response = requests.Response()
    response.status_code = status
    response._content = body
    response.headers["Content-Type"] = content_type
    response.url = "http://mssp.internal/gateway/test"
    return requests.HTTPError(f"HTTP {status}", response=response)


class JSONResponse:
    status_code = 200
    headers = {"Content-Type": "application/json"}

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class HTTPRecoveryTest(unittest.TestCase):
    @patch("shared.http.requests.request")
    def test_transport_uses_requests_with_json_body(self, request_call):
        response = MagicMock()
        response.raise_for_status.return_value = None
        request_call.return_value = response

        result = request(
            "sid=old", "POST", "http://mssp.internal/gateway/query",
            headers={"X-Test": "value"}, json={"service_status": 0},
        )

        self.assertIs(result, response)
        request_call.assert_called_once_with(
            "POST", "http://mssp.internal/gateway/query",
            headers=unittest.mock.ANY, json={"service_status": 0}, timeout=30, verify=False,
        )
        sent_headers = request_call.call_args.kwargs["headers"]
        self.assertEqual(sent_headers["X-Test"], "value")

    @patch("shared.http._open")
    def test_http_500_returns_system_response_without_retry(self, open_request):
        open_request.side_effect = http_error(500, b"<h1>openresty</h1>")
        loader = MagicMock(return_value="sid=new")
        session = MSSPSession("sid=old", loader)

        with self.assertRaises(MSSPRequestError) as raised:
            request(session, "POST", "http://mssp.internal/gateway/query", attempts=3)

        self.assertEqual(raised.exception.category, "gateway")
        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(raised.exception.content_type, "text/html")
        self.assertIn("HTTP 500", str(raised.exception))
        self.assertIn("<h1>openresty</h1>", str(raised.exception))
        self.assertEqual(open_request.call_count, 1)
        loader.assert_not_called()
        self.assertEqual(session.cookie, "sid=old")

    @patch("shared.http._open")
    def test_http_error_redacts_sensitive_system_fields(self, open_request):
        body = b'cookie: abc123 authorization=Bearer secret-token'
        open_request.side_effect = http_error(500, body)

        with self.assertRaises(MSSPRequestError) as raised:
            request("sid=old", "POST", "http://mssp.internal/gateway/query")

        error = str(raised.exception)
        self.assertNotIn("abc123", error)
        self.assertNotIn("secret-token", error)
        self.assertIn("[REDACTED]", error)

    @patch("shared.http._open")
    def test_definite_auth_failure_requires_a_changed_session(self, open_request):
        open_request.side_effect = http_error(401, b"unauthorized")
        session = MSSPSession("sid=same", lambda: "sid=same")

        with self.assertRaisesRegex(MSSPRequestError, "HTTP 401") as raised:
            request(session, "POST", "http://mssp.internal/gateway/write")

        self.assertIn("unauthorized", str(raised.exception))
        self.assertEqual(open_request.call_count, 1)

    @patch("shared.http.endpoint", return_value="http://mssp.internal/gateway/query")
    @patch("shared.http.request")
    def test_business_auth_failure_refreshes_and_retries(self, request_call, _endpoint):
        request_call.side_effect = [
            JSONResponse({"code": "9348", "msg": "authentication rejected"}),
            JSONResponse({"code": 0, "data": {"ok": True}}),
        ]
        session = MSSPSession("sid=old", lambda: "sid=new")

        result = request_json(session, "POST", "query", {})

        self.assertEqual(result["data"], {"ok": True})
        self.assertEqual(session.cookie, "sid=new")
        self.assertEqual(request_call.call_count, 2)

    @patch("shared.http.endpoint", return_value="http://mssp.internal/gateway/query")
    @patch("shared.http.request")
    def test_business_code_500_returns_system_message_without_refresh(self, request_call, _endpoint):
        request_call.return_value = JSONResponse({"code": 500, "msg": "upstream failed"})
        loader = MagicMock(return_value="sid=new")
        session = MSSPSession("sid=old", loader)

        with self.assertRaises(MSSPRequestError) as raised:
            request_json(session, "POST", "query", {})

        self.assertIn("业务码: 500", str(raised.exception))
        self.assertIn("upstream failed", str(raised.exception))
        loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
