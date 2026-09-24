"""Explicit setup probes. Never imported during normal model requests."""
import json
import sys
import subprocess
import hashlib
import os
from directsdk_setup import setup_status, discover_models, _resolve, _child_env


def main():
    if len(sys.argv) == 3 and sys.argv[1] == 'auth-login':
        try:
            resolved = _resolve([sys.argv[2]], dict(os.environ))
            if resolved is None:
                return 1
            return subprocess.run(resolved + ['auth', 'login'], timeout=300, check=False).returncode
        except (OSError, subprocess.SubprocessError):
            return 1
    try:
        request = json.loads(sys.stdin.readline(65537))
        if request.get('v') != 1 or request.get('type') not in ('status', 'discover', 'version') or not isinstance(request.get('command'), str):
            return 2
        command = [request['command']]
        env = request['env']
        if request['type'] == 'version':
            resolved = _resolve(command, env)
            if resolved is None:
                return 1
            result = subprocess.run(resolved + ['--version'], env=_child_env(env), stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=20, check=True).stdout.strip()
        elif request['type'] == 'status':
            result = setup_status(command=command, env=env)
            if result['logged_in']:
                auth = subprocess.run(_resolve(command, env) + ['auth', 'status'], env=_child_env(env),
                                      stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20, check=True)
                account = json.loads(auth.stdout)
                email = account.get('email', '')
                if isinstance(email, str) and email:
                    result['accountFingerprint'] = hashlib.sha256(email.strip().lower().encode()).hexdigest()
        else:
            result = discover_models(command=command, env=env)
        sys.stdout.write(json.dumps({'v': 1, 'requestId': request['requestId'], 'type': 'result', 'result': result}) + '\n')
        return 0
    except Exception:
        return 1


if __name__ == '__main__':
    sys.exit(main())
