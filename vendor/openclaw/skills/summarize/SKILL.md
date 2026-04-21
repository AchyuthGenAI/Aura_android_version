---
name: Summarize
description: Summarize the current page, a selection, or an arbitrary URL.
---

# Summarize

Use this skill when the user asks for a summary, TL;DR, gist, bullet points,
or condensed version of a piece of content. The agent can summarize:

- The active browser tab's visible text
- A user-selected range on the page
- A URL or document the user pastes into chat

## When to use

- "Summarize this article"
- "Give me a TL;DR of this page"
- "Extract the key takeaways from this release notes page"

## Hints for the agent

- Return 3–5 bullet points unless the user asks for a paragraph.
- Preserve technical terms and numbers as-is; never invent figures.
- When summarizing long pages, chunk by heading rather than naively truncating.
