# Product

## Register

product

## Users

Kairos IPC serves builders who coordinate work across humans, local agents, app endpoints, plugins, and approval-gated tools. The primary user is a developer or operator who lives in a Slack-like collaboration surface while inspecting what an agent did, what it wants to do next, and which actor owns each step.

Users are usually in an active work session: reading channel history, asking an agent to act, approving or rejecting risky tool calls, and checking trace evidence when something behaves unexpectedly. They need fast scanning, durable trust, and low-friction handoff between conversation, execution, and debugging.

## Product Purpose

Kairos IPC is a message substrate for addressable actors. The Slock web surface turns that substrate into a human-operable collaboration room: channels, direct messages, agent replies, tool activity, approvals, and trace views share one coherent interface.

Success means a user can understand who said or did what, why an action is blocked, what approval is being requested, and how a message moved through the system without needing to mentally reconstruct the protocol. The interface should make agent work observable and steerable without making the user feel they are inside an agent demo.

## Brand Personality

Calm, legible, capable.

The product should feel like a serious workbench for shared agency: quiet enough for all-day use, precise enough for debugging, and warm enough that collaboration with agents feels natural rather than theatrical. The voice is direct, compact, and concrete. It names actors, actions, risk, and state plainly.

## Anti-references

- Do not become a Slack clone whose identity depends on a purple sidebar.
- Avoid AI-command-center aesthetics: black-purple neon, glowing gradients, sci-fi dashboards, and performative agent spectacle.
- Avoid generic SaaS marketing polish inside the app surface: hero metrics, decorative card grids, glass panels, and oversized empty-state copy.
- Avoid hiding risk behind friendly copy. Approval and execution boundaries must be explicit.
- Avoid a default dark theme unless the specific surface is designed for late-night incident review or dense trace inspection.

## Design Principles

1. Messages are the primary object. Layout, spacing, and color should make conversation history effortless to scan before anything else competes for attention.
2. Show agency boundaries. Human, agent, plugin, app, system, and shell activity must be visually distinguishable without turning the channel into a noisy diagram.
3. Approval earns attention. Riskful actions should interrupt the flow just enough to support confident decisions, then recede after resolution.
4. Traceability over spectacle. The system is interesting because it is inspectable, not because it looks futuristic.
5. Dense but humane. The UI should support repeated daily use with compact controls, predictable navigation, readable text, and clear focus states.

## Accessibility & Inclusion

Target WCAG 2.2 AA for contrast, keyboard access, visible focus, and non-color-only state communication. Message text should default to 15px with comfortable line height. Motion should be short, state-driven, and compatible with reduced-motion preferences. Status, risk, and actor type must use labels or icons in addition to color.
