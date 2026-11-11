export type WorkspaceIconProps = {
  /** Two letters shown on the folder, e.g. a language code. */
  label: string
  /** The size for a button. Its letters are larger for the folder, so they stay legible. */
  small?: boolean
}

/** The workspace folder mark with a short label. Its colours are the brand asset's own. */
export const WorkspaceIcon = ({ label, small }: WorkspaceIconProps) => (
  <svg width={small ? 22 : 32} height={small ? 20.625 : 30} viewBox="0 0 32 30" fill="none" aria-hidden="true" className="shrink-0">
    <path
      d="M0 6.33379C0 2.83573 2.83574 -1.49864e-06 6.3338 -1.49864e-06H6.60964C7.76897 -1.49864e-06 8.89848 0.367299 9.83607 1.04918C10.7737 1.73106 11.9032 2.09836 13.0625 2.09836H24C28.4183 2.09836 32 5.68008 32 10.0984V21.2834C32 25.7017 28.4183 29.2834 24 29.2834H8C3.58172 29.2834 0 25.7017 0 21.2834V6.33379Z"
      fill="black"
    />
    <path
      d="M0 14.4826C0 10.0643 3.58172 6.48259 8 6.48259H24C28.4183 6.48259 32 10.0643 32 14.4826V21.3119C32 25.7302 28.4183 29.3119 24 29.3119H8C3.58172 29.3119 0 25.7302 0 21.3119V14.4826Z"
      fill="white"
      fillOpacity="0.16"
    />
    <text x="16" y={small ? 21.58 : 20.67} textAnchor="middle" fontSize={small ? 12 : 9.5} fontWeight="600" fill="white">
      {label}
    </text>
  </svg>
)
