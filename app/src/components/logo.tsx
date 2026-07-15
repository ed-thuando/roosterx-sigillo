/** RoosterX Secrets wordmark. Shared between app shell and hero section. */
export function SigilloLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 360 48" className={className} xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="37"
        fontFamily="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
        fontSize="40"
        fontWeight="700"
        letterSpacing="-1"
        fill="currentColor"
      >
        RoosterX<tspan fontWeight="400" opacity="0.55"> Secrets</tspan>
      </text>
    </svg>
  )
}
