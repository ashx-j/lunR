# @earendil-works/pi-orchestrator

Experimental. This package is under active development and may change or be removed without notice. Its CLI, APIs, and behavior are not yet stable.

Orchestrator package for pi.

## CLI

```bash
orchestrator --help
```

## Shutdown

Owned RPC children get up to five seconds to exit after SIGTERM, then two seconds after SIGKILL. Disposal rejects if exit is still unconfirmed. Shutdown attempts every instance independently, and Radius failures never skip local child termination. Radius requests have a five-second deadline, including response bodies.

Failed cleanup retains an error record and any unresolved child handle or Radius registration for retry with `stopInstance()`. Records include a diagnostic PID while child exit remains unconfirmed. After supervisor restart, a saved PID remains diagnostic only and never authorizes termination of a process. Service shutdown still stops Radius and removes its socket after child cleanup failures, reports the failures, and exits with status 1.
