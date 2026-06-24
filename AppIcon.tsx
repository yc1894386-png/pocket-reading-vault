import * as React from "react";

export type IconName = "bookmark" | "cloudSync" | "import" | "theme";

export type AppIconProps = {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
};

const icons: Record<IconName, React.ReactNode> = {
  bookmark: (
    <>
      <path d="M7.5 4.5H16.5C17.6046 4.5 18.5 5.39543 18.5 6.5V20L12 16.25L5.5 20V6.5C5.5 5.39543 6.39543 4.5 7.5 4.5Z" />
      <path d="M9 8.5H15M9 11.5H14" />
    </>
  ),

  cloudSync: (
    <>
      <path d="M7.2 17.5H6.8C4.7 17.5 3 15.86 3 13.82C3 11.96 4.45 10.4 6.32 10.18C6.95 7.45 9.27 5.5 12 5.5C15.05 5.5 17.57 7.83 17.88 10.82C19.65 11.22 21 12.7 21 14.48C21 16.6 19.2 18.3 17 18.3H16.6" />
      <path d="M14.8 13.2C14.2 12.3 13.2 11.75 12.1 11.75C10.95 11.75 9.95 12.35 9.4 13.25" />
      <path d="M9.35 13.25H7.8V11.7" />
      <path d="M9.2 15.8C9.8 16.7 10.8 17.25 11.9 17.25C13.05 17.25 14.05 16.65 14.6 15.75" />
      <path d="M14.65 15.75H16.2V17.3" />
    </>
  ),

  import: (
    <>
      <path d="M12 4.5V13.2" />
      <path d="M8.8 10.1L12 13.3L15.2 10.1" />
      <path d="M5.5 11.5V17.5C5.5 18.6046 6.39543 19.5 7.5 19.5H16.5C17.6046 19.5 18.5 18.6046 18.5 17.5V11.5" />
      <path d="M8 15.5H16" />
    </>
  ),

  theme: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path
        d="M12 5A7 7 0 0 1 12 19V5Z"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
};

export function AppIcon({
  name,
  size = 24,
  className,
  title,
}: AppIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}

      <g
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icons[name]}
      </g>
    </svg>
  );
}

/**
 * Usage:
 *
 * <AppIcon name="bookmark" />
 * <AppIcon name="cloudSync" />
 * <AppIcon name="import" />
 * <AppIcon name="theme" />
 *
 * CSS:
 *
 * .icon-light {
 *   color: #1d1d1f;
 * }
 *
 * .icon-dark {
 *   color: #f5f5f7;
 * }
 */
