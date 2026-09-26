"""Per-request JSON-lines bridge to the pinned, request-scoped native transport."""
import json
import sys
import threading
import subprocess
import re

from directsdk import Client
from directsdk_setup import _resolve, _child_env

MAX_RECORD = 64 * 1024 * 1024
_write_lock = threading.Lock()


def emit(request_id, kind, **fields):
    with _write_lock:
        sys.stdout.write(json.dumps({'v': 1, 'requestId': request_id, 'type': kind, **fields}, separators=(',', ':')) + '\n')
        sys.stdout.flush()


def main():
    line = sys.stdin.buffer.readline(MAX_RECORD + 1)
    if not line or len(line) > MAX_RECORD:
        return 2
    try:
        start = json.loads(line)
        if start.get('v') != 1 or start.get('type') != 'start' or not isinstance(start.get('requestId'), str):
            return 2
        request_id = start['requestId']
        command = start['command']
        if not isinstance(command, str) or not command or not isinstance(start.get('messages'), list):
            raise ValueError('Invalid bridge request')
        resolved = _resolve([command], start['env'])
        if resolved is None:
            raise ValueError('Missing Claude Code CLI')
        version = subprocess.run(resolved + ['--version'], env=_child_env(start['env']), stdin=subprocess.DEVNULL,
                                 capture_output=True, text=True, timeout=20, check=True).stdout.strip()
        if not re.match(r'^2\.1\.263(?:\s|$)', version):
            raise ValueError('Unqualified Claude Code version')
        client = Client(command=command, env=start['env'], timeout=start.get('timeout', 180),
                        on_spawn=lambda pid: emit(request_id, 'native_started', pid=pid),
                        on_replay=lambda: emit(request_id, 'replay_progress'))
    except Exception:
        return 2

    cancelled = threading.Event()

    def read_control():
        while True:
            control = sys.stdin.buffer.readline(MAX_RECORD + 1)
            if not control:
                return
            try:
                record = json.loads(control)
                if record == {'v': 1, 'requestId': request_id, 'type': 'cancel'}:
                    cancelled.set()
                    client.close()
                    return
            except (ValueError, UnicodeError):
                cancelled.set()
                client.close()
                return

    threading.Thread(target=read_control, daemon=True).start()
    emit(request_id, 'ready')
    try:
        with client.create(model=start['model'], messages=start['messages'], tools=start['tools'],
                           extra_body=start.get('extraBody', {}), stream=True) as stream:
            emit(request_id, 'start')
            for chunk in stream:
                delta = chunk.choices[0].delta
                if delta.content:
                    emit(request_id, 'text_delta', text=delta.content)
                if getattr(delta, 'reasoning_content', None):
                    emit(request_id, 'thinking_delta', text=delta.reasoning_content)
                if hasattr(chunk, '_response'):
                    response = chunk._response.model_dump()
                    emit(request_id, 'complete', response=response)
        return 0
    except Exception:
        emit(request_id, 'cancelled' if cancelled.is_set() else 'error',
             message='Claude Code request failed. Check subscription setup and native CLI compatibility.')
        return 1
    finally:
        client.close()


if __name__ == '__main__':
    sys.exit(main())
