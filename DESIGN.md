---
name: Profound Clarity
colors:
  surface: '#f7f9fb'
  surface-dim: '#d8dadc'
  surface-bright: '#f7f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f6'
  surface-container: '#eceef0'
  surface-container-high: '#e6e8ea'
  surface-container-highest: '#e0e3e5'
  on-surface: '#191c1e'
  on-surface-variant: '#45464d'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f3'
  outline: '#76777d'
  outline-variant: '#c6c6cd'
  surface-tint: '#565e74'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#131b2e'
  on-primary-container: '#7c839b'
  inverse-primary: '#bec6e0'
  secondary: '#006c49'
  on-secondary: '#ffffff'
  secondary-container: '#6cf8bb'
  on-secondary-container: '#00714d'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#0d1c2f'
  on-tertiary-container: '#76859b'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dae2fd'
  primary-fixed-dim: '#bec6e0'
  on-primary-fixed: '#131b2e'
  on-primary-fixed-variant: '#3f465c'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#d5e3fd'
  tertiary-fixed-dim: '#b9c7e0'
  on-tertiary-fixed: '#0d1c2f'
  on-tertiary-fixed-variant: '#3a485c'
  background: '#f7f9fb'
  on-background: '#191c1e'
  surface-variant: '#e0e3e5'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  container-max: 1200px
  gutter: 24px
  margin-mobile: 16px
  stack-sm: 12px
  stack-md: 24px
  stack-lg: 48px
---

## Brand & Style
The design system is engineered for high-trust professional environments, specifically tailored for a contact interface that balances accessibility with corporate authority. The personality is reliable, straightforward, and efficient.

The visual direction follows a **Corporate / Modern** aesthetic, utilizing a "Soft Precision" approach. This combines the structured logic of enterprise software with the approachability of modern SaaS. Expect high-contrast typography, generous whitespace to reduce cognitive load, and subtle depth through soft shadows that guide the user's focus toward interactive form elements.

## Colors
The palette is rooted in a "Deep Sea" spectrum to evoke stability and intelligence.

- **Primary (Deep Blue):** `#0F172A`. Used for critical actions, headings, and core brand identifiers. It provides the strongest visual weight.
- **Secondary (Emerald Green):** `#10B981`. Reserved for success states, active indicators, and subtle accents to draw attention without causing alarm.
- **Tertiary (Dark Gray):** `#334155`. Used for sub-text, secondary icons, and borders to maintain hierarchy without the harshness of pure black.
- **Neutral (Light Gray/White):** `#F8FAFC` for page backgrounds and `#FFFFFF` for card surfaces to create a tiered "elevation through color" effect.
- **Error Handling:** Use Tertiary colors with increased weight or specific iconography for errors; do not use red.

## Typography
This design system utilizes **Inter** for its exceptional legibility and neutral, systematic character. 

- **Scale:** High contrast between headlines and body text is essential for clear information architecture.
- **Headlines:** Use tighter letter-spacing for large displays to maintain visual density.
- **Labels:** Form labels use a semi-bold weight (`600`) to ensure they remain legible even when placed near high-contrast input fields.
- **Readability:** Maintain a maximum line length of 65-75 characters for body descriptions to ensure an optimal reading experience on the contact landing page.

## Layout & Spacing
The layout follows a **Fixed Grid** philosophy for desktop to maintain a professional, centered focus, transitioning to a fluid model for mobile devices.

- **Grid:** A 12-column grid is used for desktop. Contact forms should ideally occupy a 6-8 column central span or be paired with a 4-column sidebar containing contact metadata.
- **Rhythm:** Use an 8px base unit. Vertical spacing between form groups should be `stack-md` (24px) to create clear separation of concerns.
- **Mobile:** Margins reduce to 16px. Form fields expand to full-width (12 columns) to maximize the touch target area.

## Elevation & Depth
Depth is signaled through a combination of **Tonal Layering** and **Ambient Shadows**.

- **Surface Layering:** The primary background is the lightest neutral. The contact form itself sits on a pure white (#FFFFFF) card to differentiate the "task area" from the "information area."
- **Shadows:** Use a single, extra-diffused shadow style for the main contact card: `0px 10px 25px -5px rgba(15, 23, 42, 0.08)`. This soft, blue-tinted shadow provides a subtle lift without appearing heavy or dated.
- **Interactive Depth:** On hover, buttons should not increase shadow depth but rather shift in color intensity.

## Shapes
The design system employs a consistent **12px (0.75rem)** corner radius for all major UI components (cards, input fields, and buttons). 

- **Inputs & Buttons:** Both share the same 12px radius to create a unified visual language within the form.
- **Small Elements:** Checkboxes and smaller chips use a 4px radius to maintain a cohesive "soft-corner" look at a smaller scale.
- **Enclosure:** The main contact card or container should use `rounded-xl` (24px) if it serves as a primary page wrapper, further emphasizing the modern, approachable feel.

## Components
Consistent implementation of these components ensures the contact page feels professional and high-end.

- **Input Fields:** Use an outlined style. The border should be `#E2E8F0` (light gray) in default state, shifting to `#0F172A` (Deep Blue) with a 2px stroke on focus. Background should be a very soft fill of `#F8FAFC`.
- **Primary Button:** Solid `#0F172A` background with `#FFFFFF` text. Use the `label-md` typography style, centered, with 16px vertical padding.
- **Labels:** Positioned strictly above the input field using `label-md` in `#334155`.
- **Success Toast:** Utilize the secondary Emerald Green (`#10B981`) for the background or a prominent border to signal a successful message transmission.
- **Cards:** The main form container uses a white background, 12px-24px rounded corners, and the defined ambient shadow.
- **Icons:** Use linear, 2px stroke weight icons in the Tertiary color to represent contact methods (email, phone, location).