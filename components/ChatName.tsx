import { chatTitle, projectLabel } from "@/lib/chat-title";

/** "Ecvision: Fix the pricing band", the project half a step quieter (§5h). Inline, so it sits inside
 *  whatever `truncate` span the caller already has — the title is what gets cut, never the project. */
export default function ChatName({ project, title }: { project: string; title: string }) {
  const label = projectLabel(project);
  if (!label || chatTitle(project, title) === title) return <>{title}</>;
  return <><span className="font-normal opacity-60">{label}:</span> {title}</>;
}
