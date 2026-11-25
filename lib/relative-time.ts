/** "just now", "12m ago", "3h ago", "2d ago"; "never" when there is no time to measure from. */
export function formatRelativeTime(dateString?: string | null): string {
  if (!dateString) return "never";
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
