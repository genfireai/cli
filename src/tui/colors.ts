/**
 * GenFire TUI color palette. One source of truth — never hardcode hex
 * codes inside components. Keeps the brand consistent across screens.
 */
export const palette = {
  brand: '#FF4500',         // Orange — logo, header brand label, fire indicator
  brandDeep: '#FF3300',     // Darker orange — for hovers / pressed states (future)
  accent: '#A78BFA',        // Purple — cursor, command prefix, links, interactive cues
  accentDeep: '#8B5CF6',    // Deeper purple — emphasized accents (future)
  success: '#10B981',       // Green — checkmarks, completed jobs
  warning: '#F59E0B',       // Amber — running jobs, "in flight"
  error: '#EF4444',         // Red — errors, failures, not-authenticated
  muted: 'gray',            // Tagged Ink color — taglines, dividers, hints
  text: 'white'             // Default log/output text
} as const;
