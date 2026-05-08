# Design System

## System Intent

Kairos IPC uses a restrained product UI system for a Slack-like collaboration surface where humans and agents work in the same room. The default scene is an all-day desktop work session in ordinary office light: reading messages, checking agent status, approving tool use, and inspecting traces. The interface should be light, quiet, and highly scannable.

This system intentionally moves away from the current Slack-purple inheritance. Use tinted neutrals, one teal accent, and semantic state colors only where state needs to be understood.

## Color Strategy

Use OKLCH-first tokens. The product default is restrained: tinted neutral surfaces plus one accent used for primary actions, selected navigation, focus rings, and active state. Accent should stay under roughly 10 percent of the visible surface on normal work screens.

Do not use pure black or pure white. Neutrals should keep a subtle blue-green tint so the surface feels coherent without becoming monochrome.

## Core Palette

| Token | Role | OKLCH | Hex |
| --- | --- | --- | --- |
| `canvas` | Main app background | `oklch(98% 0.006 190)` | `#f7faf9` |
| `surface` | Sidebar, toolbar, quiet panels | `oklch(95% 0.010 190)` | `#edf3f1` |
| `surface-strong` | Hover, selected rows, raised neutral areas | `oklch(91% 0.014 190)` | `#dde8e5` |
| `border` | Dividers, input borders, separators | `oklch(84% 0.018 190)` | `#c7d5d1` |
| `muted` | Timestamps, metadata, secondary labels | `oklch(53% 0.026 205)` | `#637476` |
| `text` | Default body and control text | `oklch(31% 0.018 210)` | `#334044` |
| `ink` | Strong headings, active icons, high-emphasis text | `oklch(20% 0.014 220)` | `#20292d` |
| `accent` | Primary action, current channel, focus, active state | `oklch(58% 0.115 178)` | `#087f78` |

## Semantic Colors

Semantic colors sit outside the eight core shades. Use them sparingly and pair them with labels or icons.

| Token | Role | OKLCH |
| --- | --- | --- |
| `success` | Completed tool calls, approved actions | `oklch(62% 0.120 150)` |
| `warning` | Pending approval, moderate risk, stale state | `oklch(72% 0.125 72)` |
| `danger` | Rejected approval, failed action, destructive risk | `oklch(58% 0.155 25)` |
| `info` | Trace hints, system notices, neutral updates | `oklch(60% 0.105 225)` |
| `agent-thinking` | Streaming or planning activity | `oklch(68% 0.105 92)` |

## Typography

Use one sans-serif family across the product. Prefer Inter for cross-platform consistency, with native system fonts as fallbacks.

```css
font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
```

Use a fixed rem/px scale. Do not use viewport-fluid type for product UI.

| Token | Size | Suggested line-height | Use |
| --- | ---: | ---: | --- |
| `text-2xs` | `11px` | `16px` | Timestamps, dense metadata, trace chips |
| `text-xs` | `12px` | `16px` | Badges, compact labels, secondary controls |
| `text-sm` | `13px` | `18px` | Sidebar channels, form labels, toolbar text |
| `text-base` | `14px` | `20px` | Default UI text, buttons, inputs |
| `text-message` | `15px` | `22px` | Chat message body and agent responses |
| `text-md` | `17px` | `24px` | Section headings, thread titles |
| `text-lg` | `21px` | `28px` | Page titles, workspace title |
| `text-xl` | `28px` | `36px` | Empty states, onboarding titles, rare moments |

Weights: use 400 for reading, 500 for controls and metadata emphasis, 600 for selected navigation and section headings, and 700 only for strong page or workspace titles.

## Layout

Use familiar product structure: sidebar, topbar, message timeline, composer, optional detail or trace panel. Density is allowed, but repeated rows need stable rhythm and clear hover/focus affordances.

- Sidebar width should stay stable across channels and DMs.
- Message rows should not jump when streaming deltas arrive.
- Approval blocks should be inline and prominent, not modal by default.
- Trace views can be denser than chat, but should still preserve actor, action, timestamp, and relation clarity.
- Cards are allowed for repeated items and framed tools. Do not nest cards.

## Components

Buttons, inputs, tabs, badges, approvals, tool-call rows, and message rows must define default, hover, focus, active, disabled, loading, and error states.

Use lucide icons for recognizable commands. Pair unfamiliar icons with tooltips or visible labels. Prefer standard controls over invented affordances.

## Motion

Motion should communicate state only: streaming, reveal, selection, approval resolution, or loading. Most transitions should be 150ms to 250ms with ease-out timing. Respect `prefers-reduced-motion`.

Avoid decorative page-load choreography, bouncing, elastic motion, and animated layout properties.

## Implementation Notes

The current Slock web CSS contains legacy Slack-like purple tokens and later dark/purple OKLCH variants. Future UI work should migrate toward the core palette above rather than extending those purple systems. Keep Tailwind/shadcn-vue compatibility by mapping these tokens into CSS custom properties first, then component classes.
