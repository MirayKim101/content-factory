# Content Factory UX foundation

Status: implemented baseline for the private pre-Twitch administration UI
Date: 2026-09-25

## Goal

Make the production workflow easy to scan and safe to operate without changing
the Nuxt/PrimeVue/Tailwind architecture or the API boundary. The interface is an
operations workspace, so it follows mature CRM conventions rather than a
marketing-site layout.

## Adopted interaction model

1. Persistent navigation groups the application by operator task:
   production, assets, and settings.
2. Every workspace starts with location, purpose, primary action, and a compact
   operational summary.
3. Record cards show identity and status first, the next action second, and
   diagnostic tools behind progressive disclosure.
4. Status color is semantic and always accompanied by text.
5. Destructive or final actions stay close to the evidence they affect.
6. Technical lineage, costs, and processing metrics remain available but do not
   compete with the review task.
7. A package cannot be confirmed blindly when its video or thumbnail preview
   reports a loading failure.
8. Desktop layouts preserve useful density; mobile layouts reflow to one column
   with at least 44px interaction targets.

## Design tokens

Shared CSS custom properties in `apps/web/app/assets/css/main.css` own surface,
text, border, semantic color, radius, and elevation decisions. Product
components should use these tokens instead of introducing local hex colors.
PrimeVue remains unstyled and is normalized through shared selectors for
buttons, cards, inputs, selects, textareas, and checkboxes.

## Review workflow

The final review dialog is arranged as one visible sequence:

```text
content preview -> provenance/economics -> exact confirmation -> export
```

The current video, thumbnail, metadata, workflow mode, and exact revision are
visible without opening diagnostics. Provenance and processing details are
expandable. The confirmation panel is sticky inside the dialog and records the
existing foreground-attention metrics without changing their contract.

## External references

- [Salesforce Lightning Design System 2](https://www.lightningdesignsystem.com/2e1ef8501/p/8184ad):
  scanability, deliberate spacing, concise tiles, accessible focus, and
  semantic status patterns.
- [Microsoft Fluent 2](https://fluent2.microsoft.design/layout): four-pixel
  spacing rhythm, responsive grid, clear information hierarchy, focused
  experiences, and short descriptive badges.

These references guide interaction and hierarchy only. Content Factory keeps
its own visual identity and existing implementation stack.

## Rollback

The change is frontend-only except for the corrected private thumbnail content
URL. Reverting the UI component and token changes restores the former layout;
no persisted data migration is involved.
