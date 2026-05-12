# Design

## Theme

OLED dark throughout the external-facing surfaces (landing, auth). The audience is using this at night, on phones, in clubs and on their way out. Light spill from a bright white screen is hostile. True dark (#090909) is the scene.

The authenticated app uses system-adaptive theming (dark/light toggle) — but dark is the default and the considered choice.

## Color Strategy

**Restrained on product surfaces.** Tinted neutral base + one accent (electric violet) capped at roughly 10% of total surface area on any given screen.

**Committed on brand/hero surfaces.** The hero section of the landing page is drenched in black with the violet accent making a statement on the headline word "Vib3."

### Palette

| Role | Token | Approximate hex | Notes |
|---|---|---|---|
| Background | `--background` dark | `oklch(14% 0.003 270)` / `#090909` | Near-true black, violet-tinted |
| Surface | `--card` dark | `oklch(18% 0.004 270)` / `#141414` | Cards, modals |
| Border | `--border` dark | `oklch(24% 0.005 270)` / `#242424` | Dividers, card borders |
| Text primary | `--foreground` dark | `oklch(97% 0.003 90)` / `#F7F7F7` | Slightly warm white |
| Text secondary | — | `oklch(60% 0 0)` / `#999999` | Muted labels, captions |
| Accent (single) | `--primary` | `oklch(50% 0.21 290)` / `#7C46D6` | Electric violet — all CTAs, active states |
| Accent bright | — | `oklch(63% 0.21 290)` / `#9B6FEF` | Hover states, highlights on dark |
| Amber (premium) | `--secondary` | `oklch(72% 0.18 65)` / `#F59E0B` | Featured/premium events only |

Light mode (authenticated app):
- Background: `oklch(97% 0.002 90)` — warm off-white
- Surface: `oklch(100% 0 0)` — clean white cards
- Primary: same violet, slightly deeper (`oklch(48% 0.21 290)`)

### What is never used

- Pink. No gradients mixing pink and purple.
- `#000000` pure black. Always tinted.
- `#ffffff` pure white. Always tinted warm.

## Typography

### Typefaces

| Role | Family | CSS variable |
|---|---|---|
| Display / headline | Bodoni Moda | `--font-serif` |
| UI / body | Jost | `--font-sans` |
| Code | Menlo | `--font-mono` |

Bodoni Moda is used **only** for display headings — brand name, hero text, section titles, CTA headline. Nothing smaller than 1.5rem uses Bodoni Moda.

Jost handles everything else: nav, buttons, form labels, body copy, badges, meta.

### Scale (approximate)

| Step | Size | Usage |
|---|---|---|
| Display XL | clamp(3.8rem, 13vw, 11.5rem) | Hero headline |
| Display L | clamp(2.8rem, 9vw, 8.5rem) | CTA section headline |
| Title XL | 4rem–5rem | Section titles (e.g. "Events") |
| Title L | 3rem–4rem | Page headings in auth |
| Body | 1rem (16px) | Default body text |
| Small | 0.875rem (14px) | Secondary text, metadata |
| Caption | 0.75rem (12px) | Labels, eyebrows |
| Micro | 0.65rem–0.7rem | Tracking-wide uppercase labels |

### Letter spacing

- Bodoni Moda headlines: `tracking-tight` / `-0.02em`
- Uppercase eyebrow labels: `tracking-[0.28em]` — creates editorial texture
- Body: default / 0

### Line height

- Display headings: `leading-[0.88]–0.9` — tight for editorial impact
- Body: `leading-relaxed` (1.625)
- Captions/labels: `leading-none` or `leading-tight`

## Elevation & Depth

Three layers only:

| Layer | Background | Use |
|---|---|---|
| Base | `#090909` | Page canvas |
| Raised | `#111111–#141414` | Cards, modals, popovers |
| Floating | `#1A1A1A` | Dropdowns, tooltips |

Borders at all levels: `rgba(255,255,255, 0.06–0.10)` — barely visible, just enough separation.

Shadows in dark mode: real depth with `hsl(0 0% 0% / 0.35–0.85)`.

## Motion

- Entry animations: `opacity 0→1` + `translateY 28px→0` with `duration 0.55–0.65s` ease-out-quart `[0.22, 1, 0.36, 1]`
- Stagger: `0.07–0.09s` between children
- Hover lifts: `translateY -3px` over `0.2s`
- No layout property animation (width, height, padding)
- `prefers-reduced-motion: reduce`: all durations collapse to `0.01ms`

## Components

### Buttons

- All CTA buttons: `rounded-full`, `h-11–h-14`, filled violet (`bg-violet-600`)
- Ghost/secondary: `bg-transparent`, `border-white/[0.15]`, `text-white/60`
- Never: gradient fills, pink, pill-shaped outline with gradient border

### Form inputs

Dark auth surfaces: `bg-white/[0.04]`, `border-white/[0.09]`, `rounded-xl`, `h-12`
Focus: `ring-1 ring-violet-500` — no `ring-2` (too aggressive)

### Cards/surfaces

- Rounded: `rounded-2xl` for cards, `rounded-3xl` for large callout panels
- Border: `border-white/[0.06–0.09]`
- Hover: border transitions to `border-violet-500/30`

### Badges / eyebrow labels

Uppercase, tracked wide, Jost, 0.6–0.65rem. No icon-only badges.

## Layout

- Max content width: `max-w-7xl` (80rem)
- Page padding: `px-6` on mobile, scales with viewport
- Section vertical rhythm: `py-24–py-36` — generous and varied
- No equal-padding monotony; sections breathe differently based on content weight

## Imagery

Event cards: always full-bleed images with a `gradient-to-t from-black/90` overlay. The image provides atmosphere; the overlay provides legibility.

Placeholder states (no image): `bg-gradient-to-br from-violet-900/25 to-[#0f0f0f]` — brand-consistent but not garish.
