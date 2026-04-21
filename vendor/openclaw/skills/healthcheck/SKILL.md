---
name: Healthcheck
description: Verify that Aura's runtime, browser, and gateway surfaces are online.
---

# Healthcheck

Use this skill when the user wants to test that Aura Desktop is working
end-to-end. It reports the status of the main window, the browser controller,
the OpenClaw gateway connection, and the LLM provider chain.

## When to use

- "Run a healthcheck"
- "Is Aura connected?"
- "Diagnose why automation isn't working"

## Hints for the agent

- Check in this order: runtime status → gateway connection → browser tab count
  → recent LLM round-trip latency. Stop at the first failure and surface the
  specific component that failed.
- Never expose API keys or tokens in the report — just whether they are set.
