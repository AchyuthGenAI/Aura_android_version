---
name: Weather
description: Answer questions about current conditions and forecasts.
---

# Weather

Use this skill when the user asks about the weather, temperature, forecast,
or outdoor conditions. Aura's built-in agent loop can fulfil most weather
requests by navigating to a public forecast page and reading the structured
information (e.g. weather.com, forecast.weather.gov). When the request is
purely informational, answer directly from the language model rather than
opening a browser tab.

## When to use

- "What's the weather in Seattle today?"
- "Will it rain tomorrow in my location?"
- "Hourly forecast for this evening"

## Hints for the agent

- Prefer the user's saved profile city if no city is mentioned.
- Avoid navigating away from the current page if the user is in the middle of
  another task; respond in chat instead.
