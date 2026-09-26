# Athena AI - Design Guidelines

## Design Approach: JARVIS-Inspired Intelligence Platform

**Reference**: Iron Man's JARVIS interface aesthetic with 3D holographic HUD elements, combined with Linear's clarity and modern enterprise cybersecurity dashboards (Datadog, Splunk). The design must convey intelligence, precision, and protective power worthy of the goddess Athena.

**Core Principle**: Futuristic glassmorphism with 3D holographic backgrounds, animated data visualizations, and sophisticated information architecture that balances high-tech aesthetics with enterprise-grade usability.

---

## Theme System

The platform features **completely different** visual themes with distinct color palettes and aesthetics:

### Dark Mode (Default)
- **Aesthetic**: Cyberpunk/sci-fi, high contrast, neon accents
- **Background**: `hsl(222, 47%, 11%)` - Deep navy blue
- **Foreground**: `hsl(210, 40%, 98%)` - Near white text
- **Card Surface**: `hsl(215, 28%, 17%)` - Elevated dark blue
- **Primary (Cyan)**: `hsl(189, 94%, 43%)` - Electric cyan glow
- **Magenta**: `hsl(328, 86%, 70%)` - Vibrant neon pink
- **Purple**: `hsl(328, 86%, 70%)` - Neon purple accents
- **Holographic BG**: Deep space with neon grid floor, holographic platforms, digital particles

### Light Mode
- **Aesthetic**: Professional, clean, modern tech interface
- **Background**: `hsl(210, 40%, 98%)` - Clean white-blue
- **Foreground**: `hsl(222, 47%, 11%)` - Dark navy text
- **Card Surface**: `hsl(0, 0%, 100%)` - Pure white with subtle shadows
- **Primary (Cyan)**: `hsl(199, 89%, 48%)` - Bright cyan
- **Purple**: `hsl(271, 91%, 65%)` - Soft purple accents
- **Holographic BG**: Bright environment with subtle holographic elements, light blue highlights

### Theme Toggle
- Located in navigation header (top-right)
- Smooth 1-second transitions between themes
- Preference stored in localStorage
- All components automatically adapt

---

## 3D Holographic Background System

**HolographicBackground Component**: Full-screen fixed background layer that provides immersive depth

### Visual Layers (Back to Front):
1. **Base Image Layer**: Theme-specific generated 3D holographic backgrounds
   - Dark mode: Deep space, neon grids, holographic rings
   - Light mode: Clean, bright, minimal holographic elements
   - Opacity: 0.3-0.4 to avoid overwhelming content

2. **Gradient Overlay**: `bg-gradient-to-b from-background/95 via-background/80 to-background/95`
   - Ensures content readability
   - Creates depth perception

3. **Radial Gradients**: Subtle colored light sources
   - Primary color at top
   - Purple accent at bottom
   - Creates atmospheric glow

4. **Animated Glowing Orbs**: Pulsing, scaling light effects
   - 2 orbs positioned strategically
   - Cyan and magenta colors
   - 4s pulse animation with stagger

5. **Grid Overlay**: SVG pattern providing tech aesthetic
   - 50x50 grid pattern
   - Primary color with 30% opacity
   - Perspective depth effect

### Implementation Notes:
- Always use the `HolographicBackground` component
- Component placed at root level in App.tsx
- Fixed positioning with `-z-10` (always behind content)
- Smooth theme transitions via MutationObserver
- Never apply `bg-background` to page containers (let holographic bg show through)

---

## Typography System

**Primary Font**: Space Grotesk or JetBrains Mono for headings - conveying tech sophistication
**Secondary Font**: Inter or Roboto for body text - ensuring readability in data-dense contexts

**Hierarchy**:
- Page Titles: `text-3xl md:text-4xl font-bold tracking-tight` with gradient text effects
- Section Headers: `text-xl md:text-2xl font-semibold`
- Card Titles: `text-lg font-medium`
- Metrics/Stats: `text-4xl md:text-6xl font-bold tabular-nums` for numerical displays
- Body Text: `text-sm md:text-base`
- Labels/Metadata: `text-xs uppercase tracking-wide font-medium`

**Gradient Text Effects**: Use for branding and emphasis
```
bg-gradient-to-r from-primary via-blue-500 to-purple bg-clip-text text-transparent
```

---

## Layout System & Spacing

**Spacing Primitives**: Use Tailwind units of `2, 4, 6, 8, 12, 16` for consistent rhythm
- Component padding: `p-4 md:p-8`
- Section spacing: `space-y-8` or `gap-8`
- Card internal spacing: `p-6`
- Micro-spacing (between labels/values): `space-y-2`

