# Vision

> A personal AI that lives in your home, knows you deeply over time, and makes your environment respond to you — not just a smart speaker, but a brain.

## The core idea

Most smart home devices are stateless command routers. They respond to commands but don't know you. Every interaction starts from zero. Gooni is different: it builds a persistent model of who you are — your preferences, routines, goals, habits — and that model deepens over time.

The moat isn't device control. Anyone can turn a light on. The moat is *knowing when to* without being asked.

## The interfaces

Gooni is one brain, multiple access points:

- **CLI** — development and testing (current)
- **Voice** — hands-free, in-room, feels like Jarvis
- **Telegram** — on your phone, in the real world, away from home
- **Physical device** — a Raspberry Pi with a mic and speaker, always on, wake-word activated

## The home integration

Rather than building device integrations from scratch, [Home Assistant](https://www.home-assistant.io/) acts as the device layer. It already speaks to thousands of devices (Hue, Nest, Matter, Z-Wave, etc.). Gooni is the reasoning layer on top — Home Assistant handles the plumbing.

## What makes it intelligent

- **Memory** — it remembers what you told it a month ago
- **Context** — it knows the time, your patterns, whether you're home
- **Reasoning** — "make it cozy" becomes dim lights + warm temperature + soft music, learned from how you've set things before
- **Proactivity** — it initiates. "You usually wind down around now, want me to dim the lights?"

## What this is not

- A replacement for Home Assistant (it uses it)
- A general-purpose AI product (it's personal, built for one household)
- Finished (it's being built)
