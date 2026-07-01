/** Orkestr mark — a single confident conductor's arc / baton upbeat in the rose accent. Decorative. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 35 C 14 14, 30 12, 41 21" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="41" cy="21" r="3" fill="var(--accent)" />
    </svg>
  )
}
