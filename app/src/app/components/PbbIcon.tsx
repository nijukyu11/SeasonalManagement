type PbbIconProps = {
  className?: string;
};

export default function PbbIcon({ className = 'h-5 w-5' }: PbbIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <title>Passenger boarding bridge</title>
      <path d="M3.5 6.5h5v11h-5z" />
      <path d="M8.5 10h6.5l3 3.2" />
      <path d="M8.5 14h6.5l3-3.2" />
      <path d="M15 10v4" />
      <path d="M18 9.5h2.5v5H18z" />
      <path d="M20.5 10.5l1.5 1" />
      <path d="M20.5 13.5l1.5-1" />
      <path d="M5 17.5v2" />
      <path d="M7 17.5v2" />
      <path d="M13 14v3.5" />
    </svg>
  );
}
