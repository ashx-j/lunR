# Claude Subscription DirectSDK

MIT, copyright 2026 Nous Research and contributors. Full notice: [LICENSE](LICENSE).

Source: https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk at `f1c1220778c7864fe4c1494baf9b1566e7c95bd2`.

`admission.py`, `inert_mcp.py`, `model_catalog.py`, `directsdk_setup.py`, and upstream fixtures are unchanged. `directsdk.py` has one local patch, `patches/0001-lunr-lifecycle-hooks.patch`, to report the owned native PID for emergency cancellation and verified replay acknowledgments for the bridge idle deadline. `tools/schema_sanitizer.py` and `agent/reasoning_effort.py` supply only the two Hermes helper functions imported by the pinned transport. `lunr_bridge.py` and `lunr_setup_bridge.py` are lunR adapters, not upstream source. `manifest.json` records hashes of every copied upstream file and the local patch.

Only the transport, adapters, compatibility helpers, license, and this attribution ship with the npm package. Upstream registration glue and test fixtures remain in the repository for audit.
