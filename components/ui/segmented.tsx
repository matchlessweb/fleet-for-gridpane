import { cn } from "@/lib/utils";

/** Ink-filled toggle group — active segment is foreground-on-background. */
export function Segmented({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      className={cn(
        "flex border border-line-strong rounded-md overflow-hidden bg-panel",
        className
      )}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "text-[11px] font-medium px-2.5 py-[5px] transition-colors duration-150",
              i > 0 && "border-l border-border",
              active
                ? "bg-foreground text-background font-semibold"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
