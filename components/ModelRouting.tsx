import { MODELS, ROUTING_RULES } from "@/lib/routing";

export function ModelRouting() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-neutral-500">
        Spend the least, keep the output identical. Reserve the{" "}
        <span className="font-medium text-neutral-300">top tier</span>{" "}
        for judgement and push grunt work down to a cheaper model — the token-heavy part billed
        cheap, quality unchanged. Edit the table in <code className="text-[11px]">lib/routing.ts</code>.
      </p>

      <div className="flex flex-col gap-2">
        {ROUTING_RULES.map((r) => {
          const m = MODELS.find((x) => x.tier === r.tier)!;
          return (
            <div key={r.work} className="rounded-lg border border-white/10 p-2">
              <p className="text-xs text-neutral-300">{r.work}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: m.tint }} />
                <span className="text-xs font-medium">{r.tier}</span>
                <span className="text-[10px] text-neutral-400">· {r.why}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-lg border border-white/10">
        <table className="w-full text-left text-[11px]">
          <thead className="bg-white/5 text-neutral-500">
            <tr>
              <th className="px-2 py-1 font-medium">Model</th>
              <th className="px-2 py-1 text-right font-medium">In</th>
              <th className="px-2 py-1 text-right font-medium">Out</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {MODELS.map((m) => (
              <tr key={m.tier} className="border-t border-white/10">
                <td className="px-2 py-1">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: m.tint }} />
                  {m.tier}
                  <span className="ml-1 text-[10px] text-neutral-400">{m.note}</span>
                </td>
                <td className="px-2 py-1 text-right">${m.in}</td>
                <td className="px-2 py-1 text-right">${m.out}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-2 py-1 text-[10px] text-neutral-400">$ / million tokens · Claude API · verified 2026-07-24</p>
      </div>
    </div>
  );
}
