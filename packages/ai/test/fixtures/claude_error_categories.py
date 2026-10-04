"""Exercise the real lunR worker with fake modules and no native process or account."""
import importlib.util
import io
import json
import sys
import types
from contextlib import redirect_stdout
from unittest.mock import patch

failure = None


class FakeClient:
    def __init__(self, **kwargs):
        pass

    def create(self, **kwargs):
        raise failure

    def close(self):
        pass


sys.modules['directsdk'] = types.SimpleNamespace(Client=FakeClient)
sys.modules['directsdk_setup'] = types.SimpleNamespace(
    _resolve=lambda *args: ['fake-claude'], _child_env=lambda env: env)
spec = importlib.util.spec_from_file_location('lunr_bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
cases = [
    (RuntimeError('Native API error: prompt is too long PRIVATE_FAKE_TOKEN'), 'context_overflow'),
    (RuntimeError('Incomplete upstream response (first upstream attempt: status 413, capture complete): request_too_large PRIVATE'), 'context_overflow'),
    (TimeoutError('PRIVATE_FAKE_TOKEN'), 'timeout'),
    (RuntimeError('Native API error: rate_limit_error 429 PRIVATE'), 'rate_limit'),
    (RuntimeError('Native API error: overloaded_error 529 PRIVATE'), 'overloaded'),
    (RuntimeError('Incomplete upstream response (first upstream attempt: status 503, capture incomplete) PRIVATE'), 'transient'),
    (RuntimeError('Incomplete upstream response (first upstream attempt: status 200, capture incomplete) PRIVATE'), 'incomplete'),
    (RuntimeError('Incomplete native response: assistant, message_stop and one result required PRIVATE'), 'incomplete'),
    (RuntimeError('Native API error: authentication_error PRIVATE'), 'setup'),
    (ValueError('prompt is too long PRIVATE'), 'setup'),
]
results = []
for failure, expected in cases:
    start = dict(v=1, type='start', requestId='fake-request', command='fake-claude',
                 env={}, messages=[], tools=[], model='fake-model')
    stdin = types.SimpleNamespace(buffer=io.BytesIO((json.dumps(start) + '\n').encode()))
    output = io.StringIO()
    with patch.object(sys, 'stdin', stdin), patch.object(bridge.subprocess, 'run',
          return_value=types.SimpleNamespace(stdout='2.1.263')), redirect_stdout(output):
        assert bridge.main() == 1
    records = [json.loads(line) for line in output.getvalue().splitlines()]
    error = records[-1]
    assert error['type'] == 'error' and error['category'] == expected, error
    assert 'message' not in error and 'PRIVATE' not in output.getvalue()
    results.append(error['category'])
print(json.dumps(results))