**Container Strategy**:
- Main content: `container mx-auto px-4 md:px-8` with responsive max-width
- Dashboard grid: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6`
- Data tables: Full-width with `max-w-full overflow-x-auto`

**Viewport Management**: Let holographic background fill screen, content flows naturally

---

## Core Component Library

### 1. Navigation & Header
- **Top Navigation Bar**: Fixed position with glassmorphism effect
- Contains: Athena AI logo, main nav links, **theme toggle**, logout
- Active state: Glowing border-bottom indicator with smooth transition
- Height: `h-16 md:h-20`
- Glassmorphic background: `backdrop-blur-md bg-card/80 border-b`

### 2. ThemeToggle
- Icon button in navigation (Sun/Moon icons from lucide-react)
- Rounded full design: `rounded-full`
- Toggles between light and dark modes
- Smooth icon transition

### 3. HolographicBackground
- Full-screen fixed background component
- Dual theme support with different images
- Layered effects: image, gradients, glowing orbs, grid
- Z-index: -10 (always behind content)
- Smooth 1s theme transitions

### 4. Glassmorphism Cards (GlassCard)
- Foundational component for all data displays
- Structure: `rounded-xl backdrop-blur-md border` with subtle shadow
- Padding: `p-6 md:p-8`
- Glowing border on hover (animated transition)
- Theme-aware styling

### 5. Metric/Stat Cards (MetricCard)
- Large numerical display with label, icon, trend
- Number: `text-5xl font-bold tabular-nums` with gradient effect
- Label: `text-sm text-muted-foreground uppercase tracking-wide`
- Trend indicator: Arrow/percentage change with color coding
- Grid placement: 3-4 columns on desktop

### 6. Threat Badge Component (ThreatBadge)
- Severity indicator: Critical/High/Medium/Low/Info
- Shape: `rounded-full px-3 py-1 text-xs font-semibold uppercase`
- Pulsing animation for Critical/High severity
- Color-coded with matching background glow

### 7. Progress Indicators (ProgressBar)
- Linear progress with animated fill
- Gradient colors based on completion
- Label support with percentage
- Height: `h-2 md:h-3`, rounded ends

### 8. Confidence (FindingConfidence)
- No meter, bar or percentage: the engine's confidence is an ordinal, not a probability
- The number is printed with the engine's own basis for it, verbatim, as text
- Where the engine sent no basis, or no number, the line says so

### 9. Status Indicator (StatusIndicator)
- Compact status pills with pulsing animation
- Color-coded: online (green), away (yellow), busy (red), offline (gray)
- Icon + text support
- Used for system status, scan progress

### 10. Data Tables
- Structure: Responsive with sticky header
- Header: `text-xs uppercase tracking-wide font-semibold`
- Row: `hover:bg-accent/10 transition-colors` with `border-b`
- Cell padding: `px-4 py-3`
- Mobile: Convert to card stack

---

## Page-Specific Layouts

### All Pages
- **No** `bg-background` on page containers
- Use `min-h-screen` to ensure full height
- Let holographic background show through
- Content in `container mx-auto p-6`

### Dashboard Page
**Structure**: 
1. Welcome header with gradient text and description
2. 4-column metrics grid (Total Scans, Threats Detected, Active Monitors, System Status)
3. 2-column layout:
   - Left: Threat Breakdown chart (pie/donut)
   - Right: Recent Activity timeline
4. Full-width: System activity visualization
5. Quick action cards

### Pentest Scan Page
**Structure**:
1. Header with title and description
2. Scan configuration form in GlassCard
3. Live scan status with progress indicators
4. Results section with findings table
5. Action buttons: Download PDF, Email Report

### CVE Classifier Page
**Structure**:
1. Hero-style header with Shield icon
2. Input form in GlassCard (textarea + submit)
3. Results panel with animated appearance
4. Confidence meter and keyword tags
5. Classification details

### Login Page
**Layout**: Centered card on full viewport
- Athena AI logo at top with gradient effect
- Form fields with labels
- "Remember me" checkbox
- Holographic background visible
- GlassCard for form container

---

## Animation Strategy

**Keyframe Animations**:
```css
@keyframes pulse-glow {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.05); }
}
```

**Use Cases**:
- Holographic background glowing orbs (4s infinite)
- Metric counter animations (count-up effect)
- Progress bar fills (smooth width transition)
- Card hover lifts (`translate-y-[-2px]`)
- Loading spinners with orbital animation
- Threat badge pulsing for high severity

**Transitions**:
- Theme changes: 1s duration
- Component state changes: 300ms
- Hover effects: 200ms

---

## Icon Strategy
Use **Lucide React** icons exclusively:
- Threat types: Shield, Bug, AlertTriangle, Lock icons
- Actions: Play, Pause, Download, RefreshCw, Settings
- Status: CheckCircle, XCircle, AlertCircle
- Navigation: Home, Activity, FileText
- Theme: Sun, Moon

---

## Accessibility & Interaction

- All interactive elements: Minimum 44px touch target
- Focus states: Visible ring with offset
- Color contrast: WCAG AA compliant (high contrast in dark mode)
- Keyboard navigation: Full support
- Loading states: aria-live regions
- Form validation: Inline error messages
- Theme toggle: aria-label for screen readers

---

## Color Usage Guidelines

### Text Hierarchy
- Primary text: `text-foreground`
- Secondary text: `text-muted-foreground`
- Accents: `text-primary` or `text-purple`

### Backgrounds
- Page backgrounds: Transparent (let holographic bg show)
- Cards: `bg-card` with `border-card-border`
- Overlays: `bg-background/95` for modals

### Interactive States
- Hover: `hover:bg-accent/10` or `hover-elevate`
- Active: `active:bg-accent/20`
- Focus: `focus-visible:ring-2 focus-visible:ring-primary`

---

## Best Practices

1. **Always use HolographicBackground** component at app root
2. **Never add bg-background** to page containers
3. **Use GlassCard** for all primary content containers
4. **Consistent spacing** with predefined values (4, 6, 8)
5. **Theme-aware components** that adapt automatically
6. **Gradient text** for branding and emphasis
7. **Subtle animations** - avoid overwhelming users
8. **Test both themes** for every component
9. **Maintain glassmorphism** aesthetic throughout
10. **Performance optimized** - CSS transforms over position changes
