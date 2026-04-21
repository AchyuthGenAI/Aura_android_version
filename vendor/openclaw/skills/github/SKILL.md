---
name: GitHub
description: Browse GitHub repositories, issues, and pull requests.
---

# GitHub

Use this skill when the user wants to work with GitHub repositories, issues,
pull requests, releases, or search results. Aura navigates `github.com` and
can read/interact with the DOM on behalf of the user.

## When to use

- "Open the latest release of facebook/react"
- "Find the open issues labelled 'bug' in my repo"
- "Summarize this pull request"
- "Star this repository"

## Hints for the agent

- Use `github.com/search` with the appropriate query parameters for list views.
- When summarizing a PR, read both the description and the first 20 review
  comments. Ignore bot-generated CI status comments.
- Respect the user's login session — never ask them to re-authenticate.
