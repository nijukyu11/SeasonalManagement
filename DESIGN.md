---
name: Aviation Command
colors:
  surface: '#f9f9fd'
  surface-dim: '#dad9de'
  surface-bright: '#f9f9fd'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f4f3f8'
  surface-container: '#eeedf2'
  surface-container-high: '#e8e8ec'
  surface-container-highest: '#e2e2e7'
  on-surface: '#1a1c1f'
  on-surface-variant: '#43474f'
  inverse-surface: '#2f3034'
  inverse-on-surface: '#f1f0f5'
  outline: '#737780'
  outline-variant: '#c3c6d0'
  surface-tint: '#3b6090'
  primary: '#0e3b69'
  on-primary: '#ffffff'
  primary-container: '#2c5282'
  on-primary-container: '#a2c6fd'
  inverse-primary: '#a5c8ff'
  secondary: '#545f72'
  on-secondary: '#ffffff'
  secondary-container: '#d5e0f7'
  on-secondary-container: '#586377'
  tertiary: '#4f3500'
  on-tertiary: '#ffffff'
  tertiary-container: '#6d4a00'
  on-tertiary-container: '#edbc6c'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d4e3ff'
  primary-fixed-dim: '#a5c8ff'
  on-primary-fixed: '#001c3a'
  on-primary-fixed-variant: '#204877'
  secondary-fixed: '#d8e3fa'
  secondary-fixed-dim: '#bcc7dd'
  on-secondary-fixed: '#111c2c'
  on-secondary-fixed-variant: '#3c475a'
  tertiary-fixed: '#ffdead'
  tertiary-fixed-dim: '#f0be6e'
  on-tertiary-fixed: '#281900'
  on-tertiary-fixed-variant: '#604100'
  background: '#f9f9fd'
  on-background: '#1a1c1f'
  surface-variant: '#e2e2e7'
typography:
  h1:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '700'
    lineHeight: 38px
    letterSpacing: -0.02em
  h2:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  h3:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-base:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  data-tabular:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  container-margin: 24px
---

## Brand & Style
The design system is engineered for precision, reliability, and clarity—core tenets of aviation operations. The target audience includes flight dispatchers, schedule managers, and logistics coordinators who require high information density without cognitive overload.

The visual style is **Corporate / Modern**, emphasizing a systematic approach to data visualization. It prioritizes functional utility over decorative flair, using a structured hierarchy to ensure that critical flight status updates and scheduling conflicts are immediately identifiable. The emotional response is one of controlled efficiency, stability, and professional authority.

## Colors
The palette is rooted in "Aviation Blue," a deep, authoritative tone used for primary actions and navigation. "Steel Gray" provides a neutral secondary layer for supporting information and UI iconography. 

The background uses a light gray-blue tint to reduce eye strain during long shifts while maintaining a crisp, professional environment. Status colors (Green, Orange, Red) are calibrated for high legibility against the light background to signal flight readiness, delays, or groundings. Borders use a subtle cool-gray to define table structures without creating visual clutter.

## Typography
This design system utilizes **Inter** for its exceptional readability in data-heavy contexts. The type scale is optimized for information density, featuring a dedicated `data-tabular` style that employs tabular numphs to ensure flight numbers, times, and coordinates align perfectly in vertical columns.

Headlines are bold and slightly condensed in tracking to maintain a modern, technical feel. Labels use an uppercase treatment for secondary metadata to distinguish them clearly from editable data fields.

## Layout & Spacing
The design system employs a **Fluid Grid** model with a 12-column structure for dashboard layouts. A rigorous 4px baseline shift ensures consistent vertical rhythm across dense data tables and scheduling calendars.

- **Margins:** 24px for global page containers to provide breathable edges.
- **Gutters:** 16px between grid columns and dashboard widgets.
- **Density:** Tight spacing (sm/md) within table rows and flight cards to maximize the visibility of the daily schedule.

## Elevation & Depth
Depth is conveyed through **Tonal Layers** and **Ambient Shadows**. The interface remains largely flat to emphasize its technical nature, but uses elevation to distinguish between the background and interactive panels.

- **Level 0 (Background):** The Light Gray/Blue base surface.
- **Level 1 (Cards/Tables):** White surfaces with a 1px solid border (#e2e8f0).
- **Level 2 (Active States/Modals):** Subtle, diffused shadows (0px 4px 12px rgba(44, 82, 130, 0.08)) to indicate focus or floating elements like flight detail popovers.
- **Interactions:** Hover states on calendar cells use a soft blue tint rather than shadow to maintain the "flat" professional aesthetic of aviation software.

## Shapes
The design system uses a **Soft** (Level 1) roundedness approach. This 0.25rem (4px) base radius provides a modern touch while maintaining the structured, geometric rigor required for professional software.

- **Standard Elements:** 4px radius for buttons, input fields, and table corners.
- **Large Containers:** 8px (rounded-lg) for dashboard widgets and primary panels.
- **Status Tags:** 12px (rounded-xl) for pill-shaped status indicators to differentiate them from functional UI components.

## Components
- **Buttons:** Primary buttons use the Aviation Blue fill with white text. Secondary buttons use a Steel Gray outline. Ghost buttons are reserved for utility actions like "Clear Filters."
- **Flight Data Tables:** Rows must feature clear 1px bottom borders. High-intensity rows (e.g., delayed flights) utilize a 4px left-accent border in the corresponding status color.
- **Calendar Cells:** Interactive cells for flight slots use a "hollow" state when empty (dashed border) and a solid Aviation Blue state when a flight is assigned.
- **Input Fields:** Use a white background with a subtle border; on focus, the border shifts to Aviation Blue with a soft 2px outer glow.
- **Aviation Icons:** Use 20px stroked icons. Key icons include `plane-takeoff`, `plane-landing`, `calendar-range`, and `upload-cloud` for flight manifest imports.
- **Status Chips:** Small, semi-transparent background chips with high-contrast text for "In-Air," "Scheduled," "Delayed," and "Cancelled."